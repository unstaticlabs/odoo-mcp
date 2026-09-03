import { createHash } from "node:crypto";
import type { RequestContext } from "../runtime/context.js";
import { emitEvent } from "../runtime/logging.js";
import { injectTraceHeaders } from "../runtime/observability.js";
import { Semaphore } from "../runtime/semaphore.js";
import { assertBoundedJson, ModelNameSchema, MethodNameSchema } from "./schemas.js";

export type OdooCallKind = "read" | "mutation";
export type OdooRequestPriority = "foreground" | "background";
export type MutationOutcome = "not_applied" | "unknown";
export type MutationStage = "request_rejected" | "completion_ambiguous" | "response_processing";

export interface MutationReconciliation {
  targetModel: string;
  suggestedTool: string;
  instructions: string;
  knownIds?: readonly number[];
  fields?: readonly string[];
}

export interface MutationResultEvidence {
  knownIds?: readonly number[];
  grantId?: string;
}

export interface MutationKnownFacts {
  requestSent: "yes" | "no" | "unknown";
  responseReceived: "yes" | "no" | "unknown";
  resultReceived: "yes" | "no" | "unknown";
  targetModel: string;
  knownIds?: readonly number[];
  grantId?: string;
}

export type OdooErrorCode =
  | "unauthorized"
  | "permission_denied"
  | "model_or_method_not_found"
  | "invalid_request"
  | "rate_limited"
  | "payload_too_large"
  | "odoo_server_error"
  | "timeout"
  | "network_error"
  | "cancelled"
  | "unknown";

export class OdooError extends Error {
  constructor(
    message: string,
    readonly code: OdooErrorCode,
    readonly httpStatus: number | null,
    readonly model: string,
    readonly method: string,
    readonly retryable: boolean,
    readonly mutationOutcome: MutationOutcome,
    readonly details?: string,
    readonly callKind: OdooCallKind = "read",
    readonly mutationStage?: MutationStage,
    readonly reconciliation?: MutationReconciliation,
    readonly known?: MutationKnownFacts,
    readonly policyCode?: string
  ) {
    super(message);
    this.name = "OdooError";
  }
}

interface SharedCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  responseBytes?: number;
  priority?: OdooRequestPriority;
  maxAttempts?: 1 | 2 | 3;
}

interface ReadCallOptions extends SharedCallOptions {
  kind?: "read";
}

interface MutationCallOptions extends SharedCallOptions {
  kind: "mutation";
  reconciliation: MutationReconciliation;
}

type CallOptions = ReadCallOptions | MutationCallOptions;

interface ApiDocumentCacheEntry {
  etag?: string;
  expiresAt: number;
  value: unknown;
}

export interface OdooSurface {
  modules: ReadonlySet<string>;
  publicMethods: ReadonlyMap<string, ReadonlySet<string>>;
  modelAccess: ReadonlyMap<string, OdooModelAccess>;
}

export interface OdooModelAccess {
  read: boolean;
  create: boolean;
  write: boolean;
  unlink: boolean;
}

export interface ApiDocumentOptions {
  forceRevalidate?: boolean;
  priority?: OdooRequestPriority;
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const API_DOCUMENT_CACHE_TTL_MS = 5 * 60_000;
const API_DOCUMENT_CACHE_MAX_ENTRIES = 50;

function sanitizeKnownIds(values: readonly number[] | undefined): number[] | undefined {
  if (!values) return undefined;
  const ids = [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].slice(0, 100);
  return ids.length > 0 ? ids : undefined;
}

function knownFacts(
  reconciliation: MutationReconciliation,
  facts: Pick<MutationKnownFacts, "requestSent" | "responseReceived" | "resultReceived">,
  observed?: MutationResultEvidence
): MutationKnownFacts {
  const knownIds = sanitizeKnownIds(observed?.knownIds ?? reconciliation.knownIds);
  const grantId = typeof observed?.grantId === "string" && /^[0-9a-f-]{36}$/i.test(observed.grantId)
    ? observed.grantId
    : undefined;
  return {
    ...facts,
    targetModel: reconciliation.targetModel,
    ...(knownIds ? { knownIds } : {}),
    ...(grantId ? { grantId } : {})
  };
}

export class MutationReceipt<T> {
  constructor(
    private readonly value: T,
    private readonly model: string,
    private readonly method: string,
    private readonly reconciliation: MutationReconciliation
  ) {}

  async finalize<R>(
    project: (value: T) => R | Promise<R>,
    observe?: (value: T) => MutationResultEvidence
  ): Promise<FinalizedMutation<R>> {
    let observed: MutationResultEvidence | undefined;
    try {
      observed = observe?.(this.value);
      return new FinalizedMutation(
        await project(this.value),
        this.model,
        this.method,
        this.reconciliation,
        observed
      );
    } catch (error) {
      throw mutationProcessingError(this.model, this.method, this.reconciliation, observed, error);
    }
  }
}

const finalizedMutationBrand = Symbol("FinalizedMutation");

export class FinalizedMutation<T> {
  readonly [finalizedMutationBrand] = true;

  constructor(
    private readonly value: T,
    private readonly model: string,
    private readonly method: string,
    private readonly reconciliation: MutationReconciliation,
    private readonly observed?: MutationResultEvidence
  ) {}

  async guard<R>(consume: (value: T) => R | Promise<R>): Promise<R> {
    try {
      return await consume(this.value);
    } catch (error) {
      throw mutationProcessingError(
        this.model,
        this.method,
        this.reconciliation,
        this.observed,
        error
      );
    }
  }
}

export function isFinalizedMutation<T>(
  value: T | FinalizedMutation<T>
): value is FinalizedMutation<T> {
  return value instanceof FinalizedMutation;
}

function mutationProcessingError(
  model: string,
  method: string,
  reconciliation: MutationReconciliation,
  observed: MutationResultEvidence | undefined,
  error: unknown
): OdooError {
  const detail = redactDetails(error instanceof Error ? error.message : String(error));
  return new OdooError(
    `Odoo returned success for ${model}.${method}, but the MCP could not validate the result: ${detail}`,
    "unknown",
    200,
    model,
    method,
    false,
    "unknown",
    detail,
    "mutation",
    "response_processing",
    reconciliation,
    knownFacts(reconciliation, {
      requestSent: "yes",
      responseReceived: "yes",
      resultReceived: "yes"
    }, observed)
  );
}

function statusCode(status: number): OdooErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "permission_denied";
  if (status === 404) return "model_or_method_not_found";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "odoo_server_error";
  return "unknown";
}

function retryAfterMs(response: Response, fallback: number): number {
  const raw = response.headers.get("Retry-After");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.max(fallback, seconds * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(30_000, Math.max(fallback, date - Date.now())) : fallback;
}

function redactDetails(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/api[_ -]?key["':=\s]+[^\s,;}]+/gi, "api_key=[REDACTED]")
    .slice(0, 2000);
}

function errorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
    if (nested.data && typeof nested.data === "object") {
      const message = (nested.data as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return typeof record.message === "string" ? record.message : undefined;
}

function policyCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const candidates: unknown[] = [record.context];
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    const error = record.error as Record<string, unknown>;
    candidates.push(error.context);
    if (error.data && typeof error.data === "object" && !Array.isArray(error.data)) {
      candidates.push((error.data as Record<string, unknown>).context);
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const code = (candidate as Record<string, unknown>).usl_code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(code)) return code;
  }
  return undefined;
}

async function boundedText(
  response: Response,
  maximum: number,
  model: string,
  method: string,
  kind: OdooCallKind = "read",
  reconciliation?: MutationReconciliation
): Promise<string> {
  const mutationKnown = kind === "mutation" && reconciliation
    ? knownFacts(reconciliation, { requestSent: "yes", responseReceived: "yes", resultReceived: "no" })
    : undefined;
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new OdooError("Odoo response exceeded its size limit", "payload_too_large", response.status, model, method, false, kind === "mutation" ? "unknown" : "not_applied", undefined, kind, kind === "mutation" ? "response_processing" : undefined, reconciliation, mutationKnown);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new OdooError("Odoo response exceeded its size limit", "payload_too_large", response.status, model, method, false, kind === "mutation" ? "unknown" : "not_applied", undefined, kind, kind === "mutation" ? "response_processing" : undefined, reconciliation, mutationKnown);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OdooError) throw error;
    throw new OdooError("Odoo response ended before completion", "network_error", response.status, model, method, true, kind === "mutation" ? "unknown" : "not_applied", undefined, kind, kind === "mutation" ? "completion_ambiguous" : undefined, reconciliation, mutationKnown);
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export class OdooClient {
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly backgroundSemaphores = new Map<string, Semaphore>();
  private readonly apiDocumentCache = new Map<string, ApiDocumentCacheEntry>();

  constructor(
    private readonly concurrency = 8,
    private readonly defaultResponseBytes = 1024 * 1024,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private semaphore(targetId: string): Semaphore {
    let semaphore = this.semaphores.get(targetId);
    if (!semaphore) {
      semaphore = new Semaphore(this.concurrency);
      this.semaphores.set(targetId, semaphore);
    }
    return semaphore;
  }

  private backgroundSemaphore(targetId: string): Semaphore {
    let semaphore = this.backgroundSemaphores.get(targetId);
    if (!semaphore) {
      semaphore = new Semaphore(1);
      this.backgroundSemaphores.set(targetId, semaphore);
    }
    return semaphore;
  }

  private async runForTarget<T>(
    context: RequestContext,
    priority: OdooRequestPriority,
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const run = () => this.semaphore(context.principal.targetId).run(operation, signal, priority);
    return priority === "background"
      ? await this.backgroundSemaphore(context.principal.targetId).run(run, signal, "background")
      : await run();
  }

  async call<T>(
    context: RequestContext,
    model: string,
    method: string,
    kwargs: Record<string, unknown>,
    options: MutationCallOptions
  ): Promise<MutationReceipt<T>>;
  async call<T>(
    context: RequestContext,
    model: string,
    method: string,
    kwargs: Record<string, unknown>,
    options?: ReadCallOptions
  ): Promise<T>;
  async call<T>(
    context: RequestContext,
    model: string,
    method: string,
    kwargs: Record<string, unknown>,
    options: CallOptions = {}
  ): Promise<T | MutationReceipt<T>> {
    ModelNameSchema.parse(model);
    MethodNameSchema.parse(method);
    assertBoundedJson(kwargs);
    const mutationOptions = options.kind === "mutation" ? options : undefined;
    const kind = mutationOptions ? "mutation" : "read";
    const maximumAttempts = kind === "read" ? options.maxAttempts ?? 3 : 1;
    const responseBytes = options.responseBytes ?? this.defaultResponseBytes;
    const body = JSON.stringify(kwargs);
    const traceHeaders = injectTraceHeaders(context.trace?.context);

    return await this.runForTarget(context, options.priority ?? "foreground", async () => {
      for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
        const started = Date.now();
        emitEvent("odoo.call.started", {
          request_id: context.requestId,
          correlation_id: context.correlationId,
          target_id: context.principal.targetId,
          model,
          method,
          effect: kind,
          attempt,
          request_bytes: Buffer.byteLength(body),
          principal_id: context.analyticsPrincipalId,
          trace_id: context.trace?.traceId,
          parent_span_id: context.trace?.spanId,
          trace_sampled: context.trace?.sampled
        }, context.eventObserver);
        try {
          const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
          const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
          const response = await this.fetcher(
            `${context.principal.internalOrigin}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${context.principal.apiKey}`,
                "X-Odoo-Database": context.principal.database,
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": "usl-odoo-mcp/2",
                ...traceHeaders
              },
              redirect: "manual",
              body,
              signal
            }
          );
          const reconciliation = mutationOptions?.reconciliation;
          const text = await boundedText(response, responseBytes, model, method, kind, reconciliation);
          let payload: unknown = null;
          let unparsable = false;
          if (text) {
            try {
              payload = JSON.parse(text) as unknown;
            } catch {
              unparsable = true;
            }
          }
          if (!response.ok) {
            const code = statusCode(response.status);
            const retryable = RETRYABLE_STATUS.has(response.status);
            if (kind === "read" && retryable && attempt < maximumAttempts) {
              emitEvent("odoo.call.completed", {
                request_id: context.requestId,
                correlation_id: context.correlationId,
                target_id: context.principal.targetId,
                model,
                method,
                effect: kind,
                attempt,
                status: code,
                retry: attempt > 1,
                will_retry: true,
                duration_ms: Date.now() - started,
                request_bytes: Buffer.byteLength(body),
                response_bytes: Buffer.byteLength(text),
                principal_id: context.analyticsPrincipalId,
                trace_id: context.trace?.traceId,
                parent_span_id: context.trace?.spanId,
                trace_sampled: context.trace?.sampled
              }, context.eventObserver);
              await delay(retryAfterMs(response, 250 * 2 ** (attempt - 1)), options.signal);
              continue;
            }
            const detail = redactDetails(errorMessage(payload) ?? `Odoo request failed with HTTP ${response.status}`);
            const structuredOdooError = Boolean(errorMessage(payload));
            throw new OdooError(
              detail,
              code,
              response.status,
              model,
              method,
              retryable,
              kind === "mutation" && !structuredOdooError && response.status >= 500 ? "unknown" : "not_applied",
              detail,
              kind,
              kind === "mutation"
                ? structuredOdooError || response.status < 500 ? "request_rejected" : "completion_ambiguous"
                : undefined,
              reconciliation,
              kind === "mutation" && reconciliation
                ? knownFacts(reconciliation, { requestSent: "yes", responseReceived: "yes", resultReceived: "no" })
                : undefined,
              policyCode(payload)
            );
          }
          if (unparsable) {
            throw new OdooError(
              "Odoo returned invalid JSON",
              "odoo_server_error",
              response.status,
              model,
              method,
              false,
              kind === "mutation" ? "unknown" : "not_applied",
              undefined,
              kind,
              kind === "mutation" ? "response_processing" : undefined,
              reconciliation,
              kind === "mutation" && reconciliation
                ? knownFacts(reconciliation, { requestSent: "yes", responseReceived: "yes", resultReceived: "no" })
                : undefined
            );
          }
          emitEvent("odoo.call.completed", {
            request_id: context.requestId,
            correlation_id: context.correlationId,
            target_id: context.principal.targetId,
            model,
            method,
            effect: kind,
            attempt,
            status: "ok",
            retry: attempt > 1,
            will_retry: false,
            duration_ms: Date.now() - started,
            request_bytes: Buffer.byteLength(body),
            response_bytes: Buffer.byteLength(text),
            principal_id: context.analyticsPrincipalId,
            trace_id: context.trace?.traceId,
            parent_span_id: context.trace?.spanId,
            trace_sampled: context.trace?.sampled
          }, context.eventObserver);
          return kind === "mutation"
            ? new MutationReceipt(payload as T, model, method, mutationOptions!.reconciliation)
            : payload as T;
        } catch (error) {
          const cancelled = options.signal?.aborted === true;
          const typed = error instanceof OdooError
            ? error
            : new OdooError(
                cancelled ? "Odoo request was cancelled" : "Odoo request did not complete",
                cancelled ? "cancelled" : error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error",
                null,
                model,
                method,
                !cancelled,
                kind === "mutation" ? "unknown" : "not_applied",
                undefined,
                kind,
                kind === "mutation" ? "completion_ambiguous" : undefined,
                mutationOptions?.reconciliation,
                mutationOptions
                  ? knownFacts(mutationOptions.reconciliation, { requestSent: "unknown", responseReceived: "no", resultReceived: "no" })
                  : undefined
              );
          const willRetry = kind === "read" && typed.retryable && !cancelled && attempt < maximumAttempts;
          emitEvent("odoo.call.completed", {
            request_id: context.requestId,
            correlation_id: context.correlationId,
            target_id: context.principal.targetId,
            model,
            method,
            effect: kind,
            attempt,
            status: typed.code,
            retry: attempt > 1,
            will_retry: willRetry,
            duration_ms: Date.now() - started,
            request_bytes: Buffer.byteLength(body),
            principal_id: context.analyticsPrincipalId,
            trace_id: context.trace?.traceId,
            parent_span_id: context.trace?.spanId,
            trace_sampled: context.trace?.sampled
          }, context.eventObserver);
          if (willRetry) {
            await delay(250 * 2 ** (attempt - 1), options.signal);
            continue;
          }
          throw typed;
        }
      }
      throw new OdooError(
        "Odoo request exhausted its retry budget",
        "unknown",
        null,
        model,
        method,
        false,
        kind === "mutation" ? "unknown" : "not_applied",
        undefined,
        kind,
        kind === "mutation" ? "completion_ambiguous" : undefined,
        mutationOptions?.reconciliation,
        mutationOptions
          ? knownFacts(mutationOptions.reconciliation, { requestSent: "unknown", responseReceived: "no", resultReceived: "no" })
          : undefined
      );
    }, options.signal);
  }

  async fetchApiDocument<T>(
    context: RequestContext,
    model?: string,
    signal?: AbortSignal,
    options: ApiDocumentOptions = {}
  ): Promise<T> {
    const path = model ? `/doc-bearer/${encodeURIComponent(ModelNameSchema.parse(model))}.json` : "/doc-bearer/index.json";
    const identity = createHash("sha256")
      .update(`${context.principal.targetId}\0${context.principal.database}\0${context.principal.apiKey}`)
      .digest("base64url");
    const cacheKey = `${identity}:${path}`;
    const cached = this.apiDocumentCache.get(cacheKey);
    if (!options.forceRevalidate && cached && cached.expiresAt > Date.now()) {
      this.apiDocumentCache.delete(cacheKey);
      this.apiDocumentCache.set(cacheKey, cached);
      return cached.value as T;
    }
    if (cached) this.apiDocumentCache.delete(cacheKey);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${context.principal.apiKey}`,
      "X-Odoo-Database": context.principal.database,
      Accept: "application/json",
      ...injectTraceHeaders(context.trace?.context)
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await this.runForTarget(
      context,
      options.priority ?? "foreground",
      async () => await this.fetcher(`${context.principal.internalOrigin}${path}`, {
        headers,
        redirect: "manual",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)])
          : AbortSignal.timeout(options.timeoutMs ?? 30_000)
      }),
      signal
    );
    if (response.status === 304 && cached) {
      cached.expiresAt = Date.now() + API_DOCUMENT_CACHE_TTL_MS;
      this.apiDocumentCache.delete(cacheKey);
      this.apiDocumentCache.set(cacheKey, cached);
      return cached.value as T;
    }
    if (!response.ok) {
      throw new OdooError(
        `Authenticated Odoo API documentation is unavailable (${response.status})`,
        statusCode(response.status),
        response.status,
        "api_doc",
        path,
        false,
        "not_applied"
      );
    }
    const text = await boundedText(response, 2 * 1024 * 1024, "api_doc", path);
    const value = JSON.parse(text) as T;
    this.apiDocumentCache.set(cacheKey, {
      ...(response.headers.get("ETag") ? { etag: response.headers.get("ETag") ?? undefined } : {}),
      expiresAt: Date.now() + API_DOCUMENT_CACHE_TTL_MS,
      value
    });
    for (const [key, entry] of this.apiDocumentCache) {
      if (entry.expiresAt <= Date.now()) this.apiDocumentCache.delete(key);
    }
    while (this.apiDocumentCache.size > API_DOCUMENT_CACHE_MAX_ENTRIES) {
      const oldest = this.apiDocumentCache.keys().next().value as string | undefined;
      if (oldest) this.apiDocumentCache.delete(oldest);
      else break;
    }
    return value;
  }

  async discoverSurface(
    context: RequestContext,
    signal?: AbortSignal,
    options: ApiDocumentOptions = {}
  ): Promise<OdooSurface | null> {
    try {
      const document = await this.fetchApiDocument<{ modules?: unknown; models?: unknown }>(
        context,
        undefined,
        signal,
        options
      );
      const modules = new Set(
        Array.isArray(document.modules)
          ? document.modules.filter((item): item is string => typeof item === "string")
          : []
      );
      const publicMethods = new Map<string, ReadonlySet<string>>();
      const modelAccess = new Map<string, OdooModelAccess>();
      if (Array.isArray(document.models)) {
        for (const item of document.models) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const candidate = item as Record<string, unknown>;
          if (typeof candidate.model !== "string") continue;
          if (Array.isArray(candidate.methods)) {
            publicMethods.set(candidate.model, new Set(
              candidate.methods.filter((method): method is string => typeof method === "string")
            ));
          }
          const access = candidate.access;
          if (access && typeof access === "object" && !Array.isArray(access)) {
            const values = access as Record<string, unknown>;
            if (["read", "create", "write", "unlink"].every((operation) => typeof values[operation] === "boolean")) {
              modelAccess.set(candidate.model, {
                read: values.read as boolean,
                create: values.create as boolean,
                write: values.write as boolean,
                unlink: values.unlink as boolean
              });
            }
          }
        }
      }
      return { modules, publicMethods, modelAccess };
    } catch {
      return null;
    }
  }

  async installedModules(context: RequestContext, signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
    return (await this.discoverSurface(context, signal))?.modules ?? null;
  }
}

export function toolFailureFromError(error: unknown) {
  if (error instanceof OdooError) {
    if (error.policyCode) {
      return {
        code: error.policyCode,
        message: error.message,
        retryable: false,
        outcome: error.mutationOutcome,
        recovery:
          error.policyCode === "agent_suspended"
            ? "Ask the Agent owner to review and reactivate the Agent."
            : error.policyCode === "agent_authority_reduced"
              ? "Ask the Agent owner to review its reduced companies and application access."
              : error.policyCode === "agent_read_only_action_denied"
                ? "Use a read or approved collaboration capability, or ask the owner to grant read/write access for this application."
              : "Use a permitted recoverable workflow or ask the accountable human to perform the operation."
      } as const;
    }
    const unknownMutation = error.callKind === "mutation" && error.mutationOutcome === "unknown";
    const retryGuidance = unknownMutation
      ? "reconcile_first"
      : error.code === "permission_denied" || error.code === "invalid_request"
        ? "after_correction"
        : error.retryable
          ? "safe"
          : "never";
    return {
      code: `ODOO_${error.code.toUpperCase()}`,
      message: error.message,
      retryable: unknownMutation ? false : error.retryable,
      condition_retryable: error.retryable,
      outcome: error.mutationOutcome,
      retry_guidance: retryGuidance,
      ...(error.mutationStage ? { stage: error.mutationStage } : {}),
      ...(error.known ? {
        known: {
          request_sent: error.known.requestSent,
          response_received: error.known.responseReceived,
          result_received: error.known.resultReceived,
          target_model: error.known.targetModel,
          ...(error.known.knownIds ? { record_ids: [...error.known.knownIds] } : {}),
          ...(error.known.grantId ? { grant_id: error.known.grantId } : {})
        }
      } : {}),
      ...(unknownMutation && error.reconciliation ? {
        reconciliation: {
          required: true as const,
          suggested_tool: error.reconciliation.suggestedTool,
          target_model: error.reconciliation.targetModel,
          ...(error.known?.knownIds ? { record_ids: [...error.known.knownIds] } : {}),
          ...(error.reconciliation.fields ? { fields: [...error.reconciliation.fields] } : {}),
          instructions: error.reconciliation.instructions
        }
      } : {}),
      recovery:
        unknownMutation
          ? "Do not repeat the mutation yet. Run the reconciliation read, compare current Odoo state with the intended change, then either stop, retry only if absent, or send a minimal corrective patch."
          : error.code === "permission_denied"
          ? "Use an Odoo identity with the required access or narrow the requested records."
          : error.code === "model_or_method_not_found"
            ? "Inspect the model and public method metadata, then correct the request."
            : error.retryable
              ? "Retry the read after the reported condition clears. Reconcile mutations before retrying."
              : "Correct the request or inspect the model metadata before retrying."
    } as const;
  }
  return {
    code: "ODOO_TOOL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    condition_retryable: false,
    outcome: "not_applied" as const,
    retry_guidance: "after_correction" as const,
    stage: "preflight" as const,
    known: {
      request_sent: "no" as const,
      response_received: "no" as const,
      result_received: "no" as const
    },
    recovery: "Inspect the capability and model metadata, correct the request, then retry."
  };
}
