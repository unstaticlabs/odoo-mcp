const ODOO_TIMEOUT_MS = 15_000;
const ODOO_MAX_ATTEMPTS = 3;
const ODOO_RETRY_DELAY_MS = 1_000;
const ODOO_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 16 * 1024 * 1024;
const ODOO_MODEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/;
const ODOO_PUBLIC_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

export interface OdooConnection {
  url: string;
  db: string;
  apiKey: string;
  authMode?: "header" | "oauth";
}

export interface OdooResponseMetadata {
  idempotencyStatus?: "created" | "replayed";
  idempotencyExpiresAt?: string;
}

/** Per-call resilience policy. Expensive read facades can use a longer timeout
 * without blindly replaying work whose first attempt may still be running. */
export interface OdooCallOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  retryTimeouts?: boolean;
  retryNetworkErrors?: boolean;
  /** Route one physical attempt. Used by the origin Durable Object facade. */
  fetcher?: typeof fetch;
  /** Odoo-atomic key. The same value is retained across every retry attempt. */
  idempotencyKey?: string;
  /** Bound buffered JSON responses before parsing. */
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  onResponseMetadata?: (metadata: OdooResponseMetadata) => void;
}

interface NormalizedOdooCallOptions {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  retryTimeouts: boolean;
  retryNetworkErrors: boolean;
  fetcher: typeof fetch;
  idempotencyKey?: string;
  maxResponseBytes: number;
  maxRequestBytes: number;
  onResponseMetadata?: (metadata: OdooResponseMetadata) => void;
}

function normalizeCallOptions(options: number | OdooCallOptions | undefined): NormalizedOdooCallOptions {
  if (typeof options === "number") {
    return {
      timeoutMs: options,
      maxAttempts: ODOO_MAX_ATTEMPTS,
      retryDelayMs: ODOO_RETRY_DELAY_MS,
      retryTimeouts: true,
      retryNetworkErrors: false,
      fetcher: fetch,
      maxResponseBytes: DEFAULT_RESPONSE_BYTES,
      maxRequestBytes: DEFAULT_REQUEST_BYTES
    };
  }
  return {
    timeoutMs: options?.timeoutMs ?? ODOO_TIMEOUT_MS,
    maxAttempts: Math.max(1, Math.min(options?.maxAttempts ?? ODOO_MAX_ATTEMPTS, 5)),
    retryDelayMs: Math.max(0, options?.retryDelayMs ?? ODOO_RETRY_DELAY_MS),
    retryTimeouts: options?.retryTimeouts ?? true,
    retryNetworkErrors: options?.retryNetworkErrors ?? false,
    fetcher: options?.fetcher ?? fetch,
    idempotencyKey: options?.idempotencyKey,
    maxResponseBytes: Math.max(1, options?.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES),
    maxRequestBytes: Math.max(1, options?.maxRequestBytes ?? DEFAULT_REQUEST_BYTES),
    onResponseMetadata: options?.onResponseMetadata
  };
}

function retryBackoffMs(baseMs: number, attempt: number): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(30_000, Math.ceil(exponential * (1 + Math.random() * 0.2)));
}

function retryAfterMs(response: Response, fallbackMs: number): number {
  const raw = response.headers.get("Retry-After");
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.max(fallbackMs, seconds * 1000));
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return fallbackMs;
  return Math.min(30_000, Math.max(fallbackMs, dateMs - Date.now()));
}

/** Odoo RPC context sent as the top-level `context` key of the JSON-2 request body. */
export type OdooRpcContext = Record<string, unknown>;

/**
 * Multi-company RPC context. Odoo 19 record rules on account.account / account.move.line
 * are evaluated against `allowed_company_ids`; a company_id domain leaf alone cannot see
 * records of a company outside the user's default allowed set.
 */
export function companyRpcContext(companyId: number): { allowed_company_ids: number[]; company_id: number } {
  return { allowed_company_ids: [companyId], company_id: companyId };
}

/**
 * Multi-company RPC context spanning several companies at once: moving a draft record between
 * legal entities needs BOTH the source and the target company visible in the same call.
 * `activeCompanyId` is the company that company-dependent defaults resolve against.
 */
export function companiesRpcContext(
  companyIds: number[],
  activeCompanyId: number
): { allowed_company_ids: number[]; company_id: number } {
  return { allowed_company_ids: [...new Set(companyIds)], company_id: activeCompanyId };
}

export type OdooErrorCode =
  | "unauthorized"
  | "permission_denied"
  | "model_or_method_not_found"
  | "invalid_request"
  | "rate_limited"
  | "origin_busy"
  | "idempotency_conflict"
  | "payload_too_large"
  | "odoo_server_error"
  | "timeout"
  | "network_error"
  | "unknown";

const RECOVERABLE_CODES = new Set<OdooErrorCode>([
  "timeout",
  "rate_limited",
  "network_error",
  "origin_busy",
  "odoo_server_error"
]);

/** Pure classification from HTTP status / failure kind to a stable, machine-readable error code. */
export function classifyOdooError(httpStatus: number | null, isTimeout: boolean, isNetworkError: boolean): OdooErrorCode {
  if (isTimeout) return "timeout";
  if (isNetworkError) return "network_error";
  if (httpStatus === 401) return "unauthorized";
  if (httpStatus === 403) return "permission_denied";
  if (httpStatus === 404) return "model_or_method_not_found";
  if (httpStatus === 400) return "invalid_request";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 409) return "idempotency_conflict";
  if (httpStatus !== null && httpStatus >= 500 && httpStatus < 600) return "odoo_server_error";
  return "unknown";
}

export function isRecoverable(code: OdooErrorCode): boolean {
  return RECOVERABLE_CODES.has(code);
}

/** Domain-specific diagnosis for `read_group` / aggregate_records failures. */
export type AggregationDiagnosisCode =
  | "unsupported_model"
  | "invalid_groupby"
  | "permission_denied"
  | "unsupported_aggregate"
  | "connector_bug";

export type AggregationErrorContext = {
  model: string;
  method: "read_group" | "formatted_read_group";
  httpStatus: number;
  /** Normalized lowercase details for pattern matching. */
  details: string;
  odooCode?: OdooErrorCode;
};

/** Trim, lowercase, and collapse runs of whitespace for stable payload matching. */
export function normalizeOdooDetails(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Substring patterns observed in Odoo 17+ JSON-2 `read_group` groupby errors. */
export const GROUPBY_ERROR_PATTERNS: readonly string[] = [
  "invalid field",
  "unknown field",
  "groupby",
  "group by",
  "not groupable",
  "cannot group",
  "invalid groupby"
];

/** Substring patterns for aggregate-function errors (evaluated after groupby patterns). */
export const AGGREGATE_ERROR_PATTERNS: readonly string[] = [
  "invalid aggregator",
  "invalid aggregate",
  "aggregation function"
];

const AGGREGATE_FIELD_SPEC_SUFFIXES = [":sum", ":avg", ":count", ":min", ":max"] as const;
const AGGREGATE_NOT_SUPPORTED_FUNCS = ["sum", "avg", "count", "min", "max"] as const;

/** True when normalized Odoo payload text indicates an invalid groupby field. */
export function matchInvalidGroupby(details: string): boolean {
  const normalized = normalizeOdooDetails(details);
  for (const pattern of GROUPBY_ERROR_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }
  if (/field "[^"]+" (does not exist|is not a valid field)/.test(normalized)) return true;
  return false;
}

/** True when normalized Odoo payload text indicates an unsupported aggregate function. */
export function matchUnsupportedAggregate(details: string): boolean {
  const normalized = normalizeOdooDetails(details);
  for (const pattern of AGGREGATE_ERROR_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }
  if (AGGREGATE_FIELD_SPEC_SUFFIXES.some((suffix) => normalized.includes(suffix))) return true;
  if (normalized.includes("not supported")) {
    if (AGGREGATE_NOT_SUPPORTED_FUNCS.some((fn) => normalized.includes(fn))) return true;
  }
  return false;
}

/**
 * Map HTTP status + Odoo payload patterns to an aggregation diagnosis code.
 * Evaluated in priority order; first match wins. Does not alter {@link classifyOdooError}.
 */
export function classifyAggregationDiagnosis(
  ctx: AggregationErrorContext
): AggregationDiagnosisCode | "unauthorized" | "permission_denied" {
  if (ctx.httpStatus === 401) return "unauthorized";
  if (ctx.httpStatus === 403) return "permission_denied";
  if (ctx.httpStatus === 404 && (ctx.method === "read_group" || ctx.method === "formatted_read_group")) return "unsupported_model";
  if (ctx.httpStatus === 400) {
    if (matchInvalidGroupby(ctx.details)) return "invalid_groupby";
    if (matchUnsupportedAggregate(ctx.details)) return "unsupported_aggregate";
    return "connector_bug";
  }
  return "connector_bug";
}

/** Convenience wrapper that builds context from a thrown {@link OdooError}. */
export function aggregationDiagnosisFromOdooError(
  err: OdooError,
  ctx: { model: string; method?: "read_group" | "formatted_read_group" }
): AggregationDiagnosisCode | "unauthorized" | "permission_denied" {
  const method = ctx.method ?? (err.method === "formatted_read_group" ? "formatted_read_group" : "read_group");
  return classifyAggregationDiagnosis({
    model: ctx.model,
    method,
    httpStatus: err.httpStatus ?? 0,
    details: normalizeOdooDetails(err.details),
    odooCode: err.code
  });
}

export interface OdooErrorParams {
  message: string;
  code: OdooErrorCode;
  httpStatus: number | null;
  model: string;
  method: string;
  details: string;
  recoverable?: boolean;
  denialKind?: OdooDenialKind;
  /** Whether an attempted mutation is known not to have committed. */
  mutationOutcome?: "not_applied" | "unknown";
}

export type OdooDenialKind = "acl" | "record_rule" | "business_validation" | "irreversible_policy";

/** Thrown by callOdoo on every failure path so tool handlers can classify errors instead of pattern-matching strings. */
export class OdooError extends Error {
  code: OdooErrorCode;
  httpStatus: number | null;
  model: string;
  method: string;
  details: string;
  recoverable: boolean;
  denialKind?: OdooDenialKind;
  mutationOutcome: "not_applied" | "unknown";

  constructor(params: OdooErrorParams) {
    super(params.message);
    this.name = "OdooError";
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.model = params.model;
    this.method = params.method;
    this.details = params.details;
    this.recoverable = params.recoverable ?? isRecoverable(params.code);
    this.denialKind = params.denialKind;
    this.mutationOutcome = params.mutationOutcome ?? "unknown";
  }
}

interface OdooErrorDescriptor {
  message?: string;
  name?: string;
}

function extractOdooErrorDescriptor(payload: unknown): OdooErrorDescriptor {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    const directName = typeof errorRecord.name === "string" ? errorRecord.name : undefined;
    if (typeof errorRecord.message === "string") return { message: errorRecord.message, name: directName };
    const data = errorRecord.data;
    if (data && typeof data === "object") {
      const dataRecord = data as Record<string, unknown>;
      const message = dataRecord.message;
      const name = typeof dataRecord.name === "string" ? dataRecord.name : directName;
      if (typeof message === "string") return { message, name };
    }
  }
  return {
    message: typeof record.message === "string" ? record.message : undefined,
    name: typeof record.name === "string" ? record.name : undefined
  };
}

function extractTransportErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function classifyOdooDenial(descriptor: OdooErrorDescriptor): OdooDenialKind | undefined {
  const haystack = `${descriptor.name ?? ""} ${descriptor.message ?? ""}`.toLowerCase();
  if (haystack.includes("irreversible") || haystack.includes("usl_access_control")) return "irreversible_policy";
  if (
    haystack.includes("record rule") ||
    haystack.includes("record rules") ||
    haystack.includes("due to security restrictions")
  ) return "record_rule";
  if (haystack.includes("accesserror") || haystack.includes("access error") || haystack.includes("permission")) return "acl";
  if (
    haystack.includes("validationerror") ||
    haystack.includes("usererror") ||
    haystack.includes("business validation") ||
    haystack.includes("validation error")
  ) {
    return "business_validation";
  }
  return undefined;
}

export async function readBoundedText(response: Response, limit: number, model: string, method: string): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel("response size limit exceeded");
    throw new OdooError({
      message: `Odoo response exceeded the ${limit}-byte limit`,
      code: "payload_too_large",
      httpStatus: response.status,
      model,
      method,
      details: `Odoo response exceeded the ${limit}-byte limit`,
      mutationOutcome: "unknown"
    });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel("response size limit exceeded");
        throw new OdooError({
          message: `Odoo response exceeded the ${limit}-byte limit`,
          code: "payload_too_large",
          httpStatus: response.status,
          model,
          method,
          details: `Odoo response exceeded the ${limit}-byte limit`,
          mutationOutcome: "unknown"
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OdooError) throw error;
    throw new OdooError({
      message: `Odoo response stream for ${model}.${method} failed`,
      code: "network_error",
      httpStatus: response.status,
      model,
      method,
      details: "Odoo response stream failed before a complete result was received.",
      recoverable: true,
      mutationOutcome: "unknown"
    });
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin Odoo JSON-2 client. Never logs or echoes the caller's API key.
 *
 * `args` is serialized verbatim as the JSON-2 request body, so a `context` key in `args`
 * is forwarded to Odoo as the RPC context (see `companyRpcContext` for multi-company use).
 * Mutation callers merge `reason` and reserved connector attribution into this
 * Odoo context before calling this transport primitive.
 */
export async function callOdoo(
  conn: OdooConnection,
  model: string,
  method: string,
  args: Record<string, unknown>,
  options?: number | OdooCallOptions
): Promise<unknown> {
  if (!ODOO_MODEL_PATTERN.test(model) || !ODOO_PUBLIC_METHOD_PATTERN.test(method)) {
    throw new OdooError({
      message: "Odoo JSON-2 target contains an invalid model or public method identifier",
      code: "invalid_request",
      httpStatus: null,
      model,
      method,
      details: "Model names may contain letters, digits, underscores, and dots; public method names may contain letters, digits, and underscores and cannot start with an underscore.",
      recoverable: false,
      mutationOutcome: "not_applied"
    });
  }
  const policy = normalizeCallOptions(options);
  const endpoint = `${conn.url.replace(/\/+$/, "")}/json/2/${model}/${method}`;
  const body = JSON.stringify(args);
  const requestBytes = new TextEncoder().encode(body).byteLength;
  if (requestBytes > policy.maxRequestBytes) {
    throw new OdooError({
      message: `Odoo request exceeded the ${policy.maxRequestBytes}-byte limit`,
      code: "payload_too_large",
      httpStatus: null,
      model,
      method,
      details: `Odoo request exceeded the ${policy.maxRequestBytes}-byte limit`,
      mutationOutcome: "not_applied"
    });
  }

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

    let response: Response;
    try {
      response = await policy.fetcher(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${conn.apiKey}`,
          "X-Odoo-Database": conn.db,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(policy.idempotencyKey ? { "Idempotency-Key": policy.idempotencyKey } : {})
        },
        body,
        signal: controller.signal,
        redirect: "manual"
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (policy.retryTimeouts && attempt < policy.maxAttempts) {
          await sleep(retryBackoffMs(policy.retryDelayMs, attempt));
          continue;
        }
        const message = `Odoo request to ${model}.${method} timed out after ${policy.timeoutMs}ms`;
        throw new OdooError({
          message,
          code: "timeout",
          httpStatus: null,
          model,
          method,
          details: message,
          recoverable: true,
          mutationOutcome: "unknown"
        });
      }
      if (policy.retryNetworkErrors && attempt < policy.maxAttempts) {
        await sleep(retryBackoffMs(policy.retryDelayMs, attempt));
        continue;
      }
      const message = `Odoo request to ${model}.${method} failed: network error`;
      throw new OdooError({
        message,
        code: "network_error",
        httpStatus: null,
        model,
        method,
        details: message,
        recoverable: true,
        mutationOutcome: "unknown"
      });
    } finally {
      clearTimeout(timer);
    }

    if (ODOO_RETRYABLE_STATUS.has(response.status) && attempt < policy.maxAttempts) {
      await response.body?.cancel();
      await sleep(retryAfterMs(response, retryBackoffMs(policy.retryDelayMs, attempt)));
      continue;
    }

    const text = await readBoundedText(response, policy.maxResponseBytes, model, method);
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const descriptor = extractOdooErrorDescriptor(payload);
      const transportCode = extractTransportErrorCode(payload);
      const isRedirect = response.status >= 300 && response.status < 400;
      const detail = isRedirect
        ? "Credential-bearing JSON-2 redirects are refused; configure the final Odoo origin."
        : descriptor.message ?? transportCode ?? response.statusText;
      const code =
        response.status === 503 && transportCode === "origin_busy"
          ? "origin_busy"
          : isRedirect
            ? "invalid_request"
            : classifyOdooError(response.status, false, false);
      throw new OdooError({
        message: `Odoo ${model}.${method} failed (${response.status}): ${detail}`,
        code,
        httpStatus: response.status,
        model,
        method,
        details: detail,
        denialKind: classifyOdooDenial(descriptor),
        mutationOutcome: code === "origin_busy" ? "not_applied" : response.status >= 500 || isRedirect ? "unknown" : "not_applied"
      });
    }

    if (payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)) {
      const descriptor = extractOdooErrorDescriptor(payload);
      const detail = descriptor.message ?? "unknown error";
      throw new OdooError({
        message: `Odoo ${model}.${method} returned an error: ${detail}`,
        code: "unknown",
        httpStatus: response.status,
        model,
        method,
        details: detail,
        denialKind: classifyOdooDenial(descriptor),
        mutationOutcome: "not_applied"
      });
    }

    const status = response.headers.get("Idempotency-Status");
    if (status === "created" || status === "replayed") {
      policy.onResponseMetadata?.({
        idempotencyStatus: status,
        idempotencyExpiresAt: response.headers.get("Idempotency-Expires-At") ?? undefined
      });
    }

    if (payload && typeof payload === "object" && "result" in (payload as Record<string, unknown>)) {
      return (payload as Record<string, unknown>).result;
    }
    return payload;
  }

  throw new OdooError({
    message: `Odoo request to ${model}.${method} failed`,
    code: "unknown",
    httpStatus: null,
    model,
    method,
    details: `Odoo request to ${model}.${method} failed`
  });
}
