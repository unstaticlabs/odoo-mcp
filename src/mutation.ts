import { z } from "zod";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_PROTOCOL_VERSION = "1";
export const IDEMPOTENCY_CAPABILITY_MODEL = "usl.json2.idempotency";
export const IDEMPOTENCY_CAPABILITY_METHOD = "get_capabilities";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const zIdempotencyKey = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, "idempotency_key must be an opaque ASCII token using letters, digits, '.', '_', ':', or '-'")
  .optional()
  .describe(
    "Opaque key for this exact logical mutation. Omit to generate one. Reuse only to retry identical business arguments, especially after outcome_unknown."
  );

export const zReason = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe("Short audit reason for the mutation. Do not include credentials or sensitive personal data.");

export const zOdooContext = z
  .record(z.string().min(1).max(128), z.unknown())
  .optional()
  .describe("Odoo RPC context such as lang, tz, allowed_company_ids, and company_id. Connector attribution keys are reserved.");

export type MutationOutcome = "succeeded" | "not_applied" | "unknown";
export type IdempotencyMode = "odoo_atomic" | "unavailable";

export interface MutationExecution {
  idempotency_key: string;
  idempotency_mode: IdempotencyMode;
  replayed: boolean;
  correlation_id: string;
  outcome: MutationOutcome;
  expires_at?: string;
}

export const zMutationExecution = z.object({
  idempotency_key: z.string(),
  idempotency_mode: z.enum(["odoo_atomic", "unavailable"]),
  replayed: z.boolean(),
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "not_applied", "unknown"]),
  expires_at: z.string().optional()
});

export interface IdempotencyCapabilities {
  protocol_version: string;
  retention_seconds: number;
  result_size_limit: number;
}

export function parseIdempotencyCapabilities(value: unknown): IdempotencyCapabilities | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.protocol_version !== IDEMPOTENCY_PROTOCOL_VERSION ||
    !Number.isInteger(record.retention_seconds) ||
    (record.retention_seconds as number) <= 0 ||
    !Number.isInteger(record.result_size_limit) ||
    (record.result_size_limit as number) <= 0
  ) {
    return null;
  }
  return {
    protocol_version: record.protocol_version,
    retention_seconds: record.retention_seconds as number,
    result_size_limit: record.result_size_limit as number
  };
}

export function resolveIdempotencyKey(value?: string): string {
  if (value === undefined) return crypto.randomUUID();
  const parsed = zIdempotencyKey.unwrap().safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid idempotency_key");
  return parsed.data;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function correlationIdForKey(key: string): Promise<string> {
  return `mcp-${(await digest(`correlation\0${key}`)).slice(0, 32)}`;
}

/** Execution evidence for a mutating tool refusal that occurred before an Odoo mutation attempt. */
export async function notAppliedMutationExecution(idempotencyKey?: string): Promise<MutationExecution> {
  const key = resolveIdempotencyKey(idempotencyKey);
  return {
    idempotency_key: key,
    idempotency_mode: "unavailable",
    replayed: false,
    correlation_id: await correlationIdForKey(key),
    outcome: "not_applied"
  };
}

export async function childIdempotencyKey(rootKey: string, stableStep: string): Promise<string> {
  const suffix = (await digest(`child\0${rootKey}\0${stableStep}`)).slice(0, 32);
  const prefixLimit = IDEMPOTENCY_KEY_MAX_LENGTH - suffix.length - 1;
  return `${rootKey.slice(0, prefixLimit)}.${suffix}`;
}

const RESERVED_ODOO_CONTEXT_KEYS = new Set([
  "usl_agent_origin",
  "usl_correlation_id",
  "usl_agent_reason",
  "usl_idempotency_key",
  "usl_idempotency_mode"
]);

export function mergeOdooMutationContext(
  existing: unknown,
  requested: Record<string, unknown> | undefined,
  execution: Pick<MutationExecution, "idempotency_key" | "idempotency_mode" | "correlation_id">,
  reason?: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of [existing, requested]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (!RESERVED_ODOO_CONTEXT_KEYS.has(key)) merged[key] = value;
    }
  }
  merged.usl_agent_origin = "odoo-mcp";
  merged.usl_correlation_id = execution.correlation_id;
  merged.usl_idempotency_key = execution.idempotency_key;
  merged.usl_idempotency_mode = execution.idempotency_mode;
  if (reason) merged.usl_agent_reason = reason;
  return merged;
}

export class MutationExecutionError extends Error {
  readonly execution: MutationExecution;
  readonly cause: unknown;

  constructor(cause: unknown, execution: MutationExecution) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MutationExecutionError";
    this.cause = cause;
    this.execution = execution;
  }
}
