const ODOO_TIMEOUT_MS = 15_000;
const ODOO_MAX_ATTEMPTS = 3;
const ODOO_RETRY_DELAY_MS = 500;
const ODOO_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface OdooConnection {
  url: string;
  db: string;
  apiKey: string;
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

/** Thin Odoo JSON-2 client. Never logs or echoes the caller's API key. */
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
