import { type CachedFieldMeta, type TtlCache, getFieldsCached } from "./cache";
import { OdooError, type OdooConnection } from "./odoo";
import type { OdooQueue } from "./odoo-queue";
import { pickExistingFields } from "./tools/bookkeeping";

// ---- Types ----

export interface LockDates {
  [field: string]: string | null;
} // ISO date or null

export interface LockCheckResult {
  blocked: boolean;
  needs_lock_exception: boolean;
  violated_locks: { field: string; lock_date: string }[];
}

export interface WritePlan {
  operation: string;
  model: string;
  method: string;
  values: Record<string, unknown>;
  company_id: number;
  evidence: string[];
  warnings: string[];
}

export interface AuditEntry {
  operation: string;
  model: string;
  ids: number[];
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  reason: string;
  evidence: string[];
  timestamp: string;
}

/** The Odoo-side outcome of a write, plus the caller-supplied timestamp/reason, folded into an AuditEntry. */
export interface WriteResult {
  ids: number[];
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  reason: string;
  timestamp: string;
}

export type TokenVerdict = "valid" | "expired" | "mismatch";

// ---- Lock-date discovery & precedence ----

const LOCK_FIELD_CANDIDATES = [
  "fiscalyear_lock_date",
  "tax_lock_date",
  "sale_lock_date",
  "purchase_lock_date",
  "hard_lock_date"
] as const;

/** Soft locks — a violation is exceptable via a lock exception rather than an outright block. */
const SOFT_LOCK_FIELDS = ["fiscalyear_lock_date", "tax_lock_date", "sale_lock_date", "purchase_lock_date"] as const;

/** Normalize an Odoo date/datetime string to a lexically-comparable `YYYY-MM-DD` day. */
function normalizeDay(date: string): string {
  return date.slice(0, 10);
}

/**
 * Exported for unit testing. Discover the company's lock dates, reading only the lock fields that
 * actually exist on `res.company` for this Odoo version. Non-existent fields are omitted; if none of
 * the candidates exist a warning is accumulated (do not throw for version-discovery gaps).
 */
export async function getLockDates(
  queue: OdooQueue,
  cache: TtlCache,
  conn: OdooConnection,
  companyId: number
): Promise<{ lockDates: LockDates; warnings: string[] }> {
  const warnings: string[] = [];
  const fieldsMeta = await getFieldsCached(cache, queue, conn, "res.company");
  const existingFields = pickExistingFields([...LOCK_FIELD_CANDIDATES], fieldsMeta);

  const lockDates: LockDates = {};
  if (existingFields.length === 0) {
    warnings.push(
      "res.company exposes none of the known lock-date fields " +
        `(${LOCK_FIELD_CANDIDATES.join(", ")}); lock checks skipped — this Odoo version may differ.`
    );
    return { lockDates, warnings };
  }

  const rows = (await queue.enqueue(conn, "res.company", "read", {
    ids: [companyId],
    fields: existingFields
  })) as Record<string, unknown>[];
  const row = rows?.[0] ?? {};

  for (const field of existingFields) {
    const value = row[field];
    // Odoo returns `false` for an unset date field; normalize everything non-string to null.
    lockDates[field] = typeof value === "string" && value ? value : null;
  }

  return { lockDates, warnings };
}

/**
 * Exported for unit testing. Classify a target `date` against a company's lock dates. `hard_lock_date`
 * cannot be excepted (sets `blocked`); the four soft locks set `needs_lock_exception`. `blocked` and
 * `needs_lock_exception` are independent booleans. Null lock dates never violate.
 */
export function checkDateAgainstLocks(date: string, lockDates: LockDates): LockCheckResult {
  const target = normalizeDay(date);
  const violated: { field: string; lock_date: string }[] = [];
  let blocked = false;
  let needsException = false;

  const hard = lockDates.hard_lock_date;
  if (hard && target <= normalizeDay(hard)) {
    blocked = true;
    violated.push({ field: "hard_lock_date", lock_date: hard });
  }

  for (const field of SOFT_LOCK_FIELDS) {
    const lock = lockDates[field];
    if (lock && target <= normalizeDay(lock)) {
      needsException = true;
      violated.push({ field, lock_date: lock });
    }
  }

  return { blocked, needs_lock_exception: needsException, violated_locks: violated };
}

/**
 * Exported for unit testing. Probe whether `account.lock_exception` exists on this Odoo version. Absence
 * is reported as a `warning` string (not thrown) — e.g. saas-19.2 may not have this model.
 */
export async function checkLockExceptionSupport(
  queue: OdooQueue,
  cache: TtlCache,
  conn: OdooConnection
): Promise<{ supported: boolean; model: string | null; warning?: string }> {
  const model = "account.lock_exception";
  try {
    const fieldsMeta: Record<string, CachedFieldMeta> = await getFieldsCached(cache, queue, conn, model);
    if (fieldsMeta && Object.keys(fieldsMeta).length > 0) {
      return { supported: true, model };
    }
    return {
      supported: false,
      model: null,
      warning: `${model} reported no fields; lock exceptions may be unavailable on this Odoo version.`
    };
  } catch (err) {
    const detail = err instanceof OdooError ? err.details : err instanceof Error ? err.message : String(err);
    return {
      supported: false,
      model: null,
      warning: `${model} unavailable (${detail}); lock exceptions may be unsupported on this Odoo version.`
    };
  }
}

// ---- Canonical serialization ----

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Exported for unit testing. Deterministic JSON serialization: object keys are recursively sorted while
 * arrays keep their order, so output is stable regardless of insertion order. Used for all hashing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

// ---- Stateless HMAC confirmation tokens ----

/** Confirmation tokens live ~15 minutes between dry-run and apply. */
export const TOKEN_TTL_MS = 15 * 60 * 1000;

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(signature);
}

/** Constant-time byte-array comparison, so token verification does not leak via timing. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Exported for unit testing. Issue a stateless HMAC-SHA256 confirmation token over the plan + a ~15-min
 * expiry. The expiry is encoded in the token so `verifyConfirmationToken` is self-contained (no server
 * state survives a Durable Object restart between dry-run and apply).
 */
export async function issueConfirmationToken(plan: WritePlan, secret: string, now: number): Promise<string> {
  const expiry = now + TOKEN_TTL_MS;
  const hmac = await hmacSha256(secret, `${canonicalJson(plan)}|${expiry}`);
  const expiryPart = base64urlEncode(new TextEncoder().encode(String(expiry)));
  return `${expiryPart}.${base64urlEncode(hmac)}`;
}

/**
 * Exported for unit testing. Verify a confirmation token against a plan. Returns `mismatch` if the token
 * is malformed or the HMAC differs (tampered plan/token, wrong secret), `expired` if `now` is past the
 * encoded expiry, otherwise `valid`. HMAC is compared before expiry so tampering always reads as mismatch.
 */
export async function verifyConfirmationToken(
  token: string,
  plan: WritePlan,
  secret: string,
  now: number
): Promise<TokenVerdict> {
  const parts = token.split(".");
  if (parts.length !== 2) return "mismatch";
  const [expiryPart, hmacPart] = parts;

  let expiry: number;
  let provided: Uint8Array;
  try {
    expiry = Number(new TextDecoder().decode(base64urlDecode(expiryPart)));
    provided = base64urlDecode(hmacPart);
  } catch {
    return "mismatch";
  }
  if (!Number.isFinite(expiry)) return "mismatch";

  const expected = await hmacSha256(secret, `${canonicalJson(plan)}|${expiry}`);
  if (!constantTimeEqual(expected, provided)) return "mismatch";
  if (now > expiry) return "expired";
  return "valid";
}

// ---- Audit ----

/**
 * Exported for unit testing. Assemble a structured audit record from a WritePlan and the write's result.
 * The timestamp is taken from `result` (caller-supplied) so this stays pure and deterministic for tests.
 */
export function buildAuditEntry(plan: WritePlan, result: WriteResult): AuditEntry {
  return {
    operation: plan.operation,
    model: plan.model,
    ids: result.ids,
    old_values: result.old_values,
    new_values: result.new_values,
    reason: result.reason,
    evidence: plan.evidence,
    timestamp: result.timestamp
  };
}
