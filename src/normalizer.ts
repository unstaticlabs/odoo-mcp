export interface OdooFieldMeta {
  type: string; // "many2one" | "one2many" | "many2many" | "selection" | "char" | "date" | "datetime" | "boolean" | "monetary" | "float" | "integer" | ...
  selection?: [string, string][]; // [value, label] pairs, only for type === "selection"
}
export type FieldsMeta = Record<string, OdooFieldMeta>;

export interface NormalizeOptions {
  includeRaw?: boolean;
}

/** A many2one value from Odoo is a 2-tuple [id, "Display Name"], regardless of metadata presence. */
function isMany2OneTuple(value: unknown): value is [number, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string";
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function normalizeMany2One(value: [number, string]): { id: number; name: string } {
  return { id: value[0], name: value[1] };
}

function normalizeIdList(value: number[]): { ids: number[]; count: number } {
  return { ids: value, count: value.length };
}

function normalizeSelection(value: unknown, selection: [string, string][]): { value: unknown; label: string | null } {
  const match = selection.find(([raw]) => raw === value);
  return { value, label: match ? match[1] : null };
}

function normalizeField(key: string, value: unknown, fieldsMeta?: FieldsMeta): unknown {
  const meta = fieldsMeta?.[key];

  if (meta) {
    if (meta.type === "many2one") return value === false ? null : isMany2OneTuple(value) ? normalizeMany2One(value) : value;
    if (meta.type === "one2many" || meta.type === "many2many")
      return value === false ? null : isNumberArray(value) ? normalizeIdList(value) : value;
    if (meta.type === "selection") return value === false ? null : meta.selection ? normalizeSelection(value, meta.selection) : value;
    if (meta.type === "boolean") return value;
    return value === false ? null : value;
  }

  // Heuristic fallback without metadata: relational shapes are still recognizable structurally.
  if (isMany2OneTuple(value)) return normalizeMany2One(value);
  if (isNumberArray(value)) return normalizeIdList(value);
  // Plain `false` without metadata can't be distinguished from a real boolean field, so leave it as-is.
  return value;
}

export function normalizeRecord(record: Record<string, unknown>, fieldsMeta?: FieldsMeta): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = normalizeField(key, value, fieldsMeta);
  }
  return result;
}

/**
 * Best-effort synthetic status derived from a raw (pre-normalization) Odoo
 * record's `state` or `stage_id` field. `state` takes precedence since it's
 * the more common workflow field; `stage_id` arrives as Odoo's [id, "Label"]
 * many2one tuple, from which the label is extracted.
 */
export function deriveWorkflowStatus(record: Record<string, unknown>): string | null {
  const state = record?.state;
  if (typeof state === "string" && state) return state;

  const stageId = record?.stage_id;
  if (isMany2OneTuple(stageId)) return stageId[1] || null;

  return null;
}

/**
 * Odoo 19 `project.task.state` vocabulary for the Waiting guard.
 *
 * Waiting is **computed** by Odoo from `stage_id` + open `depend_on_ids` (Blocked By) — it is not a
 * status an agent may write. The strings and the open/closed test live here because this is the one
 * pure leaf module both sides of the guard can import: the write gate
 * (`project-task-state-gate.ts`, via `safety.ts`) and the read annotation (`tools/shared.ts`).
 */
export const PROJECT_TASK_WAITING_STATE = "04_waiting_normal";
export const PROJECT_TASK_IN_PROGRESS_STATE = "01_in_progress";

/**
 * Blocker states that no longer hold a successor back. Anything else — including a state we do not
 * recognise — counts as open, so an unreadable or unexpected blocker fails closed.
 */
export const OPEN_BLOCKER_EXEMPT_STATES: ReadonlySet<string> = new Set([
  "03_approved",
  "1_done",
  "1_canceled"
]);

/** True when a Blocked By dependency in this state still holds its successor in Waiting. */
export function isOpenBlockerState(state: unknown): boolean {
  if (typeof state !== "string" || !state.trim()) return true;
  return !OPEN_BLOCKER_EXEMPT_STATES.has(state.trim());
}

/** True when a raw project.task row is in Odoo's computed Waiting state. */
export function isWaitingTaskRecord(record: Record<string, unknown> | null | undefined): boolean {
  return record?.state === PROJECT_TASK_WAITING_STATE;
}

const WAITING_DERIVATION_NOTE =
  "Waiting is derived by Odoo from open Blocked By dependencies (depend_on_ids) — stage, assignees, " +
  "activities and dates never put a task in Waiting.";

export type WaitingBlocker = { id: number; state?: unknown; name?: unknown };

/**
 * Attach the dependency-derived explanation to a Waiting task read.
 *
 * `blockers` is the live read of `depend_on_ids`; pass `undefined` when it could not be fetched, so
 * the annotation says "unknown" rather than claiming there are no blockers. Non-Waiting records are
 * returned untouched.
 */
export function annotateWaitingDependency(
  record: Record<string, unknown>,
  blockers?: WaitingBlocker[]
): Record<string, unknown> {
  if (!isWaitingTaskRecord(record)) return record;

  if (!blockers) {
    return {
      ...record,
      _waiting_derived: true,
      _waiting_explanation:
        `${WAITING_DERIVATION_NOTE} The blocking tasks could not be read here — read depend_on_ids and ` +
        "each blocker's state to see what is holding this task."
    };
  }

  const openBlockerIds = blockers.filter((b) => isOpenBlockerState(b.state)).map((b) => b.id);
  const explanation =
    openBlockerIds.length > 0
      ? `${WAITING_DERIVATION_NOTE} Open blockers: ${openBlockerIds.join(", ")}. Close or approve them ` +
        "(03_approved / 1_done / 1_canceled), or remove them from depend_on_ids, and Odoo recomputes the state."
      : `${WAITING_DERIVATION_NOTE} This task has no open blockers, so the Waiting state is stale — write ` +
        "state=01_in_progress to return it to an ordinary open state.";

  return {
    ...record,
    _waiting_derived: true,
    _open_blocker_ids: openBlockerIds,
    _waiting_explanation: explanation
  };
}

export function normalizeRecords(
  records: Record<string, unknown>[],
  fieldsMeta?: FieldsMeta,
  opts?: NormalizeOptions
): Record<string, unknown>[] {
  return records.map((record) => {
    const normalized = normalizeRecord(record, fieldsMeta);
    return opts?.includeRaw ? { ...normalized, _raw: record } : normalized;
  });
}
