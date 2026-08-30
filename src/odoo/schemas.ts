import { createHash } from "node:crypto";
import { z } from "zod";

const MODEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

export const ModelNameSchema = z.string().regex(MODEL_PATTERN, "Invalid Odoo model name");
export const FieldNameSchema = z.string().regex(FIELD_PATTERN, "Invalid Odoo field name");
export const MethodNameSchema = z.string().regex(METHOD_PATTERN, "Invalid public Odoo method name");
export const PositiveIdSchema = z.number().int().positive();
export const FieldsSchema = z.array(FieldNameSchema).max(100);
export const OdooContextSchema = z.record(z.string().min(1).max(128), z.unknown()).default({});

function inspectJson(value: unknown, depth: number, state: { keys: number }): void {
  if (depth > 8) throw new Error("JSON may not exceed 8 levels of nesting");
  if (Array.isArray(value)) {
    for (const item of value) inspectJson(item, depth + 1, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    state.keys++;
    if (state.keys > 200) throw new Error("JSON may not contain more than 200 object keys");
    if (key.length > 128) throw new Error("JSON keys may not exceed 128 characters");
    inspectJson(item, depth + 1, state);
  }
}

export function assertBoundedJson(value: unknown, bytes = 256 * 1024): void {
  inspectJson(value, 0, { keys: 0 });
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw new Error(`JSON exceeds the ${bytes}-byte limit`);
}

export function assertBoundedDomain(domain: unknown): asserts domain is unknown[] {
  if (!Array.isArray(domain)) throw new Error("domain must be an Odoo domain array");
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) throw new Error("domain may not exceed 8 levels of nesting");
    nodes++;
    if (nodes > 200) throw new Error("domain may not exceed 200 nodes");
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
  };
  visit(domain, 0);
  assertBoundedJson(domain);
}

interface CursorPayload {
  offset: number;
  fingerprint: string;
}

export function queryFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 24);
}

export function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint } satisfies CursorPayload), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined, fingerprint: string): number {
  if (!value) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is malformed");
  }
  const cursor = z.object({
    offset: z.number().int().nonnegative().max(10_000_000),
    fingerprint: z.string()
  }).strict().parse(parsed);
  if (cursor.fingerprint !== fingerprint) throw new Error("cursor does not match this query");
  return cursor.offset;
}

const RESERVED_CONTEXT_KEYS = new Set([
  "usl_agent_origin",
  "usl_correlation_id",
  "usl_idempotency_key",
  "usl_idempotency_mode"
]);

export function attributedContext(
  requested: Record<string, unknown> | undefined,
  correlationId: string
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (!RESERVED_CONTEXT_KEYS.has(key)) context[key] = value;
  }
  context.usl_agent_origin = "odoo-mcp";
  context.usl_correlation_id = correlationId;
  assertBoundedJson(context);
  return context;
}
