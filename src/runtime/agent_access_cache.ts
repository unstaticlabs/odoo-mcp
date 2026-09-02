import { createHash } from "node:crypto";
import { loadAgentIdentity, type AgentIdentity } from "../odoo/agent_identity.js";
import { OdooError, type OdooClient, type OdooSurface } from "../odoo/client.js";
import type { OdooPrincipal, RequestContext } from "./context.js";
import { emitEvent } from "./logging.js";

const REFRESH_INTERVAL_MINUTES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024] as const;
const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
const ACCESS_FAILURE_COOLDOWN_MS = 5_000;
const JITTER_RATIO = 0.1;

export interface AgentAccessSnapshot {
  identity: AgentIdentity;
  surface: OdooSurface | null;
  refreshedAt: number;
}

export interface AgentAccessState {
  available: boolean;
  snapshot?: AgentAccessSnapshot;
}

type RefreshReason = "initial" | "scheduled" | "active" | "access_denied";
type SnapshotListener = (state: AgentAccessState) => boolean | void;

interface CacheEntry {
  fingerprint: string;
  context: RequestContext;
  snapshot?: AgentAccessSnapshot;
  unavailable?: { message: string; policyCode?: string };
  inflight?: Promise<AgentAccessSnapshot>;
  timer?: ReturnType<typeof setTimeout>;
  nextIntervalIndex: number;
  lastAccessRefreshAt: number;
  listeners: Set<SnapshotListener>;
  abortController: AbortController;
}

export interface AgentAccessSnapshotCacheOptions {
  maximumEntries?: number;
  now?: () => number;
  random?: () => number;
}

export class AgentAccessUnavailableError extends Error {
  constructor(message: string, readonly policyCode?: string) {
    super(message);
    this.name = "AgentAccessUnavailableError";
  }
}

export function agentCredentialFingerprint(principal: OdooPrincipal): string {
  return createHash("sha256")
    .update("usl-odoo-mcp-agent-access-v1\0")
    .update(principal.targetId)
    .update("\0")
    .update(principal.database)
    .update("\0")
    .update(principal.apiKey)
    .digest("base64url");
}

function policyCode(error: unknown): string | undefined {
  return error instanceof OdooError ? error.policyCode : undefined;
}

function isAccessFailure(error: unknown): boolean {
  if (!(error instanceof OdooError)) return false;
  return error.httpStatus === 401
    || error.httpStatus === 403
    || Boolean(error.policyCode && error.policyCode.startsWith("agent_"));
}

function invalidatesIdentity(error: unknown): boolean {
  if (!(error instanceof OdooError)) return false;
  return error.httpStatus === 401
    || ["agent_suspended", "agent_principal_required", "agent_transport_denied"].includes(error.policyCode ?? "");
}

function safeFailure(error: unknown): { message: string; policyCode?: string } {
  return {
    message: error instanceof Error ? error.message.slice(0, 500) : "The governed Agent identity is unavailable",
    ...(policyCode(error) ? { policyCode: policyCode(error) } : {})
  };
}

export class AgentAccessSnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maximumEntries: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private closed = false;

  constructor(
    private readonly client: OdooClient,
    options: AgentAccessSnapshotCacheOptions = {}
  ) {
    this.maximumEntries = options.maximumEntries ?? 50;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  private entry(context: RequestContext): CacheEntry {
    const fingerprint = agentCredentialFingerprint(context.principal);
    let entry = this.entries.get(fingerprint);
    if (entry) {
      entry.context = context;
      this.entries.delete(fingerprint);
      this.entries.set(fingerprint, entry);
      return entry;
    }
    entry = {
      fingerprint,
      context,
      nextIntervalIndex: 0,
      lastAccessRefreshAt: 0,
      listeners: new Set(),
      abortController: new AbortController()
    };
    this.entries.set(fingerprint, entry);
    this.evictOverflow();
    return entry;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maximumEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const oldest = this.entries.get(oldestKey);
      if (oldest?.timer) clearTimeout(oldest.timer);
      oldest?.abortController.abort(new DOMException("Cache entry evicted", "AbortError"));
      this.entries.delete(oldestKey);
    }
  }

  private state(entry: CacheEntry): AgentAccessState {
    return entry.unavailable
      ? { available: false }
      : entry.snapshot
        ? { available: true, snapshot: entry.snapshot }
        : { available: false };
  }

  get(principal: OdooPrincipal): AgentAccessSnapshot {
    const fingerprint = agentCredentialFingerprint(principal);
    const entry = this.entries.get(fingerprint);
    if (!entry) throw new AgentAccessUnavailableError("The governed Agent connection has not been initialized");
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, entry);
    if (entry.unavailable) {
      throw new AgentAccessUnavailableError(entry.unavailable.message, entry.unavailable.policyCode);
    }
    if (!entry.snapshot) throw new AgentAccessUnavailableError("The governed Agent connection is unavailable");
    return entry.snapshot;
  }

  async initialize(context: RequestContext, signal?: AbortSignal): Promise<AgentAccessSnapshot> {
    if (this.closed) throw new AgentAccessUnavailableError("The MCP runtime is shutting down");
    const entry = this.entry(context);
    if (entry.unavailable && !entry.inflight) {
      throw new AgentAccessUnavailableError(entry.unavailable.message, entry.unavailable.policyCode);
    }
    if (entry.snapshot && !entry.unavailable) return entry.snapshot;
    if (entry.inflight) return await entry.inflight;
    return await this.refresh(entry, "initial", this.now(), false, signal);
  }

  touch(context: RequestContext): void {
    if (this.closed) return;
    const entry = this.entry(context);
    entry.nextIntervalIndex = 0;
    if (!entry.snapshot || entry.unavailable) return;
    const age = this.now() - entry.snapshot.refreshedAt;
    if (age >= REFRESH_INTERVAL_MINUTES[0] * 60_000) {
      this.queueRefresh(entry, "active");
      return;
    }
    this.schedule(entry, REFRESH_INTERVAL_MINUTES[0] * 60_000 - age);
  }

  noteAccessFailure(context: RequestContext, error: unknown): void {
    if (this.closed || !isAccessFailure(error)) return;
    const entry = this.entry(context);
    if (invalidatesIdentity(error)) {
      entry.unavailable = safeFailure(error);
      this.notify(entry);
    }
    const now = this.now();
    if (now - entry.lastAccessRefreshAt < ACCESS_FAILURE_COOLDOWN_MS) return;
    entry.lastAccessRefreshAt = now;
    this.queueRefresh(entry, "access_denied");
  }

  subscribe(principal: OdooPrincipal, listener: SnapshotListener): () => void {
    const fingerprint = agentCredentialFingerprint(principal);
    const entry = this.entries.get(fingerprint);
    if (!entry) throw new AgentAccessUnavailableError("The governed Agent connection has not been initialized");
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  private notify(entry: CacheEntry): boolean {
    const state = this.state(entry);
    let visibilityChanged = false;
    for (const listener of entry.listeners) {
      try {
        visibilityChanged = listener(state) === true || visibilityChanged;
      } catch {
        // Catalogue listeners cannot affect access refreshes.
      }
    }
    return visibilityChanged;
  }

  private jitter(milliseconds: number): number {
    const factor = 1 + (this.random() * 2 - 1) * JITTER_RATIO;
    return Math.max(1, Math.round(milliseconds * factor));
  }

  private schedule(entry: CacheEntry, delayMs?: number): void {
    if (this.closed) return;
    if (entry.timer) clearTimeout(entry.timer);
    const base = delayMs ?? (
      entry.nextIntervalIndex >= REFRESH_INTERVAL_MINUTES.length
        ? MAX_REFRESH_INTERVAL_MS
        : REFRESH_INTERVAL_MINUTES[entry.nextIntervalIndex]! * 60_000
    );
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.nextIntervalIndex = Math.min(entry.nextIntervalIndex + 1, REFRESH_INTERVAL_MINUTES.length);
      this.queueRefresh(entry, "scheduled");
    }, this.jitter(base));
    entry.timer.unref?.();
  }

  private queueRefresh(entry: CacheEntry, reason: Exclude<RefreshReason, "initial">): void {
    if (this.closed || entry.inflight) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const queuedAt = this.now();
    queueMicrotask(() => {
      if (this.closed || entry.inflight || !this.entries.has(entry.fingerprint)) return;
      void this.refresh(entry, reason, queuedAt, true).catch(() => undefined);
    });
  }

  private async refresh(
    entry: CacheEntry,
    reason: RefreshReason,
    queuedAt: number,
    background: boolean,
    signal?: AbortSignal
  ): Promise<AgentAccessSnapshot> {
    if (entry.inflight) return await entry.inflight;
    const started = this.now();
    const linkedSignal = signal
      ? AbortSignal.any([signal, entry.abortController.signal])
      : entry.abortController.signal;
    const operation = (async () => {
      try {
        const identity = await loadAgentIdentity(this.client, entry.context, linkedSignal, { background });
        const surface = await this.client.discoverSurface(entry.context, linkedSignal, background ? {
          forceRevalidate: true,
          priority: "background",
          timeoutMs: 4_000
        } : {});
        const snapshot = { identity, surface, refreshedAt: this.now() };
        entry.snapshot = snapshot;
        entry.unavailable = undefined;
        const visibilityChanged = this.notify(entry);
        emitEvent("agent.snapshot.refresh", {
          target_id: entry.context.principal.targetId,
          principal_id: entry.context.analyticsPrincipalId,
          reason,
          queue_delay_ms: started - queuedAt,
          duration_ms: this.now() - started,
          status: surface ? "ok" : "partial",
          snapshot_age_ms: 0,
          visibility_changed: visibilityChanged
        }, entry.context.eventObserver);
        this.schedule(entry);
        return snapshot;
      } catch (error) {
        if (!entry.snapshot || invalidatesIdentity(error)) entry.unavailable = safeFailure(error);
        const visibilityChanged = this.notify(entry);
        emitEvent("agent.snapshot.refresh", {
          target_id: entry.context.principal.targetId,
          principal_id: entry.context.analyticsPrincipalId,
          reason,
          queue_delay_ms: started - queuedAt,
          duration_ms: this.now() - started,
          status: error instanceof OdooError ? error.code : "unknown",
          snapshot_age_ms: entry.snapshot ? Math.max(0, this.now() - entry.snapshot.refreshedAt) : 0,
          visibility_changed: visibilityChanged
        }, entry.context.eventObserver);
        this.schedule(entry);
        throw error;
      } finally {
        entry.inflight = undefined;
      }
    })();
    entry.inflight = operation;
    return await operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const inflight: Promise<unknown>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.abortController.abort(new DOMException("MCP runtime shutdown", "AbortError"));
      if (entry.inflight) inflight.push(entry.inflight.catch(() => undefined));
    }
    await Promise.all(inflight);
    this.entries.clear();
  }
}
