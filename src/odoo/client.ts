import { createHash } from "node:crypto";
import type { RequestContext } from "../runtime/context.js";
import { emitEvent } from "../runtime/logging.js";
import { Semaphore } from "../runtime/semaphore.js";
import { assertBoundedJson, ModelNameSchema, MethodNameSchema } from "./schemas.js";

export type OdooCallKind = "read" | "mutation";
export type MutationOutcome = "not_applied" | "unknown";

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
    readonly details?: string
  ) {
    super(message);
    this.name = "OdooError";
  }
}

interface CallOptions {
  kind?: OdooCallKind;
  signal?: AbortSignal;
  timeoutMs?: number;
  responseBytes?: number;
}

interface ApiDocumentCacheEntry {
  etag?: string;
  expiresAt: number;
  value: unknown;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

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

async function boundedText(response: Response, maximum: number, model: string, method: string): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new OdooError("Odoo response exceeded its size limit", "payload_too_large", response.status, model, method, false, "unknown");
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
        throw new OdooError("Odoo response exceeded its size limit", "payload_too_large", response.status, model, method, false, "unknown");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OdooError) throw error;
    throw new OdooError("Odoo response ended before completion", "network_error", response.status, model, method, true, "unknown");
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
  private readonly apiDocumentCache = new Map<string, ApiDocumentCacheEntry>();
  private readonly moduleCache = new Map<string, { expiresAt: number; modules: ReadonlySet<string> | null }>();

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

  async call<T>(
    context: RequestContext,
    model: string,
    method: string,
    kwargs: Record<string, unknown>,
    options: CallOptions = {}
  ): Promise<T> {
    ModelNameSchema.parse(model);
    MethodNameSchema.parse(method);
    assertBoundedJson(kwargs);
    const kind = options.kind ?? "read";
    const maximumAttempts = kind === "read" ? 3 : 1;
    const responseBytes = options.responseBytes ?? this.defaultResponseBytes;
    const body = JSON.stringify(kwargs);

    return await this.semaphore(context.principal.targetId).run(async () => {
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
          request_bytes: Buffer.byteLength(body)
        });
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
                "User-Agent": "usl-odoo-mcp/2"
              },
              redirect: "manual",
              body,
              signal
            }
          );
          const text = await boundedText(response, responseBytes, model, method);
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
              detail
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
              kind === "mutation" ? "unknown" : "not_applied"
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
            duration_ms: Date.now() - started,
            response_bytes: Buffer.byteLength(text)
          });
          return payload as T;
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
                kind === "mutation" ? "unknown" : "not_applied"
              );
          emitEvent("odoo.call.completed", {
            request_id: context.requestId,
            correlation_id: context.correlationId,
            target_id: context.principal.targetId,
            model,
            method,
            effect: kind,
            attempt,
            status: typed.code,
            duration_ms: Date.now() - started
          });
          if (kind === "read" && typed.retryable && !cancelled && attempt < maximumAttempts) {
            await delay(250 * 2 ** (attempt - 1), options.signal);
            continue;
          }
          throw typed;
        }
      }
      throw new OdooError("Odoo request exhausted its retry budget", "unknown", null, model, method, false, kind === "mutation" ? "unknown" : "not_applied");
    }, options.signal);
  }

  async fetchApiDocument<T>(context: RequestContext, model?: string, signal?: AbortSignal): Promise<T> {
    const path = model ? `/doc-bearer/${encodeURIComponent(ModelNameSchema.parse(model))}.json` : "/doc-bearer/index.json";
    const identity = createHash("sha256")
      .update(`${context.principal.targetId}\0${context.principal.database}\0${context.principal.apiKey}`)
      .digest("base64url");
    const cacheKey = `${identity}:${path}`;
    const cached = this.apiDocumentCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${context.principal.apiKey}`,
      "X-Odoo-Database": context.principal.database,
      Accept: "application/json"
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await this.fetcher(`${context.principal.internalOrigin}${path}`, {
      headers,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)
    });
    if (response.status === 304 && cached) {
      cached.expiresAt = Date.now() + 5 * 60_000;
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
      expiresAt: Date.now() + 5 * 60_000,
      value
    });
    if (this.apiDocumentCache.size > 50) {
      const oldest = this.apiDocumentCache.keys().next().value as string | undefined;
      if (oldest) this.apiDocumentCache.delete(oldest);
    }
    return value;
  }

  async installedModules(context: RequestContext, signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
    const identity = createHash("sha256")
      .update(`${context.principal.targetId}\0${context.principal.database}\0${context.principal.apiKey}`)
      .digest("base64url");
    const cached = this.moduleCache.get(identity);
    if (cached && cached.expiresAt > Date.now()) return cached.modules;
    try {
      const document = await this.fetchApiDocument<{ modules?: unknown }>(context, undefined, signal);
      const modules = new Set(
        Array.isArray(document.modules)
          ? document.modules.filter((item): item is string => typeof item === "string")
          : []
      );
      this.moduleCache.set(identity, { expiresAt: Date.now() + 5 * 60_000, modules });
      return modules;
    } catch {
      this.moduleCache.set(identity, { expiresAt: Date.now() + 60_000, modules: null });
      return null;
    }
  }
}

export function toolFailureFromError(error: unknown) {
  if (error instanceof OdooError) {
    return {
      code: `ODOO_${error.code.toUpperCase()}`,
      message: error.message,
      retryable: error.retryable,
      outcome: error.mutationOutcome,
      recovery:
        error.code === "permission_denied"
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
    outcome: "not_applied" as const,
    recovery: "Inspect the capability and model metadata, correct the request, then retry."
  };
}
