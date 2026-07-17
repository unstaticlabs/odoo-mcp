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
  // Safe-write planner extensions (card ODOO1080). Optional so legacy plans/tests remain valid
  // and so the token still signs the full validate-only plan when these are present.
  status?: PlanStatus;
  resolved_target?: ResolvedTarget;
  existing_records?: unknown[];
  lock_dates?: LockDates;
  would_write?: WouldWrite;
}

// ---- Safe-write planner (validate-only) — card ODOO1080 ----

export type PlanStatus = "safe" | "blocked" | "needs_lock_exception" | "duplicate_found";

/** What the write would target: the resolved model plus (optionally) an id and provenance fields. */
export interface ResolvedTarget {
  model: string;
  id?: number;
  [key: string]: unknown;
}

/** The write that WOULD be issued by the matching apply tool — never executed here. */
export interface WouldWrite {
  model: string;
  method: "create" | "write";
  values: Record<string, unknown>;
  /** Present when method === "write": the record id the write targets. */
  id?: number;
  /** Present for periodicity updates: the pre-write value of the changed field. */
  old_value?: unknown;
}

/** The pure result of a per-operation planner — mirrors the tool's response body (minus the token). */
export interface PlanResult {
  status: PlanStatus;
  resolved_target: ResolvedTarget;
  existing_records: unknown[];
  lock_dates: LockDates;
  warnings: string[];
  would_write: WouldWrite;
  /** True only for a `duplicate_found` that resolves to an in-place update (token still issued). */
  duplicate_as_update: boolean;
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

// ---- Pure per-operation planners (validate-only) ----

/** `date` (an Odoo date/datetime) falls within the inclusive day range [from, to] (both YYYY-MM-DD). */
function dayInPeriod(date: string, from: string, to: string): boolean {
  const day = normalizeDay(date);
  return day >= from && day <= to;
}

/** Assemble a `blocked` plan with an empty create-shaped would_write (never issued — status gates it). */
function blockedPlan(
  target: ResolvedTarget,
  wouldWriteModel: string,
  warnings: string[],
  lockDates: LockDates = {},
  existingRecords: unknown[] = []
): PlanResult {
  return {
    status: "blocked",
    resolved_target: target,
    existing_records: existingRecords,
    lock_dates: lockDates,
    warnings,
    would_write: { model: wouldWriteModel, method: "create", values: {} },
    duplicate_as_update: false
  };
}

/** Fold a lock-check verdict into a base status, accumulating human-readable warnings. */
function applyLockStatus(
  base: PlanStatus,
  date: string,
  lockDates: LockDates,
  warnings: string[]
): PlanStatus {
  const lock = checkDateAgainstLocks(date, lockDates);
  if (lock.blocked) {
    for (const v of lock.violated_locks) {
      if (v.field === "hard_lock_date") warnings.push(`Date ${normalizeDay(date)} is on/before hard_lock_date ${v.lock_date}; write is blocked.`);
    }
    return "blocked";
  }
  if (lock.needs_lock_exception) {
    for (const v of lock.violated_locks) {
      warnings.push(`Date ${normalizeDay(date)} is on/before ${v.field} ${v.lock_date}; a lock exception is required.`);
    }
    return "needs_lock_exception";
  }
  return base;
}

/**
 * States in which an accounting record is finalized/locked; modifying one usually needs reopening it.
 * Compared case-insensitively so version-specific casing (`posted` vs `Posted`) still matches.
 */
const FINALIZED_RECORD_STATES = ["posted", "sent", "done", "closed", "completed", "cancel", "cancelled", "locked"];

/**
 * Exported for unit testing. Record-state validation: inspect each record's `state` field and warn when a
 * plan would touch a record sitting in a finalized/locked state. Records without a `state` field (many
 * Odoo models expose none) yield no warning — this never throws or blocks on version/field gaps.
 */
export function recordStateWarnings(records: Array<Record<string, unknown>>, model: string): string[] {
  const warnings: string[] = [];
  for (const rec of records) {
    const state = rec.state;
    if (typeof state === "string" && FINALIZED_RECORD_STATES.includes(state.toLowerCase())) {
      warnings.push(
        `${model} record id ${rec.id ?? "?"} is in state "${state}"; modifying a finalized record may be rejected or require reopening it first.`
      );
    }
  }
  return warnings;
}

/**
 * Exported for unit testing. Sign-of-amount validation for a monetary write: a non-finite amount, or a
 * value whose sign contradicts the expected one, is surfaced as a warning (soft check — never blocks, since
 * some report values are legitimately negative). `expectedSign` of `"positive"`/`"negative"` flags a
 * mismatch; `"any"` only checks finiteness.
 */
export function amountSignWarnings(value: number, expectedSign: "positive" | "negative" | "any" = "positive", label = "value"): string[] {
  if (!Number.isFinite(value)) return [`${label} ${value} is not a finite number; verify the amount before applying.`];
  if (expectedSign === "positive" && value < 0) {
    return [`${label} ${value} is negative but a positive amount is expected here; verify the sign before applying.`];
  }
  if (expectedSign === "negative" && value > 0) {
    return [`${label} ${value} is positive but a negative amount is expected here; verify the sign before applying.`];
  }
  return [];
}

export interface ExternalValuePlanInput {
  values: { report_line_code: string; expression_label: string; date: string; value: number; name: string };
  /** Resolved account.report.line, or null when the code was not found. */
  line: { id: number; code: string; name?: string } | null;
  /** Resolved account.report.expression, or null when the label was not found on the line. */
  expression: { id: number; label: string; engine: string } | null;
  /** Name of the report-expression FK on account.report.external.value, or null when absent on this version. */
  fkField: string | null;
  /** Existing external values for the expression (planner filters by matching date). */
  existingValues: Array<{ id: number; date?: unknown; [k: string]: unknown }>;
  lockDates: LockDates;
  /** Expected return period the date must fall inside (advisory), or null to skip the check. */
  period: { date_start: string; date_end: string } | null;
}

/**
 * Plan a create-or-update of an `account.report.external.value` (e.g. a carryover balance on
 * `box_22._applied_carryover_balance`). Resolves duplicate-as-update, engine/period/lock validation.
 */
export function planExternalValue(input: ExternalValuePlanInput): PlanResult {
  const { values, line, expression, fkField, existingValues, lockDates, period } = input;
  const warnings: string[] = [];

  if (!line) {
    return blockedPlan(
      { model: "account.report.line" },
      "account.report.external.value",
      [`Report line code "${values.report_line_code}" not found.`],
      lockDates
    );
  }
  if (!expression) {
    return blockedPlan(
      { model: "account.report.expression", report_line_code: line.code },
      "account.report.external.value",
      [`Expression label "${values.expression_label}" not found on report line "${line.code}".`],
      lockDates
    );
  }

  const resolvedTarget: ResolvedTarget = {
    model: "account.report.expression",
    id: expression.id,
    label: expression.label,
    engine: expression.engine,
    report_line_code: line.code
  };

  if (expression.engine !== "external") {
    return blockedPlan(
      resolvedTarget,
      "account.report.external.value",
      [
        `Expression "${expression.label}" on line "${line.code}" has engine "${expression.engine}", not "external"; ` +
          "external values can only be written against external-engine expressions."
      ],
      lockDates
    );
  }
  if (!fkField) {
    return blockedPlan(
      resolvedTarget,
      "account.report.external.value",
      ["account.report.external.value exposes no known report-expression FK field on this Odoo version; cannot plan a write."],
      lockDates
    );
  }

  if (period && !dayInPeriod(values.date, period.date_start, period.date_end)) {
    warnings.push(
      `Date ${normalizeDay(values.date)} falls outside the expected return period ${period.date_start} → ${period.date_end}.`
    );
  }

  // Sign-of-amount validation: an external report balance is normally non-negative here.
  warnings.push(...amountSignWarnings(values.value, "positive"));

  const duplicate = existingValues.find(
    (v) => typeof v.date === "string" && normalizeDay(v.date) === normalizeDay(values.date)
  );

  const wouldWrite: WouldWrite = duplicate
    ? {
        model: "account.report.external.value",
        method: "write",
        id: duplicate.id,
        values: { value: values.value, name: values.name }
      }
    : {
        model: "account.report.external.value",
        method: "create",
        values: { name: values.name, [fkField]: expression.id, date: normalizeDay(values.date), value: values.value }
      };

  const base: PlanStatus = duplicate ? "duplicate_found" : "safe";
  const status = applyLockStatus(base, values.date, lockDates, warnings);
  if (duplicate) {
    // Record-state validation on the record the update would target.
    warnings.push(...recordStateWarnings([duplicate], "account.report.external.value"));
    warnings.push(`An external value already exists for this expression on ${normalizeDay(values.date)} (id ${duplicate.id}); planning an update.`);
  }

  return {
    status,
    resolved_target: resolvedTarget,
    existing_records: duplicate ? [duplicate] : [],
    lock_dates: lockDates,
    warnings,
    would_write: wouldWrite,
    // For this operation a duplicate always maps to an in-place update.
    duplicate_as_update: status === "duplicate_found"
  };
}

export interface ManualReturnPlanInput {
  companyId: number;
  values: { return_type_xmlid: string; date_start: string; date_end: string; name?: string };
  /** Resolved XML ID, or null when it could not be resolved. */
  resolvedType: { model: string; res_id: number } | null;
  returnTypeName?: string | null;
  /** Existing account.return of the same type overlapping the period (tool-filtered). */
  existingReturns: Array<{ id: number; [k: string]: unknown }>;
  lockDates: LockDates;
  /** Existing date field names on account.return (e.g. {from:"date_from", to:"date_to"}). */
  dateFields: { from: string; to: string };
}

/** Plan a manual `account.return` creation, blocking on unresolved type and flagging overlapping duplicates. */
export function planManualReturn(input: ManualReturnPlanInput): PlanResult {
  const { companyId, values, resolvedType, returnTypeName, existingReturns, lockDates, dateFields } = input;

  if (!resolvedType || resolvedType.model !== "account.return.type") {
    const detail = resolvedType
      ? `XML ID "${values.return_type_xmlid}" resolves to ${resolvedType.model}, not account.return.type.`
      : `Could not resolve XML ID "${values.return_type_xmlid}".`;
    return blockedPlan({ model: "account.return.type" }, "account.return", [detail], lockDates);
  }

  const resolvedTarget: ResolvedTarget = {
    model: "account.return.type",
    id: resolvedType.res_id,
    name: returnTypeName ?? null
  };

  const createValues: Record<string, unknown> = {
    [dateFields.from]: values.date_start,
    [dateFields.to]: values.date_end,
    type_id: resolvedType.res_id,
    company_id: companyId
  };
  if (values.name) createValues.name = values.name;

  const wouldWrite: WouldWrite = { model: "account.return", method: "create", values: createValues };
  const warnings: string[] = [];

  if (existingReturns.length > 0) {
    // Record-state validation: flag any overlapping return already finalized/posted.
    warnings.push(...recordStateWarnings(existingReturns, "account.return"));
    warnings.push(
      `An account.return of this type already exists overlapping ${values.date_start} → ${values.date_end} ` +
        `(id ${existingReturns.map((r) => r.id).join(", ")}); creating another would duplicate it.`
    );
    return {
      status: "duplicate_found",
      resolved_target: resolvedTarget,
      existing_records: existingReturns,
      lock_dates: lockDates,
      warnings,
      would_write: wouldWrite,
      // A duplicate return is NOT an in-place update — no token is issued.
      duplicate_as_update: false
    };
  }

  const status = applyLockStatus("safe", values.date_start, lockDates, warnings);
  return {
    status,
    resolved_target: resolvedTarget,
    existing_records: [],
    lock_dates: lockDates,
    warnings,
    would_write: wouldWrite,
    duplicate_as_update: false
  };
}

export interface PeriodicityUpdatePlanInput {
  values: { return_type_xmlid: string; field: string; new_value: unknown };
  resolvedType: { model: string; res_id: number } | null;
  returnTypeName?: string | null;
  /** Whether `values.field` exists on account.return.type for this Odoo version. */
  fieldExists: boolean;
  /** The record's current value for `values.field`, reported as old_value. */
  currentValue: unknown;
  /** The record's `state` field when present (absent on models without a state); drives record-state validation. */
  currentState?: unknown;
}

/** Plan a periodicity (or other) field update on an `account.return.type`, blocking on unknown fields. */
export function planPeriodicityUpdate(input: PeriodicityUpdatePlanInput): PlanResult {
  const { values, resolvedType, returnTypeName, fieldExists, currentValue, currentState } = input;

  if (!resolvedType || resolvedType.model !== "account.return.type") {
    const detail = resolvedType
      ? `XML ID "${values.return_type_xmlid}" resolves to ${resolvedType.model}, not account.return.type.`
      : `Could not resolve XML ID "${values.return_type_xmlid}".`;
    return blockedPlan({ model: "account.return.type" }, "account.return.type", [detail]);
  }

  const resolvedTarget: ResolvedTarget = {
    model: "account.return.type",
    id: resolvedType.res_id,
    name: returnTypeName ?? null,
    [values.field]: currentValue
  };

  if (!fieldExists) {
    return blockedPlan(
      resolvedTarget,
      "account.return.type",
      [`Field "${values.field}" does not exist on account.return.type for this Odoo version.`]
    );
  }

  // Record-state validation on the record the write would update.
  const warnings = recordStateWarnings([{ id: resolvedType.res_id, state: currentState }], "account.return.type");
  warnings.push(`account.return.type.${values.field} would change from ${JSON.stringify(currentValue)} to ${JSON.stringify(values.new_value)}.`);

  return {
    status: "safe",
    resolved_target: resolvedTarget,
    existing_records: [],
    lock_dates: {},
    warnings,
    would_write: {
      model: "account.return.type",
      method: "write",
      id: resolvedType.res_id,
      values: { [values.field]: values.new_value },
      old_value: currentValue
    },
    duplicate_as_update: false
  };
}

export interface LockExceptionPlanInput {
  companyId: number;
  values: { company: string; field: string; exception_date: string; reason: string };
  /** Result of checkLockExceptionSupport — the model may be absent on saas-19.2. */
  support: { supported: boolean; model: string | null; warning?: string };
}

/** Plan a lock-exception creation, blocking when the model is unsupported on this Odoo version. */
export function planLockException(input: LockExceptionPlanInput): PlanResult {
  const { companyId, values, support } = input;

  if (!support.supported || !support.model) {
    return blockedPlan(
      { model: "account.lock_exception", company_id: companyId },
      "account.lock_exception",
      [support.warning ?? "account.lock_exception is unavailable on this Odoo version; cannot create a lock exception."]
    );
  }

  return {
    status: "safe",
    resolved_target: { model: support.model, company_id: companyId },
    existing_records: [],
    lock_dates: {},
    warnings: [],
    would_write: {
      model: support.model,
      method: "create",
      values: { company_id: companyId, [values.field]: values.exception_date, reason: values.reason }
    },
    duplicate_as_update: false
  };
}

/**
 * Token gate: a confirmation token is issued only for a clean `safe` plan or a `duplicate_found` that
 * resolves to an in-place update. `blocked` / `needs_lock_exception` never receive a token.
 */
export function planIssuesToken(plan: PlanResult): boolean {
  return plan.status === "safe" || (plan.status === "duplicate_found" && plan.duplicate_as_update);
}

/** Build the canonical WritePlan the confirmation token signs over, from a planner result. */
export function toWritePlan(operation: string, companyId: number, plan: PlanResult): WritePlan {
  return {
    operation,
    model: plan.would_write.model,
    method: plan.would_write.method,
    values: plan.would_write.values,
    company_id: companyId,
    evidence: [],
    warnings: plan.warnings,
    status: plan.status,
    resolved_target: plan.resolved_target,
    existing_records: plan.existing_records,
    lock_dates: plan.lock_dates,
    would_write: plan.would_write
  };
}

// ---- PM write-intent classifier ----
// Pure structural gate: model + method + field names + mail.activity res_model — never free-text content.

/** Models eligible for PM-safe writes when method/field/res_model rules pass. Exported for unit testing. */
export const PM_MODEL_ALLOWLIST = new Set(["project.task", "mail.activity"]);

export type PmWriteIntent = "project_management" | "financial_mutation" | "disallowed";
export type PmWriteVerdict = "allowed" | "denied";

/** Odoo JSON-2 call shape — matches what write tools pass to the gate. */
export interface PmWriteIntentInput {
  model: string;
  method: string;
  /** create → { vals_list }, write → { vals }, message_post → { body, ids, … } */
  args: Record<string, unknown>;
}

export interface PmWriteIntentResult {
  verdict: PmWriteVerdict;
  intent: PmWriteIntent;
  reason?: string;
  blocked_fields?: string[];
}

/** Prose keys are never keyword-scanned; exempt from financial-field pattern matching. Exported for unit testing. */
export const PM_TEXT_FIELDS = new Set(["description", "note", "summary", "body"]);

/** Writable PM fields on project.task (field-name gate only). Exported for unit testing. */
export const PROJECT_TASK_PM_FIELDS = new Set([
  "name",
  "display_name",
  "description",
  "stage_id",
  "project_id",
  "priority",
  "user_ids",
  "date_deadline",
  "date_end",
  "date_start",
  "tag_ids",
  "planned_hours",
  "allocated_hours",
  "partner_id",
  "color",
  "sequence",
  "parent_id",
  "child_ids",
  "depend_on_ids",
  "milestone_id",
  "personal_stage_type_ids",
  "kanban_state",
  "state",
  "active",
  "company_id",
  "email_from",
  "is_closed"
]);

const MAIL_ACTIVITY_PM_FIELDS = new Set([
  "summary",
  "note",
  "date_deadline",
  "user_id",
  "activity_type_id",
  "res_model",
  "res_id",
  "res_model_id"
]);

const SENSITIVE_MODEL_PREFIXES = [
  "account.",
  "hr.",
  "payment.",
  "l10n_",
  "stock.valuation",
  "sign.",
  "contract."
] as const;

const PARTNER_FINANCIAL_FIELD_DENYLIST = new Set([
  "bank_ids",
  "property_account_receivable_id",
  "property_account_payable_id",
  "property_payment_term_id",
  "vat",
  "siret",
  "company_registry",
  "credit_limit",
  "debit_limit",
  "trust",
  "supplier_rank",
  "customer_rank"
]);

const PARTNER_FINANCIAL_FIELD_PATTERNS: readonly RegExp[] = [/^invoice_/, /^l10n_/];

/** Field-name patterns indicating accounting / payroll / bank mutation. Exported for unit testing. */
export const FINANCIAL_FIELD_PATTERNS: readonly RegExp[] = [
  /^account_/,
  /_account_id$/,
  /^bank_/,
  /^payment_/,
  /^tax_/,
  /^vat_/,
  /(^|_)vat($|_)/,
  /debit/,
  /credit/,
  /balance/,
  /^amount_/,
  /amount_total/,
  /amount_untaxed/,
  /amount_tax/,
  /journal_id/,
  /move_id/,
  /invoice_/,
  /reconcil/,
  /payroll/,
  /payslip/,
  /siret/,
  /company_registry/,
  /sale_line_id/,
  /sale_order_id/,
  /billable/,
  /pricing_type/
];

const PM_LIFECYCLE_METHODS = new Set(["unlink", "action_feedback"]);

const BOOKKEEPING_DENY_REASON =
  "Use bookkeeping.plan_safe_write for validated accounting/tax operations (tax/report/return/lock-exception).";

const BILLING_DRAFT_PREP_DENY_REASON =
  "For draft vendor-bill / expense preparatory fields use billing.configure_draft_vendor_bill or billing.update_draft_expense. " +
  BOOKKEEPING_DENY_REASON;

function pmAllowed(): PmWriteIntentResult {
  return { verdict: "allowed", intent: "project_management" };
}

function pmDenied(
  intent: PmWriteIntent,
  reason: string,
  blocked_fields?: string[]
): PmWriteIntentResult {
  return { verdict: "denied", intent, reason, blocked_fields };
}

function sensitiveModelReason(model: string): string {
  if (model === "account.move" || model === "hr.expense") {
    return `Writes to ${model} via generic MCP write tools are blocked. ${BILLING_DRAFT_PREP_DENY_REASON}`;
  }
  return `Writes to ${model} are blocked by the connector safety layer. ${BOOKKEEPING_DENY_REASON}`;
}

function defaultDenyReason(model: string): string {
  return (
    `Writes to ${model} via generic MCP write tools are not allowlisted. ` +
    "Project-management work should use project.task / mail.activity (res_model=project.task) or chatter."
  );
}

function isSensitiveModelPrefix(model: string): boolean {
  return SENSITIVE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

function isFinancialFieldName(field: string): boolean {
  return FINANCIAL_FIELD_PATTERNS.some((re) => re.test(field));
}

function isPartnerFinancialField(field: string): boolean {
  if (PARTNER_FINANCIAL_FIELD_DENYLIST.has(field)) return true;
  return PARTNER_FINANCIAL_FIELD_PATTERNS.some((re) => re.test(field));
}

/** Exported for unit testing. */
export function collectPmValueRecords(args: Record<string, unknown>): Record<string, unknown>[] {
  const valsList = args.vals_list;
  if (Array.isArray(valsList)) {
    return valsList.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  }
  const vals = args.vals;
  if (vals && typeof vals === "object" && !Array.isArray(vals)) {
    return [vals as Record<string, unknown>];
  }
  return [];
}

/** Fields present in value records that are not on the model-specific PM allowlist. Exported for unit testing. */
export function fieldsOutsideAllowlist(
  records: Record<string, unknown>[],
  allowed: ReadonlySet<string>
): string[] {
  const blocked: string[] = [];
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (!allowed.has(key)) blocked.push(key);
    }
  }
  return [...new Set(blocked)];
}

function denyNonAllowlistedFields(model: string, blocked: string[]): PmWriteIntentResult {
  const hasFinancial = blocked.some(isFinancialFieldName);
  const intent: PmWriteIntent = hasFinancial ? "financial_mutation" : "disallowed";
  const kind = hasFinancial ? "financial or non-PM" : "non-PM";
  return pmDenied(intent, `${model} write touches ${kind} fields: ${blocked.join(", ")}.`, blocked);
}

function partnerFinancialFieldsInRecords(records: Record<string, unknown>[]): string[] {
  const blocked: string[] = [];
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (isPartnerFinancialField(key)) blocked.push(key);
    }
  }
  return [...new Set(blocked)];
}

function classifyResPartner(method: string, args: Record<string, unknown>): PmWriteIntentResult {
  if (method !== "create" && method !== "write") {
    return pmDenied("disallowed", defaultDenyReason("res.partner"));
  }

  const records = collectPmValueRecords(args);
  const blocked = partnerFinancialFieldsInRecords(records);
  if (blocked.length > 0) {
    return pmDenied(
      "financial_mutation",
      `res.partner write touches financial fields: ${blocked.join(", ")}. ${BOOKKEEPING_DENY_REASON}`,
      blocked
    );
  }

  return pmDenied("financial_mutation", sensitiveModelReason("res.partner"));
}

function classifyProjectTask(method: string, args: Record<string, unknown>): PmWriteIntentResult {
  if (method === "message_post") return pmAllowed();
  if (PM_LIFECYCLE_METHODS.has(method)) return pmAllowed();

  if (method !== "create" && method !== "write") {
    return pmDenied("disallowed", `project.task method "${method}" is not allowed via generic write tools.`);
  }

  const blocked = fieldsOutsideAllowlist(collectPmValueRecords(args), PROJECT_TASK_PM_FIELDS);
  if (blocked.length > 0) {
    return denyNonAllowlistedFields("project.task", blocked);
  }

  return pmAllowed();
}

function classifyMailActivity(method: string, args: Record<string, unknown>): PmWriteIntentResult {
  if (PM_LIFECYCLE_METHODS.has(method)) return pmAllowed();

  if (method !== "create" && method !== "write") {
    return pmDenied("disallowed", `mail.activity method "${method}" is not allowed via generic write tools.`);
  }

  const records = collectPmValueRecords(args);

  if (method === "create") {
    if (records.length === 0) {
      return pmDenied("disallowed", "mail.activity create must set res_model to project.task.");
    }
    for (const rec of records) {
      const resModel = rec.res_model;
      if (typeof resModel !== "string" || !resModel.trim()) {
        return pmDenied("disallowed", "mail.activity create must set res_model to project.task.");
      }
      if (resModel.trim() !== "project.task") {
        return pmDenied(
          "financial_mutation",
          "mail.activity writes must target project.task (res_model); activities on accounting or external-party records are blocked."
        );
      }
    }
  }

  if (method === "write") {
    for (const rec of records) {
      const resModel = rec.res_model;
      if (typeof resModel === "string" && resModel.trim() && resModel.trim() !== "project.task") {
        return pmDenied(
          "financial_mutation",
          "mail.activity writes must target project.task (res_model); activities on accounting or external-party records are blocked."
        );
      }
    }
  }

  const blocked = fieldsOutsideAllowlist(records, MAIL_ACTIVITY_PM_FIELDS);
  if (blocked.length > 0) {
    return denyNonAllowlistedFields("mail.activity", blocked);
  }

  return pmAllowed();
}

/**
 * Pure classifier — no Odoo I/O. Textual fields (description, note, summary, message_post body) are
 * never keyword-scanned; only model/method/field structure determines intent.
 * Exported for unit testing.
 */
export function classifyPmWriteIntent(input: PmWriteIntentInput): PmWriteIntentResult {
  const model = input.model.trim();
  const method = input.method.trim();

  if (!model) {
    return pmDenied("disallowed", "model must be a non-empty string.");
  }
  if (!method) {
    return pmDenied("disallowed", "method must be a non-empty string.");
  }

  if (isSensitiveModelPrefix(model)) {
    return pmDenied("financial_mutation", sensitiveModelReason(model));
  }

  if (model === "res.partner") {
    return classifyResPartner(method, input.args);
  }

  if (model === "project.task") {
    return classifyProjectTask(method, input.args);
  }

  if (model === "mail.activity") {
    return classifyMailActivity(method, input.args);
  }

  return pmDenied("disallowed", defaultDenyReason(model));
}
