import { createHash } from "node:crypto";
import {
  AgentIdentityValidationError,
  loadAgentIdentity,
  type AgentIdentity
} from "../odoo/agent_identity.js";
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

export interface AgentAccessSnapshotStore {
  load(principal: OdooPrincipal): AgentAccessSnapshot | null;
  save(principal: OdooPrincipal, snapshot: AgentAccessSnapshot): void;
  remove(principal: OdooPrincipal): void;
}

export interface AgentAccessState {
  available: boolean;
  snapshot?: AgentAccessSnapshot;
}

type RefreshReason = "initial" | "scheduled" | "active" | "access_denied" | "prepare";
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
  maximumStaleMs?: number;
  refreshTimeoutMs?: number;
  store?: AgentAccessSnapshotStore;
  now?: () => number;
  random?: () => number;
}

export interface AgentAccessInitializeOptions {
  requireSurface?: boolean;
  timeoutMs?: number;
}

export class AgentAccessUnavailableError extends Error {
  constructor(message: string, readonly policyCode?: string) {
    super(message);
    this.name = "AgentAccessUnavailableError";
  }
}

export class AgentAccessWarmingError extends Error {
  readonly retryAfterSeconds = 5;

  constructor(
    message = "The Odoo capability surface is warming; retry shortly",
    readonly refreshErrorClass?: string
  ) {
    super(message);
    this.name = "AgentAccessWarmingError";
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

function authorityFingerprint(identity: AgentIdentity): string {
  return createHash("sha256").update(JSON.stringify({
    user_id: identity.user_id,
    access_mode: identity.agent.access_mode,
    authority_reduced: identity.agent.authority_reduced,
    company_id: identity.company_id,
    company_ids: [...identity.company_ids].sort((left, right) => left - right),
    effective_group_ids: [...identity.effective_group_ids].sort((left, right) => left - right),
    effective_applications: identity.effective_applications
      .map(({ id, access }) => ({ id, access }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  })).digest("base64url");
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
  if (error instanceof AgentIdentityValidationError) return true;
  if (!(error instanceof OdooError)) return false;
  return error.httpStatus === 401
    || ["agent_suspended", "agent_principal_required", "agent_transport_denied"].includes(error.policyCode ?? "");
}

function isTransientFailure(error: unknown): boolean {
  return error instanceof OdooError && (
    error.retryable
    || error.code === "timeout"
    || error.code === "network_error"
    || error.code === "rate_limited"
    || (error.httpStatus !== null && error.httpStatus >= 500)
  );
}

function safeFailure(error: unknown): { message: string; policyCode?: string } {
  return {
    message: error instanceof Error ? error.message.slice(0, 500) : "The governed Agent identity is unavailable",
    ...(policyCode(error) ? { policyCode: policyCode(error) } : {})
  };
}

function failureClass(error: unknown): string {
  return error instanceof OdooError ? error.code : error instanceof Error ? error.name : "unknown";
}

export class AgentAccessSnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maximumEntries: number;
  private readonly maximumStaleMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private store?: AgentAccessSnapshotStore;
  private closed = false;

  constructor(
    private readonly client: OdooClient,
    options: AgentAccessSnapshotCacheOptions = {}
  ) {
    this.maximumEntries = options.maximumEntries ?? 50;
    this.maximumStaleMs = options.maximumStaleMs ?? 24 * 60 * 60_000;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 120_000;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  setPersistentStore(store: AgentAccessSnapshotStore): void {
    if (this.store && this.store !== store) throw new Error("The Agent access snapshot store is already configured");
    this.store = store;
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

  private persistent(principal: OdooPrincipal): boolean {
    return principal.authMode === "oauth" && Boolean(principal.enrollmentId) && Boolean(this.store);
  }

  private fresh(snapshot: AgentAccessSnapshot): boolean {
    return this.now() - snapshot.refreshedAt <= this.maximumStaleMs;
  }

  private hydrate(entry: CacheEntry): boolean {
    if (entry.snapshot || !this.persistent(entry.context.principal)) return false;
    const snapshot = this.store!.load(entry.context.principal);
    if (!snapshot) return false;
    if (!snapshot.surface || !this.fresh(snapshot)) {
      this.store!.remove(entry.context.principal);
      return false;
    }
    entry.snapshot = snapshot;
    entry.unavailable = undefined;
    emitEvent("agent.snapshot.refresh", {
      target_id: entry.context.principal.targetId,
      principal_id: entry.context.analyticsPrincipalId,
      reason: "initial",
      status: "stale",
      cache_source: "persistent",
      duration_ms: 0,
      queue_delay_ms: 0,
      snapshot_age_ms: Math.max(0, this.now() - snapshot.refreshedAt),
      visibility_changed: false
    }, entry.context.eventObserver);
    return true;
  }

  private discard(entry: CacheEntry): void {
    entry.snapshot = undefined;
    if (this.persistent(entry.context.principal)) this.store!.remove(entry.context.principal);
  }

  private persist(entry: CacheEntry): void {
    if (entry.snapshot?.surface && this.persistent(entry.context.principal)) {
      this.store!.save(entry.context.principal, entry.snapshot);
    }
  }

  persistCurrent(context: RequestContext): boolean {
    const entry = this.entry(context);
    if (!entry.snapshot?.surface || !this.persistent(context.principal)) return false;
    this.store!.save(context.principal, entry.snapshot);
    return true;
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
    if (!entry.snapshot) {
      if (this.persistent(principal)) throw new AgentAccessWarmingError();
      throw new AgentAccessUnavailableError("The governed Agent connection is unavailable");
    }
    if (this.persistent(principal) && (!entry.snapshot.surface || !this.fresh(entry.snapshot))) {
      this.discard(entry);
      throw new AgentAccessWarmingError();
    }
    return entry.snapshot;
  }

  async initialize(
    context: RequestContext,
    signal?: AbortSignal,
    options: AgentAccessInitializeOptions = {}
  ): Promise<AgentAccessSnapshot> {
    if (this.closed) throw new AgentAccessUnavailableError("The MCP runtime is shutting down");
    const entry = this.entry(context);
    const hydrated = this.hydrate(entry);
    if (entry.unavailable && !entry.inflight) {
      throw new AgentAccessUnavailableError(entry.unavailable.message, entry.unavailable.policyCode);
    }
    if (entry.snapshot && !entry.unavailable) {
      if (this.persistent(context.principal) && !this.fresh(entry.snapshot)) {
        this.discard(entry);
      } else {
        if (hydrated) this.queueRefresh(entry, "active");
        return entry.snapshot;
      }
    }
    if (entry.inflight) return await entry.inflight;
    return await this.refresh(
      entry,
      "initial",
      this.now(),
      false,
      signal,
      options.requireSurface ?? false,
      options.timeoutMs
    );
  }

  async warm(
    context: RequestContext,
    signal?: AbortSignal
  ): Promise<{ snapshot: AgentAccessSnapshot; refreshed: boolean }> {
    if (this.closed) throw new AgentAccessUnavailableError("The MCP runtime is shutting down");
    const entry = this.entry(context);
    this.hydrate(entry);
    const previousRefreshedAt = entry.snapshot?.refreshedAt;
    const snapshot = await this.refresh(
      entry,
      "prepare",
      this.now(),
      false,
      signal,
      true,
      this.refreshTimeoutMs
    );
    return { snapshot, refreshed: snapshot.refreshedAt !== previousRefreshedAt };
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
      this.discard(entry);
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

  private queueRefresh(entry: CacheEntry, reason: Exclude<RefreshReason, "initial" | "prepare">): void {
    if (this.closed || entry.inflight) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const queuedAt = this.now();
    queueMicrotask(() => {
      if (this.closed || entry.inflight || !this.entries.has(entry.fingerprint)) return;
      void this.refresh(
        entry,
        reason,
        queuedAt,
        true,
        undefined,
        this.persistent(entry.context.principal),
        this.refreshTimeoutMs
      ).catch(() => undefined);
    });
  }

  private async refresh(
    entry: CacheEntry,
    reason: RefreshReason,
    queuedAt: number,
    background: boolean,
    signal?: AbortSignal,
    requireSurface = false,
    timeoutMs = background ? this.refreshTimeoutMs : undefined
  ): Promise<AgentAccessSnapshot> {
    if (entry.inflight) return await entry.inflight;
    const started = this.now();
    const linkedSignal = signal
      ? AbortSignal.any([signal, entry.abortController.signal])
      : entry.abortController.signal;
    const previous = entry.snapshot;
    const operation = (async () => {
      try {
        const deadline = timeoutMs ? performance.now() + timeoutMs : undefined;
        const remainingTimeout = () => deadline === undefined
          ? undefined
          : Math.max(1, Math.floor(deadline - performance.now()));
        const identity = await loadAgentIdentity(this.client, entry.context, linkedSignal, {
          background,
          ...(timeoutMs ? {
            timeoutMs: background
              ? Math.min(remainingTimeout()!, 15_000)
              : remainingTimeout()!
          } : {})
        });
        let surface: OdooSurface | null;
        try {
          surface = await this.client.discoverSurfaceStrict(entry.context, linkedSignal, {
            forceRevalidate: reason !== "initial",
            priority: background ? "background" : "foreground",
            ...(timeoutMs ? { timeoutMs: remainingTimeout()! } : {}),
            ...(previous?.surface ? { previous: previous.surface } : {})
          });
        } catch (error) {
          if (error instanceof OdooError && (error.httpStatus === 401 || error.httpStatus === 403)) {
            this.discard(entry);
            throw error;
          }
          const authorityChanged = previous
            ? authorityFingerprint(previous.identity) !== authorityFingerprint(identity)
            : false;
          if (authorityChanged) this.discard(entry);
          if (previous?.surface && !authorityChanged && this.fresh(previous)) {
            entry.snapshot = previous;
            entry.unavailable = undefined;
            const visibilityChanged = this.notify(entry);
            emitEvent("agent.snapshot.refresh", {
              target_id: entry.context.principal.targetId,
              principal_id: entry.context.analyticsPrincipalId,
              reason,
              queue_delay_ms: started - queuedAt,
              duration_ms: this.now() - started,
              status: error instanceof OdooError ? error.code : "unknown",
              cache_source: "stale",
              snapshot_age_ms: Math.max(0, this.now() - previous.refreshedAt),
              visibility_changed: visibilityChanged
            }, entry.context.eventObserver);
            this.schedule(entry);
            return previous;
          }
          if (requireSurface) throw new AgentAccessWarmingError(undefined, failureClass(error));
          surface = null;
        }
        const snapshot = { identity, surface, refreshedAt: this.now() };
        entry.snapshot = snapshot;
        entry.unavailable = undefined;
        this.persist(entry);
        const visibilityChanged = this.notify(entry);
        emitEvent("agent.snapshot.refresh", {
          target_id: entry.context.principal.targetId,
          principal_id: entry.context.analyticsPrincipalId,
          reason,
          queue_delay_ms: started - queuedAt,
          duration_ms: this.now() - started,
          status: surface ? "ok" : "partial",
          cache_source: "live",
          snapshot_age_ms: 0,
          visibility_changed: visibilityChanged
        }, entry.context.eventObserver);
        this.schedule(entry);
        return snapshot;
      } catch (error) {
        let reportedError = error;
        if (invalidatesIdentity(error)) {
          entry.unavailable = safeFailure(error);
          this.discard(entry);
        } else if (requireSurface && !entry.snapshot && isTransientFailure(error)) {
          reportedError = new AgentAccessWarmingError(undefined, failureClass(error));
        } else if (!entry.snapshot && !(error instanceof AgentAccessWarmingError)) {
          entry.unavailable = safeFailure(error);
        }
        const visibilityChanged = this.notify(entry);
        emitEvent("agent.snapshot.refresh", {
          target_id: entry.context.principal.targetId,
          principal_id: entry.context.analyticsPrincipalId,
          reason,
          queue_delay_ms: started - queuedAt,
          duration_ms: this.now() - started,
          status: reportedError instanceof AgentAccessWarmingError
            ? "warming"
            : reportedError instanceof OdooError ? reportedError.code : "unknown",
          error_class: reportedError instanceof AgentAccessWarmingError
            ? reportedError.refreshErrorClass ?? "warming"
            : failureClass(reportedError),
          cache_source: entry.snapshot ? "stale" : "none",
          snapshot_age_ms: entry.snapshot ? Math.max(0, this.now() - entry.snapshot.refreshedAt) : 0,
          visibility_changed: visibilityChanged
        }, entry.context.eventObserver);
        this.schedule(entry);
        throw reportedError;
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
