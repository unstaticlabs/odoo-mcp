/**
 * Stateful gate for the reversible-lifecycle allowlist.
 *
 * `lifecycle-allowlist.ts` holds pure policy (which method on which model, from which states).
 * This module is the one place that turns that policy into Odoo I/O: pre-read the live records,
 * refuse anything unvalidated, then run the method. Both entry points share it —
 * `call_model_method` (full `/mcp` surface) and the dedicated `billing.*` lifecycle tools (also on
 * `/accounting/mcp`) — so there is a single implementation of the safety semantics.
 */

import {
  excludedStateHint,
  failedGuardFields,
  getReversibleLifecycleRule,
  isCompatibleLifecycleState,
  isCompatibleMoveType,
  lifecycleReadFields,
  type LifecycleRule,
  type PolicyRule
} from "./lifecycle-allowlist";
import type { OdooQueue } from "./odoo-queue";
import type { Props } from "./server";
import { mcpErrorFromException, mcpWriteBlockedError, requireConnection } from "./tools/shared";

/** Any tool response this module can produce for a refused or failed call. */
type ToolResponse = ReturnType<typeof mcpWriteBlockedError> | ReturnType<typeof mcpErrorFromException>;

/**
 * Outcome of the preflight. On success it carries the validated ids and the live state read during
 * validation, so callers that want before/after evidence need no second read.
 */
export type LifecyclePreflight =
  | { ok: true; ids: number[]; states: Map<number, string | null> }
  | { ok: false; response: ToolResponse };

export type LifecycleCallOptions = {
  model: string;
  method: string;
  /** Record ids as supplied by the caller, before validation. */
  ids: unknown;
  context: string | undefined;
  queue: OdooQueue;
  getProps: () => Props | undefined;
};

export type ParsedLifecycleIds = {
  ids: number[];
  /** Entries that are not positive integers — refused rather than silently dropped. */
  invalid: unknown[];
};

/**
 * Split caller-supplied ids into usable positive integers and rejects. Non-positive or non-integer
 * entries are surfaced, not dropped: the validated set and the executed set must be identical.
 */
export function parseLifecycleIds(ids: unknown): ParsedLifecycleIds {
  if (!Array.isArray(ids)) return { ids: [], invalid: [] };
  const valid: number[] = [];
  const invalid: unknown[] = [];
  for (const id of ids) {
    if (typeof id === "number" && Number.isInteger(id) && id > 0) valid.push(id);
    else invalid.push(id);
  }
  return { ids: [...new Set(valid)], invalid };
}

function refuse(
  model: string,
  method: string,
  opts: { reason: string; policy_rule: PolicyRule; next_step: string }
): LifecyclePreflight {
  return {
    ok: false,
    response: mcpWriteBlockedError(
      { model, method },
      {
        intent: "financial_mutation",
        reason: opts.reason,
        policy_rule: opts.policy_rule,
        risk_class: "reversible_lifecycle",
        next_step: opts.next_step,
        refusing_layer: "connector_policy",
        recoverable: true
      }
    )
  };
}

/** Records keyed by id, ignoring anything that is not a well-formed row. */
function indexById(rows: unknown[]): Map<number, Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "number" && Number.isInteger(rec.id) ? rec.id : null;
    if (id == null || id <= 0) continue;
    byId.set(id, rec);
  }
  return byId;
}

function stateOf(record: Record<string, unknown>): string | null {
  return typeof record.state === "string" ? record.state : null;
}

/** "Already draft, use the draft tool instead" redirect, when that is the actual situation. */
function draftRedirectHint(model: string, state: string | null): string | undefined {
  if (state !== "draft") return undefined;
  if (model === "hr.expense") return "Record is already draft — use billing.update_draft_expense for preparatory fields.";
  if (model === "account.move")
    return "Record is already draft — use billing.configure_draft_vendor_bill for preparatory fields.";
  return undefined;
}

/**
 * Read the target records for a lifecycle rule. Guard fields (e.g. `can_reset`) do not exist on
 * every Odoo version and Odoo raises on an unknown field name — so when a projection including them
 * fails, retry once without them. Those checks are then skipped rather than treated as failures.
 */
async function readLifecycleRecords(
  rule: LifecycleRule,
  opts: { model: string; ids: number[]; queue: OdooQueue; getProps: () => Props | undefined }
): Promise<{ rows: unknown } | { error: ToolResponse }> {
  const { model, ids, queue, getProps } = opts;
  const attempt = (fields: string[]) => queue.enqueue(requireConnection(getProps()), model, "read", { ids, fields });
  const guards = new Set(rule.guard_fields ?? []);

  try {
    return { rows: await attempt(lifecycleReadFields(rule)) };
  } catch (err) {
    if (guards.size === 0) return { error: mcpErrorFromException(err, { model, method: "read" }) };
  }

  try {
    return { rows: await attempt(lifecycleReadFields(rule).filter((field) => !guards.has(field))) };
  } catch (err) {
    return { error: mcpErrorFromException(err, { model, method: "read" }) };
  }
}

/**
 * Preflight an allowlisted lifecycle call: require write context, validate every id against a live
 * read, then check state, move_type and record-level guard flags before anything mutates.
 */
export async function preflightLifecycleCall(opts: LifecycleCallOptions): Promise<LifecyclePreflight> {
  const { model, method, context, queue, getProps } = opts;
  const rule = getReversibleLifecycleRule(model, method);
  // Not a lifecycle call — nothing for this gate to validate.
  if (!rule) return { ok: true, ids: [], states: new Map() };

  if (!context || !context.trim()) {
    return refuse(model, method, {
      reason: `Allowlisted reversible lifecycle method "${method}" on ${model} requires a non-empty write context (audit-only).`,
      policy_rule: "lifecycle_context_required",
      next_step: "Retry with a short write context describing why this lifecycle action is being taken."
    });
  }

  const { ids, invalid } = parseLifecycleIds(opts.ids);
  if (invalid.length > 0) {
    return refuse(model, method, {
      reason:
        `Lifecycle call on ${model} received ids that are not positive integers: ${JSON.stringify(invalid)}. ` +
        "Refusing the whole call rather than silently skipping them.",
      policy_rule: "lifecycle_ids_invalid",
      next_step: "Pass ids as positive integers only, then retry."
    });
  }
  if (ids.length === 0) {
    return refuse(model, method, {
      reason: `Allowlisted lifecycle method "${method}" on ${model} requires at least one positive record id.`,
      policy_rule: "lifecycle_ids_invalid",
      next_step: "Pass ids: [<positive int>, ...] for the target record(s)."
    });
  }

  const read = await readLifecycleRecords(rule, { model, ids, queue, getProps });
  if ("error" in read) return { ok: false, response: read.error };
  if (!Array.isArray(read.rows)) {
    return refuse(model, method, {
      reason: `Pre-read for ${model} lifecycle gate returned a non-array result.`,
      policy_rule: "lifecycle_ids_invalid",
      next_step: "Verify the record ids exist, then retry."
    });
  }

  const byId = indexById(read.rows);
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return refuse(model, method, {
      reason:
        `Lifecycle pre-read did not return every requested id for ${model}. Missing: ${missing.join(", ")}. ` +
        "Refusing to mutate unvalidated ids.",
      policy_rule: "lifecycle_ids_invalid",
      next_step: "Verify all record ids exist and are readable, then retry with the full ids list."
    });
  }

  for (const id of ids) {
    const record = byId.get(id)!;
    const state = stateOf(record);

    if (!isCompatibleLifecycleState(rule, state)) {
      const hint = excludedStateHint(rule, state) ?? draftRedirectHint(model, state);
      return refuse(model, method, {
        reason:
          `${model} id ${id} is in state "${state ?? "unknown"}"; "${method}" requires one of: ` +
          `${rule.from_states.join(", ")}.${hint ? ` ${hint}` : ""}`,
        policy_rule: "lifecycle_state_incompatible",
        next_step:
          hint ??
          rule.next_step_hint ??
          `Bring the record to a compatible state (${rule.from_states.join(", ")}) or use billing.* / Odoo UI.`
      });
    }

    if (rule.require_move_types?.length) {
      const moveType = typeof record.move_type === "string" ? record.move_type : null;
      if (!isCompatibleMoveType(rule, moveType)) {
        return refuse(model, method, {
          reason:
            `${model} id ${id} has move_type "${moveType ?? "unknown"}"; "${method}" is only allowlisted for ` +
            `vendor bills (${rule.require_move_types.join(", ")}).`,
          policy_rule: "lifecycle_move_type_incompatible",
          next_step:
            "Use button_draft only on vendor bills (in_invoice / in_refund). Other move types: use the Odoo UI / a human."
        });
      }
    }

    const failed = failedGuardFields(rule, record);
    if (failed.length > 0) {
      return refuse(model, method, {
        reason:
          `${model} id ${id} does not satisfy ${failed.join(", ")}; Odoo withholds "${method}" for this record ` +
          "and the authenticated user (rights or record configuration).",
        policy_rule: "lifecycle_guard_failed",
        next_step: "Have a user authorised for this action perform it in Odoo, then retry the remaining steps."
      });
    }
  }

  const states = new Map<number, string | null>();
  for (const id of ids) states.set(id, stateOf(byId.get(id)!));
  return { ok: true, ids, states };
}

export type LifecycleActionRecord = {
  id: number;
  state_before: string | null;
  state_after: string | null;
};

export type LifecycleActionOutcome =
  | { ok: true; records: LifecycleActionRecord[] }
  | { ok: false; response: ToolResponse };

/**
 * Preflight, run an allowlisted lifecycle method, then re-read `state` as evidence the transition
 * actually landed. Used by the dedicated `billing.*` lifecycle tools; `call_model_method` uses the
 * preflight directly because it must return the method's raw result.
 */
export async function runLifecycleAction(opts: LifecycleCallOptions): Promise<LifecycleActionOutcome> {
  const { model, method, queue, getProps } = opts;

  const preflight = await preflightLifecycleCall(opts);
  if (!preflight.ok) return { ok: false, response: preflight.response };

  const { ids, states: before } = preflight;
  try {
    await queue.enqueue(requireConnection(getProps()), model, method, { ids });
  } catch (err) {
    return { ok: false, response: mcpErrorFromException(err, { model, method }) };
  }

  const after = await readLifecycleStates({ model, ids, queue, getProps });
  return {
    ok: true,
    records: ids.map((id) => ({
      id,
      state_before: before.get(id) ?? null,
      state_after: after.has(id) ? after.get(id)! : null
    }))
  };
}

/** Live `state` per id, for after-the-fact evidence. Never fails the caller. */
async function readLifecycleStates(opts: {
  model: string;
  ids: number[];
  queue: OdooQueue;
  getProps: () => Props | undefined;
}): Promise<Map<number, string | null>> {
  const { model, ids, queue, getProps } = opts;
  const states = new Map<number, string | null>();
  try {
    const rows = await queue.enqueue(requireConnection(getProps()), model, "read", { ids, fields: ["id", "state"] });
    if (Array.isArray(rows)) {
      for (const [id, record] of indexById(rows)) states.set(id, stateOf(record));
    }
  } catch {
    // Evidence only — a failed post-read must never fail an action Odoo already applied.
  }
  return states;
}
