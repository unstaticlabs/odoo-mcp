const ODOO_TIMEOUT_MS = 15_000;
const ODOO_MAX_ATTEMPTS = 3;
const ODOO_RETRY_DELAY_MS = 500;
const ODOO_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface OdooConnection {
  url: string;
  db: string;
  apiKey: string;
}

/** Odoo RPC context sent as the top-level `context` key of the JSON-2 request body.
 *  NOT the MCP write-audit `context` string (see tools/shared.ts zWriteContext), which is never sent to Odoo. */
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
  | "odoo_server_error"
  | "timeout"
  | "network_error"
  | "unknown";

const RECOVERABLE_CODES = new Set<OdooErrorCode>(["timeout", "rate_limited", "network_error"]);

/** Pure classification from HTTP status / failure kind to a stable, machine-readable error code. */
export function classifyOdooError(httpStatus: number | null, isTimeout: boolean, isNetworkError: boolean): OdooErrorCode {
  if (isTimeout) return "timeout";
  if (isNetworkError) return "network_error";
  if (httpStatus === 401) return "unauthorized";
  if (httpStatus === 403) return "permission_denied";
  if (httpStatus === 404) return "model_or_method_not_found";
  if (httpStatus === 400) return "invalid_request";
  if (httpStatus === 429) return "rate_limited";
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
}

/** Thrown by callOdoo on every failure path so tool handlers can classify errors instead of pattern-matching strings. */
export class OdooError extends Error {
  code: OdooErrorCode;
  httpStatus: number | null;
  model: string;
  method: string;
  details: string;
  recoverable: boolean;

  constructor(params: OdooErrorParams) {
    super(params.message);
    this.name = "OdooError";
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.model = params.model;
    this.method = params.method;
    this.details = params.details;
    this.recoverable = params.recoverable ?? isRecoverable(params.code);
  }
}

function extractOdooErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === "string") return errorRecord.message;
    const data = errorRecord.data;
    if (data && typeof data === "object") {
      const message = (data as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  if (typeof record.message === "string") return record.message;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin Odoo JSON-2 client. Never logs or echoes the caller's API key.
 *
 * `args` is serialized verbatim as the JSON-2 request body, so a `context` key in `args`
 * is forwarded to Odoo as the RPC context (see `companyRpcContext` for multi-company use).
 * That is unrelated to the MCP write-audit `context` argument, which never reaches Odoo.
 */
export async function callOdoo(
  conn: OdooConnection,
  model: string,
  method: string,
  args: Record<string, unknown>,
  timeoutMs: number = ODOO_TIMEOUT_MS
): Promise<unknown> {
  const endpoint = `${conn.url.replace(/\/+$/, "")}/json/2/${model}/${method}`;

  for (let attempt = 1; attempt <= ODOO_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${conn.apiKey}`,
          "X-Odoo-Database": conn.db,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(args),
        signal: controller.signal
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < ODOO_MAX_ATTEMPTS) {
          continue;
        }
        const message = `Odoo request to ${model}.${method} timed out after ${timeoutMs}ms`;
        throw new OdooError({
          message,
          code: "timeout",
          httpStatus: null,
          model,
          method,
          details: message,
          recoverable: true
        });
      }
      const message = `Odoo request to ${model}.${method} failed: network error`;
      throw new OdooError({
        message,
        code: "network_error",
        httpStatus: null,
        model,
        method,
        details: message,
        recoverable: true
      });
    } finally {
      clearTimeout(timer);
    }

    if (ODOO_RETRYABLE_STATUS.has(response.status) && attempt < ODOO_MAX_ATTEMPTS) {
      await sleep(ODOO_RETRY_DELAY_MS);
      continue;
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const detail = extractOdooErrorMessage(payload) ?? response.statusText;
      throw new OdooError({
        message: `Odoo ${model}.${method} failed (${response.status}): ${detail}`,
        code: classifyOdooError(response.status, false, false),
        httpStatus: response.status,
        model,
        method,
        details: detail
      });
    }

    if (payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)) {
      const detail = extractOdooErrorMessage(payload) ?? "unknown error";
      throw new OdooError({
        message: `Odoo ${model}.${method} returned an error: ${detail}`,
        code: "unknown",
        httpStatus: response.status,
        model,
        method,
        details: detail
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
