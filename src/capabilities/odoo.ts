import { z } from "zod";
import { callOdoo, OdooError, readBoundedText } from "../odoo.js";
import type { RequestContext } from "../runtime/context.js";

const MODEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

export const ModelNameSchema = z.string().regex(MODEL_PATTERN);
export const FieldNameSchema = z.string().regex(FIELD_PATTERN);
export const MethodNameSchema = z.string().regex(METHOD_PATTERN);
export const PositiveIdSchema = z.number().int().positive();

export interface RecordRef {
  model: string;
  id: number;
  display_name: string;
  url: string;
}

export function recordRef(context: RequestContext, model: string, record: Record<string, unknown>): RecordRef | null {
  const id = record.id;
  if (!Number.isInteger(id) || (id as number) <= 0) return null;
  const display = record.display_name ?? record.name ?? `${model},${id}`;
  return {
    model,
    id: id as number,
    display_name: typeof display === "string" ? display : String(display),
    url: `${context.principal.publicOrigin.replace(/\/+$/, "")}/odoo/${model}/${id}`
  };
}

export async function odooCall<T>(
  context: RequestContext,
  model: string,
  method: string,
  args: Record<string, unknown>,
  options: { mutation?: boolean; idempotencyKey?: string; responseBytes?: number } = {}
): Promise<T> {
  return await callOdoo(context.principal.connection, model, method, args, {
    maxAttempts: options.mutation ? 1 : 3,
    retryTimeouts: !options.mutation,
    retryNetworkErrors: !options.mutation,
    idempotencyKey: options.idempotencyKey,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: options.responseBytes ?? 1024 * 1024
  }) as T;
}

export async function fetchApiDocument<T>(context: RequestContext, model?: string): Promise<T> {
  const path = model ? `/doc-bearer/${encodeURIComponent(model)}.json` : "/doc-bearer/index.json";
  const response = await fetch(`${context.principal.connection.url}${path}`, {
    headers: {
      Authorization: `Bearer ${context.principal.connection.apiKey}`,
      "X-Odoo-Database": context.principal.connection.db,
      Accept: "application/json"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    throw new OdooError({
      message: `Odoo API documentation request failed (${response.status})`,
      code: response.status === 401 ? "unauthorized" : response.status === 403 ? "permission_denied" : "invalid_request",
      httpStatus: response.status,
      model: "api_doc",
      method: path,
      details: "Authenticated Odoo API documentation is unavailable.",
      mutationOutcome: "not_applied"
    });
  }
  return JSON.parse(await readBoundedText(response, 2 * 1024 * 1024, "api_doc", path)) as T;
}

function inspectJson(value: unknown, depth: number, state: { keys: number }): void {
  if (depth > 8) throw new Error("JSON arguments may not exceed 8 levels of nesting");
  if (Array.isArray(value)) {
    for (const item of value) inspectJson(item, depth + 1, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    state.keys++;
    if (state.keys > 200) throw new Error("JSON arguments may not contain more than 200 object keys");
    if (key.length > 128) throw new Error("JSON argument keys may not exceed 128 characters");
    inspectJson(item, depth + 1, state);
  }
}

export function assertBoundedJson(value: unknown): void {
  inspectJson(value, 0, { keys: 0 });
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
    throw new Error("JSON arguments exceed the 256 KiB limit");
  }
}

export function assertBoundedDomain(domain: unknown): asserts domain is unknown[] {
  if (!Array.isArray(domain)) throw new Error("domain must be an Odoo domain array");
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) throw new Error("domain may not exceed 8 levels of nesting");
    nodes++;
    if (nodes > 200) throw new Error("domain may not exceed 200 nodes");
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    }
  };
  visit(domain, 0);
}

export interface CursorPayload {
  offset: number;
  order: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined, expectedOrder: string): CursorPayload {
  if (!value) return { offset: 0, order: expectedOrder };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is malformed");
  }
  const schema = z.object({ offset: z.number().int().nonnegative(), order: z.string() }).strict();
  const cursor = schema.parse(parsed);
  if (cursor.order !== expectedOrder) throw new Error("cursor does not match the requested order");
  return cursor;
}

export type MethodEffect = "read" | "write" | "consequential" | "irreversible" | "unknown";

const READ_METHODS = /^(fields_get|search|search_count|search_read|read|read_group|formatted_read_group|name_get|name_search|get_|mcp_get|mcp_list|mcp_search|preview_|check_)/;
const CONSEQUENTIAL_METHODS = /(^|_)(post|approve|validate|reconcile|submit|confirm|pay)(_|$)/;

export async function classifyPublicMethod(context: RequestContext, model: string, method: string): Promise<MethodEffect> {
  try {
    const classified = await odooCall<{ effect?: unknown }>(
      context,
      "usl.mcp.policy",
      "describe_method",
      { model, method },
      { responseBytes: 64 * 1024 }
    );
    if (["read", "write", "consequential", "irreversible", "unknown"].includes(String(classified.effect))) {
      return classified.effect as MethodEffect;
    }
  } catch {
    // The integration metadata addon is additive. Older Distribution builds
    // still retain the complete public JSON-2 escape hatch.
  }
  if (method === "unlink") return "irreversible";
  if (READ_METHODS.test(method)) return "read";
  if (CONSEQUENTIAL_METHODS.test(method)) return "consequential";
  return "unknown";
}
