import {
  OdooError,
  type OdooCallOptions,
  type OdooConnection,
  type OdooResponseMetadata,
  callOdoo,
  readBoundedText
} from "./odoo";
import {
  IDEMPOTENCY_CAPABILITY_METHOD,
  IDEMPOTENCY_CAPABILITY_MODEL,
  MutationExecutionError,
  childIdempotencyKey,
  correlationIdForKey,
  mergeOdooMutationContext,
  parseIdempotencyCapabilities,
  resolveIdempotencyKey,
  type IdempotencyCapabilities,
  type MutationExecution
} from "./mutation";

export interface OdooQueueOptions {
  /** Test-only fallback pacing when no global coordinator binding is supplied. */
  minDelayMs?: number;
  maxMetricsEntries?: number;
  coordinator?: DurableObjectNamespace;
  handshakeRequired?: boolean;
  handshakeTtlMs?: number;
  capabilityTtlMs?: number;
}

export interface CallMetric {
  model: string;
  method: string;
  ms: number;
  ok: boolean;
}

export interface Metrics {
  odoo_calls: number;
  total_duration_ms: number;
  calls: CallMetric[];
  dropped_calls?: number;
}

export interface MutationOperationOptions {
  idempotencyKey?: string;
  reason?: string;
  odooContext?: Record<string, unknown>;
}

export interface MutationResult<T> {
  result: T;
  execution: MutationExecution;
}

interface QueueItem {
  run: () => Promise<void>;
}

interface CapabilityCacheEntry {
  expiresAt: number;
  capabilities: IdempotencyCapabilities | null;
}

const DEFAULT_MAX_METRICS = 1000;
const DEFAULT_HANDSHAKE_TTL_MS = 5 * 60_000;
const DEFAULT_CAPABILITY_TTL_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asOptions(options: number | OdooCallOptions | undefined): OdooCallOptions {
  return typeof options === "number" ? { timeoutMs: options } : { ...(options ?? {}) };
}

/** One logical mutation, potentially composed from deterministically keyed Odoo calls. */
export class OdooMutationScope {
  private successfulCalls = 0;
  private allReplayed = true;
  private expiry: string | undefined;

  constructor(
    private readonly queue: OdooQueue,
    private readonly conn: OdooConnection,
    private readonly operation: MutationOperationOptions,
    readonly execution: MutationExecution
  ) {}

  get appliedCalls(): number {
    return this.successfulCalls;
  }

  async call<T>(
    model: string,
    method: string,
    args: Record<string, unknown>,
    stableStep?: string
  ): Promise<T> {
    const key = stableStep
      ? await childIdempotencyKey(this.execution.idempotency_key, stableStep)
      : this.execution.idempotency_key;
    const body = {
      ...args,
      context: mergeOdooMutationContext(
        args.context,
        this.operation.odooContext,
        this.execution,
        this.operation.reason
      )
    };
    let responseMetadata: OdooResponseMetadata | undefined;
    const atomic = this.execution.idempotency_mode === "odoo_atomic";
    const result = await this.queue.enqueue<T>(this.conn, model, method, body, {
      // A legacy installation safely ignores the header. Sending the key even
      // in one-shot mode preserves the best available recovery path without
      // claiming that atomic replay support was discovered.
      idempotencyKey: key,
      maxAttempts: atomic ? 3 : 1,
      retryTimeouts: atomic,
      retryNetworkErrors: atomic,
      onResponseMetadata: (metadata) => {
        responseMetadata = metadata;
      }
    });
    this.successfulCalls++;
    this.allReplayed = this.allReplayed && responseMetadata?.idempotencyStatus === "replayed";
    if (responseMetadata?.idempotencyExpiresAt) this.expiry = responseMetadata.idempotencyExpiresAt;
    this.execution.replayed = this.successfulCalls > 0 && this.allReplayed;
    if (this.expiry) this.execution.expires_at = this.expiry;
    return result;
  }
}

/**
 * Per-agent facade for metrics, handshake/capability caching, and mutation
 * metadata. Production physical serialization happens in OdooOriginCoordinator;
 * the local FIFO exists only for tests/injected callers without that binding.
 */
export class OdooQueue {
  private readonly callOdooFn: typeof callOdoo;
  private readonly minDelayMs: number;
  private readonly maxMetricsEntries: number;
  private readonly coordinator?: DurableObjectNamespace;
  private readonly handshakeRequired: boolean;
  private readonly handshakeTtlMs: number;
  private readonly capabilityTtlMs: number;
  private readonly queue: QueueItem[] = [];
  private readonly calls: CallMetric[] = [];
  private readonly capabilityCache = new Map<string, CapabilityCacheEntry>();
  private completedCalls = 0;
  private totalDurationMs = 0;
  private draining = false;
  private lastStartTime = 0;
  private handshakeIdentity?: string;
  private handshakeExpiresAt = 0;
  private handshakePromise?: Promise<void>;
  private drainPromise?: Promise<void>;

  constructor(callOdooFn: typeof callOdoo, options: OdooQueueOptions = {}) {
    this.callOdooFn = callOdooFn;
    this.minDelayMs = Math.max(0, options.minDelayMs ?? 0);
    this.maxMetricsEntries = Math.max(1, options.maxMetricsEntries ?? DEFAULT_MAX_METRICS);
    this.coordinator = options.coordinator;
    this.handshakeRequired = options.handshakeRequired ?? false;
    this.handshakeTtlMs = Math.max(1, options.handshakeTtlMs ?? DEFAULT_HANDSHAKE_TTL_MS);
    this.capabilityTtlMs = Math.max(1, options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS);
  }

  private coordinatorFetch: typeof fetch = async (input, init) => {
    if (!this.coordinator) return fetch(input, init);
    const request = new Request(input, init);
    const origin = new URL(request.url).origin;
    return this.coordinator.getByName(origin).fetch(request);
  };

  private connectionIdentity(conn: OdooConnection): string {
    return `${new URL(conn.url).origin}\0${conn.db}`;
  }

  private async ensureHandshake(conn: OdooConnection): Promise<void> {
    if (!this.handshakeRequired || conn.authMode !== "header") return;
    const identity = this.connectionIdentity(conn);
    if (this.handshakeIdentity === identity && Date.now() < this.handshakeExpiresAt) return;
    if (this.handshakePromise) return this.handshakePromise;

    this.handshakePromise = (async () => {
      try {
        await this.callOdooFn(
          conn,
          "res.users",
          "fields_get",
          { attributes: ["type"] },
          {
            timeoutMs: 8_000,
            maxAttempts: 1,
            retryTimeouts: false,
            retryNetworkErrors: false,
            fetcher: this.coordinatorFetch,
            maxResponseBytes: 256 * 1024
          }
        );
      } catch (cause) {
        const code = cause instanceof OdooError ? cause.code : "unauthorized";
        const status = cause instanceof OdooError ? cause.httpStatus : null;
        throw new OdooError({
          message: "Odoo credential handshake failed.",
          code,
          httpStatus: status,
          model: "res.users",
          method: "fields_get",
          details: "Odoo credential handshake failed; verify the configured origin, database, and API key.",
          recoverable: false,
          mutationOutcome: "not_applied"
        });
      }
      this.handshakeIdentity = identity;
      this.handshakeExpiresAt = Date.now() + this.handshakeTtlMs;
    })().finally(() => {
      this.handshakePromise = undefined;
    });
    return this.handshakePromise;
  }

  private async idempotencyCapabilities(conn: OdooConnection): Promise<IdempotencyCapabilities | null> {
    const identity = this.connectionIdentity(conn);
    const cached = this.capabilityCache.get(identity);
    if (cached && Date.now() < cached.expiresAt) return cached.capabilities;

    let capabilities: IdempotencyCapabilities | null = null;
    try {
      const raw = await this.callOdooFn(conn, IDEMPOTENCY_CAPABILITY_MODEL, IDEMPOTENCY_CAPABILITY_METHOD, {}, {
        timeoutMs: 8_000,
        maxAttempts: 1,
        retryTimeouts: false,
        retryNetworkErrors: false,
        fetcher: this.coordinatorFetch,
        maxResponseBytes: 64 * 1024
      });
      capabilities = parseIdempotencyCapabilities(raw);
    } catch {
      // Missing, older, or temporarily unavailable extension: one-shot writes
      // remain permitted, but the MCP must not imply an atomic replay guarantee.
      capabilities = null;
    }
    this.capabilityCache.set(identity, { capabilities, expiresAt: Date.now() + this.capabilityTtlMs });
    return capabilities;
  }

  async fetchOdooDocument<T>(conn: OdooConnection, path: string, maxBytes = 8 * 1024 * 1024): Promise<T> {
    await this.ensureHandshake(conn);
    if (!path.startsWith("/doc-bearer/") || !path.endsWith(".json")) {
      throw new Error("Only authenticated Odoo API-document JSON paths are supported.");
    }
    const start = Date.now();
    try {
      const response = await this.coordinatorFetch(`${conn.url}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${conn.apiKey}`,
          "X-Odoo-Database": conn.db,
          Accept: "application/json",
          "Cache-Control": "no-cache"
        },
        redirect: "manual"
      });
      if (!response.ok) {
        throw new OdooError({
          message: `Odoo API documentation request failed (${response.status})`,
          code: response.status === 401 ? "unauthorized" : response.status === 403 ? "permission_denied" : "invalid_request",
          httpStatus: response.status,
          model: "api_doc",
          method: path,
          details: "Odoo API documentation is unavailable for this user or installation.",
          mutationOutcome: "not_applied"
        });
      }
      const text = await readBoundedText(response, maxBytes, "api_doc", path);
      const value = JSON.parse(text) as T;
      this.recordMetric({ model: "api_doc", method: path, ms: Date.now() - start, ok: true });
      return value;
    } catch (error) {
      this.recordMetric({ model: "api_doc", method: path, ms: Date.now() - start, ok: false });
      throw error;
    }
  }

  enqueue<T>(
    conn: OdooConnection,
    model: string,
    method: string,
    args: Record<string, unknown>,
    options?: number | OdooCallOptions
  ): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureHandshake(conn);
      const start = Date.now();
      try {
        const result = await this.callOdooFn(conn, model, method, args, {
          ...asOptions(options),
          fetcher: this.coordinatorFetch
        });
        this.recordMetric({ model, method, ms: Date.now() - start, ok: true });
        return result as T;
      } catch (err) {
        this.recordMetric({ model, method, ms: Date.now() - start, ok: false });
        throw err;
      }
    };

    if (this.coordinator) return run();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => {
          try {
            resolve(await run());
          } catch (err) {
            reject(err);
          }
        }
      });
      if (!this.draining) {
        this.draining = true;
        this.drainPromise = this.drain();
      }
    });
  }

  async runMutation<T>(
    conn: OdooConnection,
    operation: MutationOperationOptions,
    callback: (scope: OdooMutationScope) => Promise<T>
  ): Promise<MutationResult<T>> {
    await this.ensureHandshake(conn);
    const key = resolveIdempotencyKey(operation.idempotencyKey);
    const capabilities = await this.idempotencyCapabilities(conn);
    const execution: MutationExecution = {
      idempotency_key: key,
      idempotency_mode: capabilities ? "odoo_atomic" : "unavailable",
      replayed: false,
      correlation_id: await correlationIdForKey(key),
      outcome: "unknown"
    };
    const scope = new OdooMutationScope(this, conn, operation, execution);
    try {
      const result = await callback(scope);
      execution.outcome = "succeeded";
      return { result, execution };
    } catch (cause) {
      execution.outcome =
        scope.appliedCalls > 0
          ? "unknown"
          : cause instanceof OdooError
            ? cause.mutationOutcome
            : "not_applied";
      throw new MutationExecutionError(cause, execution);
    }
  }

  private recordMetric(metric: CallMetric): void {
    this.completedCalls++;
    this.totalDurationMs += metric.ms;
    this.calls.push(metric);
    if (this.calls.length > this.maxMetricsEntries) this.calls.shift();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const wait = Math.max(0, this.minDelayMs - (Date.now() - this.lastStartTime));
      if (wait > 0) await sleep(wait);
      const item = this.queue.shift();
      if (!item) continue;
      this.lastStartTime = Date.now();
      await item.run();
    }
    this.draining = false;
    this.drainPromise = undefined;
  }

  getMetrics(): Metrics {
    return {
      odoo_calls: this.completedCalls,
      total_duration_ms: this.totalDurationMs,
      calls: [...this.calls],
      dropped_calls: this.completedCalls - this.calls.length
    };
  }

  snapshot(): number {
    return this.completedCalls;
  }

  delta(snapshot: number): Metrics {
    const retainedStart = this.completedCalls - this.calls.length;
    const startIndex = Math.max(0, snapshot - retainedStart);
    const slice = this.calls.slice(startIndex);
    return {
      odoo_calls: Math.max(0, this.completedCalls - snapshot),
      total_duration_ms: slice.reduce((sum, call) => sum + call.ms, 0),
      calls: [...slice],
      dropped_calls: Math.max(0, retainedStart - snapshot)
    };
  }
}
