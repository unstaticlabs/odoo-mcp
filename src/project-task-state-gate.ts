/**
 * Stateful gate for `project.task.state` on Odoo 19.
 *
 * Odoo 19 *computes* `04_waiting_normal` (Waiting) from `stage_id` + open `depend_on_ids`
 * (Blocked By). Waiting is therefore a consequence, never a status to write:
 *
 * - Writing `state = 04_waiting_normal` is refused by the **pure** classifier
 *   (`classifyProjectTask` in safety.ts) — no I/O needed. This module re-checks it as a
 *   belt-and-suspenders for callers that reach the gate by another route.
 * - Writing `state = 01_in_progress` while open blockers remain is refused **here**, because only a
 *   live read of `depend_on_ids` and the blockers' own `state` can tell: Odoo would immediately
 *   recompute the task back to Waiting, so the write is a silent no-op with a misleading result.
 *
 * Everything else is untouched. A write that omits `state` is never refused by this gate, even on a
 * task that is currently Waiting — stage, assignees, dates, dependencies and chatter stay editable.
 *
 * Mirrors `lifecycle-gate.ts`: pure policy lives elsewhere, this module owns the Odoo I/O.
 */

import type { PolicyRule } from "./lifecycle-allowlist";
import {
  isOpenBlockerState,
  PROJECT_TASK_IN_PROGRESS_STATE,
  PROJECT_TASK_WAITING_STATE
} from "./normalizer";
import type { OdooQueue } from "./odoo-queue";
import { WAITING_STATE_FORBIDDEN_NEXT_STEP, WAITING_STATE_FORBIDDEN_REASON } from "./safety";
import type { Props } from "./server";
import { mcpErrorFromException, mcpWriteBlockedError, requireConnection } from "./tools/shared";

export { OPEN_BLOCKER_EXEMPT_STATES } from "./normalizer";

type ToolResponse = ReturnType<typeof mcpWriteBlockedError> | ReturnType<typeof mcpErrorFromException>;

export type ProjectTaskStatePreflight = { ok: true } | { ok: false; response: ToolResponse };

/** Effective Blocked By set after applying a vals payload to a (possibly empty) live set. */
export type DependOnResolution = {
  ids: number[];
  /**
   * True when vals link a dependency created inline (`[0, 0, {...}]`), whose id cannot exist yet.
   * Such a blocker is brand new and therefore open, but has no id to report.
   */
  unresolved_new: boolean;
};

function toPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Apply an x2many payload for `depend_on_ids` to a base set of ids.
 *
 * Accepts the Odoo command forms the write tools document — `[[6,0,ids]]` (replace), `[[4,id]]`
 * (link), `[[3,id]]` / `[[2,id]]` (unlink/delete), `[[5]]` (clear), `[[0,0,vals]]` (create) — plus a
 * bare id list, which Odoo treats as a replace. Unrecognised commands are ignored rather than
 * guessed at; they cannot add a blocker we would have missed, because every adding form is handled.
 */
export function resolveEffectiveDependOnIds(base: readonly number[], value: unknown): DependOnResolution {
  const ids = new Set<number>(base);
  let unresolved_new = false;

  if (value === undefined) return { ids: [...ids], unresolved_new };
  if (value === false || value === null) return { ids: [], unresolved_new };
  if (!Array.isArray(value)) return { ids: [...ids], unresolved_new };

  // Bare id list (`depend_on_ids: [3, 7]`) — Odoo reads this as a full replace.
  if (value.every((entry) => typeof entry === "number")) {
    const replaced = value.map(toPositiveInt).filter((id): id is number => id != null);
    return { ids: [...new Set(replaced)], unresolved_new };
  }

  for (const command of value) {
    if (!Array.isArray(command) || command.length === 0) continue;
    const [op, arg, payload] = command as [unknown, unknown, unknown];
    const target = toPositiveInt(arg);
    switch (op) {
      case 0: // create a new related record and link it
        unresolved_new = true;
        break;
      case 1: // update a linked record — membership unchanged
        break;
      case 2: // delete
      case 3: // unlink
        if (target != null) ids.delete(target);
        break;
      case 4: // link existing
        if (target != null) ids.add(target);
        break;
      case 5: // unlink all
        ids.clear();
        break;
      case 6: // replace with the given id list
        ids.clear();
        if (Array.isArray(payload)) {
          for (const entry of payload) {
            const id = toPositiveInt(entry);
            if (id != null) ids.add(id);
          }
        }
        break;
      default:
        break;
    }
  }

  return { ids: [...ids], unresolved_new };
}

/** Effective Blocked By set for a `create` — there is no live record, so the base is empty. */
export function extractDependOnIdsFromVals(vals: Record<string, unknown>): DependOnResolution {
  return resolveEffectiveDependOnIds([], vals.depend_on_ids);
}

function refuse(
  method: string,
  opts: { reason: string; policy_rule: PolicyRule; next_step: string; relevant_state?: Record<string, unknown> }
): ProjectTaskStatePreflight {
  return {
    ok: false,
    response: mcpWriteBlockedError(
      { model: "project.task", method },
      {
        intent: "project_management",
        reason: opts.reason,
        policy_rule: opts.policy_rule,
        next_step: opts.next_step,
        refusing_layer: "connector_policy",
        recoverable: true,
        ...(opts.relevant_state ? { relevant_state: opts.relevant_state } : {})
      }
    )
  };
}

const IN_PROGRESS_NEXT_STEP =
  "Close or approve blockers (03_approved / 1_done / 1_canceled), or remove incorrect depend_on_ids, then retry.";

function blockedByRefusal(
  method: string,
  openBlockerIds: number[],
  dependOnIds: number[],
  unresolvedNew: boolean
): ProjectTaskStatePreflight {
  const named = openBlockerIds.length > 0 ? openBlockerIds.join(", ") : "a dependency created in this same call";
  return refuse(method, {
    reason:
      `Cannot set state=${PROJECT_TASK_IN_PROGRESS_STATE} while open blockers remain: ${named}. ` +
      "Odoo would recompute Waiting.",
    policy_rule: "in_progress_blocked_by_dependencies",
    next_step: IN_PROGRESS_NEXT_STEP,
    relevant_state: {
      open_blocker_ids: openBlockerIds,
      depend_on_ids: dependOnIds,
      ...(unresolvedNew ? { unresolved_new_dependency: true } : {})
    }
  });
}

export type ProjectTaskStateGateOptions = {
  method: string;
  /** Target ids for `write`; ignored for `create`. */
  ids?: unknown;
  /** Odoo JSON-2 body — `vals` for write, `vals_list` for create. */
  args: Record<string, unknown>;
  queue: OdooQueue;
  getProps: () => Props | undefined;
};

function valueRecords(args: Record<string, unknown>): Record<string, unknown>[] {
  const valsList = args.vals_list;
  if (Array.isArray(valsList)) {
    return valsList.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  }
  const vals = args.vals;
  if (vals && typeof vals === "object" && !Array.isArray(vals)) return [vals as Record<string, unknown>];
  return [];
}

function positiveIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const out: number[] = [];
  for (const id of ids) {
    const parsed = toPositiveInt(id);
    if (parsed != null) out.push(parsed);
  }
  return [...new Set(out)];
}

/** Read `state` for candidate blockers; ids Odoo does not return stay unknown, i.e. open. */
async function readBlockerStates(
  ids: number[],
  queue: OdooQueue,
  getProps: () => Props | undefined
): Promise<{ open: number[] } | { error: ToolResponse }> {
  try {
    const rows = await queue.enqueue(requireConnection(getProps()), "project.task", "read", {
      ids,
      fields: ["id", "state"]
    });
    const byId = new Map<number, unknown>();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const rec = row as Record<string, unknown>;
        const id = toPositiveInt(rec.id);
        if (id != null) byId.set(id, rec.state);
      }
    }
    return { open: ids.filter((id) => isOpenBlockerState(byId.get(id))) };
  } catch (err) {
    return { error: mcpErrorFromException(err, { model: "project.task", method: "read", record_ids: ids }) };
  }
}

/** Live `depend_on_ids` for the tasks being written to. */
async function readLiveDependOnIds(
  ids: number[],
  queue: OdooQueue,
  getProps: () => Props | undefined
): Promise<{ byId: Map<number, number[]> } | { error: ToolResponse }> {
  try {
    const rows = await queue.enqueue(requireConnection(getProps()), "project.task", "read", {
      ids,
      fields: ["id", "depend_on_ids"]
    });
    const byId = new Map<number, number[]>();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const rec = row as Record<string, unknown>;
        const id = toPositiveInt(rec.id);
        if (id != null) byId.set(id, positiveIds(rec.depend_on_ids));
      }
    }
    return { byId };
  } catch (err) {
    return { error: mcpErrorFromException(err, { model: "project.task", method: "read", record_ids: ids }) };
  }
}

/**
 * Refuse `project.task` state writes Odoo would compute away, before anything mutates.
 *
 * Costs no Odoo call unless the payload actually sets `state = 01_in_progress` on a task that has
 * (or is given) dependencies. Fails closed: an unreadable task or blocker refuses the write.
 */
export async function preflightProjectTaskStateWrite(
  opts: ProjectTaskStateGateOptions
): Promise<ProjectTaskStatePreflight> {
  const { method, queue, getProps } = opts;
  if (method !== "create" && method !== "write") return { ok: true };

  const records = valueRecords(opts.args);
  if (records.length === 0) return { ok: true };

  // Belt-and-suspenders: the pure classifier already refuses this on every gated path.
  if (records.some((rec) => rec.state === PROJECT_TASK_WAITING_STATE)) {
    return refuse(method, {
      reason: WAITING_STATE_FORBIDDEN_REASON,
      policy_rule: "waiting_state_forbidden",
      next_step: WAITING_STATE_FORBIDDEN_NEXT_STEP
    });
  }

  const inProgressRecords = records.filter((rec) => rec.state === PROJECT_TASK_IN_PROGRESS_STATE);
  if (inProgressRecords.length === 0) return { ok: true };

  if (method === "create") {
    for (const vals of inProgressRecords) {
      const resolved = extractDependOnIdsFromVals(vals);
      if (resolved.unresolved_new) return blockedByRefusal(method, [], resolved.ids, true);
      if (resolved.ids.length === 0) continue;
      const blockers = await readBlockerStates(resolved.ids, queue, getProps);
      if ("error" in blockers) return { ok: false, response: blockers.error };
      if (blockers.open.length > 0) return blockedByRefusal(method, blockers.open, resolved.ids, false);
    }
    return { ok: true };
  }

  const targetIds = positiveIds(opts.ids);
  if (targetIds.length === 0) return { ok: true };

  const live = await readLiveDependOnIds(targetIds, queue, getProps);
  if ("error" in live) return { ok: false, response: live.error };

  // A `write` carries one vals for every id, so the same commands apply on top of each live set.
  for (const vals of inProgressRecords) {
    for (const taskId of targetIds) {
      // An id the pre-read did not return is unvalidated — refuse rather than assume no blockers.
      if (!live.byId.has(taskId)) {
        return refuse(method, {
          reason:
            `Could not read depend_on_ids for project.task id ${taskId}; refusing to set ` +
            `state=${PROJECT_TASK_IN_PROGRESS_STATE} without knowing its open blockers.`,
          policy_rule: "in_progress_blocked_by_dependencies",
          next_step: "Verify the task id exists and is readable, then retry.",
          relevant_state: { open_blocker_ids: [], depend_on_ids: [] }
        });
      }
      const resolved = resolveEffectiveDependOnIds(live.byId.get(taskId)!, vals.depend_on_ids);
      if (resolved.unresolved_new) return blockedByRefusal(method, [], resolved.ids, true);
      if (resolved.ids.length === 0) continue;
      const blockers = await readBlockerStates(resolved.ids, queue, getProps);
      if ("error" in blockers) return { ok: false, response: blockers.error };
      if (blockers.open.length > 0) return blockedByRefusal(method, blockers.open, resolved.ids, false);
    }
  }

  return { ok: true };
}
