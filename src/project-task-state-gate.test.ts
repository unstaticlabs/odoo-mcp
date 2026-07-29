/**
 * Unit tests for the stateful project.task state gate.
 *
 * Two things are worth pinning down here: the effective Blocked By set after an x2many payload
 * (the only genuinely fiddly part), and the fail-closed behaviour when Odoo cannot be read.
 */
import { describe, expect, mock, test } from "bun:test";
import { isOpenBlockerState, OPEN_BLOCKER_EXEMPT_STATES } from "./normalizer";
import type { OdooQueue } from "./odoo-queue";
import {
  extractDependOnIdsFromVals,
  preflightProjectTaskStateWrite,
  resolveEffectiveDependOnIds
} from "./project-task-state-gate";
import type { Props } from "./server";

const props: Props = {
  odooBaseUrl: "http://example.com",
  odooDb: "test-db",
  odooApiKey: "secret-key"
} as Props;

/** Queue whose `read` returns the given rows, recording every call. */
function readQueue(
  responder: (args: Record<string, unknown>) => unknown
): { queue: OdooQueue; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const args = a[3] as Record<string, unknown>;
    calls.push({ model: a[1], method: a[2], ...args });
    return responder(args);
  });
  return { queue: { enqueue } as unknown as OdooQueue, calls };
}

function envelope(response: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(response.content[0].text);
}

describe("resolveEffectiveDependOnIds", () => {
  test("undefined vals leave the live set untouched", () => {
    expect(resolveEffectiveDependOnIds([3, 7], undefined)).toEqual({ ids: [3, 7], unresolved_new: false });
  });

  test("[[6,0,ids]] replaces the whole set", () => {
    expect(resolveEffectiveDependOnIds([3, 7], [[6, 0, [9]]])).toEqual({ ids: [9], unresolved_new: false });
  });

  test("[[4,id]] links and [[3,id]] unlinks against the live set", () => {
    expect(resolveEffectiveDependOnIds([3], [[4, 9]]).ids.sort()).toEqual([3, 9]);
    expect(resolveEffectiveDependOnIds([3, 9], [[3, 9]]).ids).toEqual([3]);
    expect(resolveEffectiveDependOnIds([3, 9], [[2, 3]]).ids).toEqual([9]);
  });

  test("[[5]] clears the set, in any of its arities", () => {
    expect(resolveEffectiveDependOnIds([3, 7], [[5]]).ids).toEqual([]);
    expect(resolveEffectiveDependOnIds([3, 7], [[5, 0, 0]]).ids).toEqual([]);
  });

  test("commands apply in order", () => {
    expect(resolveEffectiveDependOnIds([3], [[5, 0, 0], [4, 11], [4, 12], [3, 11]]).ids).toEqual([12]);
  });

  test("[[1,id,vals]] updates a linked record without changing membership", () => {
    expect(resolveEffectiveDependOnIds([3], [[1, 3, { name: "x" }]]).ids).toEqual([3]);
  });

  test("[[0,0,vals]] flags a dependency whose id cannot be known yet", () => {
    const resolved = resolveEffectiveDependOnIds([3], [[0, 0, { name: "new blocker" }]]);
    expect(resolved.unresolved_new).toBe(true);
    expect(resolved.ids).toEqual([3]);
  });

  test("a bare id list is a replace, and false clears", () => {
    expect(resolveEffectiveDependOnIds([3], [9, 10]).ids).toEqual([9, 10]);
    expect(resolveEffectiveDependOnIds([3], false).ids).toEqual([]);
  });

  test("extractDependOnIdsFromVals resolves a create against an empty base", () => {
    expect(extractDependOnIdsFromVals({ depend_on_ids: [[4, 5]] }).ids).toEqual([5]);
    expect(extractDependOnIdsFromVals({ name: "no deps" }).ids).toEqual([]);
  });
});

describe("open blocker classification", () => {
  test("only approved / done / cancelled blockers are closed", () => {
    expect([...OPEN_BLOCKER_EXEMPT_STATES].sort()).toEqual(["03_approved", "1_canceled", "1_done"]);
    for (const closed of ["03_approved", "1_done", "1_canceled"]) {
      expect(isOpenBlockerState(closed)).toBe(false);
    }
  });

  test("open, waiting and unknown states all count as open (fail closed)", () => {
    for (const open of ["01_in_progress", "04_waiting_normal", "02_changes_requested", "", false, undefined]) {
      expect(isOpenBlockerState(open)).toBe(true);
    }
  });
});

describe("preflightProjectTaskStateWrite — no state, no I/O", () => {
  test("a write without state never touches Odoo", async () => {
    const { queue, calls } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { stage_id: 7, user_ids: [[6, 0, [3]]], date_deadline: "2026-08-01" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a non-create/write method is out of scope", async () => {
    const { queue, calls } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "message_post",
      ids: [42],
      args: { ids: [42], body: "hi" },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  test("state=1_done needs no dependency read", async () => {
    const { queue, calls } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "1_done" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("preflightProjectTaskStateWrite — Waiting", () => {
  test("refuses state=04_waiting_normal without reading Odoo", async () => {
    const { queue, calls } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "04_waiting_normal" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = envelope(result.response);
    expect(body.error).toBe("write_blocked");
    expect(body.policy_rule).toBe("waiting_state_forbidden");
    expect(body.recoverable).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("preflightProjectTaskStateWrite — In Progress with open blockers", () => {
  test("create with an open blocker is refused with the blocker id", async () => {
    const { queue } = readQueue(() => [{ id: 9, state: "01_in_progress" }]);
    const result = await preflightProjectTaskStateWrite({
      method: "create",
      args: { vals_list: [{ name: "Start", project_id: 4, state: "01_in_progress", depend_on_ids: [[4, 9]] }] },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = envelope(result.response);
    expect(body.policy_rule).toBe("in_progress_blocked_by_dependencies");
    expect(body.relevant_state).toEqual({ open_blocker_ids: [9], depend_on_ids: [9] });
    expect(String(body.next_step)).toContain("03_approved");
  });

  test("create with only closed blockers is allowed", async () => {
    const { queue } = readQueue(() => [
      { id: 9, state: "1_done" },
      { id: 10, state: "03_approved" }
    ]);
    const result = await preflightProjectTaskStateWrite({
      method: "create",
      args: { vals_list: [{ name: "Start", state: "01_in_progress", depend_on_ids: [[6, 0, [9, 10]]] }] },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
  });

  test("create with no dependencies costs no Odoo call", async () => {
    const { queue, calls } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "create",
      args: { vals_list: [{ name: "Start", state: "01_in_progress" }] },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  test("create linking an inline-created blocker is refused", async () => {
    const { queue } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "create",
      args: { vals_list: [{ state: "01_in_progress", depend_on_ids: [[0, 0, { name: "new" }]] }] },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(envelope(result.response).policy_rule).toBe("in_progress_blocked_by_dependencies");
  });

  test("write merges vals commands onto the live depend_on_ids", async () => {
    const { queue, calls } = readQueue((args) => {
      const fields = args.fields as string[];
      if (fields.includes("depend_on_ids")) return [{ id: 42, depend_on_ids: [9, 10] }];
      return [
        { id: 10, state: "1_done" },
        { id: 11, state: "01_in_progress" }
      ];
    });
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      // Drops the open blocker 9, keeps done blocker 10, links open blocker 11.
      args: { ids: [42], vals: { state: "01_in_progress", depend_on_ids: [[3, 9], [4, 11]] } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = envelope(result.response);
    expect(body.relevant_state).toEqual({ open_blocker_ids: [11], depend_on_ids: [10, 11] });
    expect(calls[0].fields).toEqual(["id", "depend_on_ids"]);
  });

  test("write is allowed once the live blockers are all closed", async () => {
    const { queue } = readQueue((args) => {
      const fields = args.fields as string[];
      if (fields.includes("depend_on_ids")) return [{ id: 42, depend_on_ids: [9] }];
      return [{ id: 9, state: "1_canceled" }];
    });
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "01_in_progress" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
  });

  test("write is allowed when the same call empties depend_on_ids", async () => {
    const { queue } = readQueue(() => [{ id: 42, depend_on_ids: [9] }]);
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "01_in_progress", depend_on_ids: [[5, 0, 0]] } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(true);
  });

  test("a blocker Odoo does not return counts as open", async () => {
    const { queue } = readQueue((args) => {
      const fields = args.fields as string[];
      if (fields.includes("depend_on_ids")) return [{ id: 42, depend_on_ids: [9] }];
      return [];
    });
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "01_in_progress" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(envelope(result.response).relevant_state).toEqual({ open_blocker_ids: [9], depend_on_ids: [9] });
  });

  test("a target id missing from the pre-read is refused, not assumed unblocked", async () => {
    const { queue } = readQueue(() => []);
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "01_in_progress" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(envelope(result.response).policy_rule).toBe("in_progress_blocked_by_dependencies");
  });

  test("a failed pre-read fails closed", async () => {
    const { queue } = readQueue(() => {
      throw new Error("odoo down");
    });
    const result = await preflightProjectTaskStateWrite({
      method: "write",
      ids: [42],
      args: { ids: [42], vals: { state: "01_in_progress" } },
      queue,
      getProps: () => props
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.isError).toBe(true);
    expect(result.response.content[0].text).not.toContain("secret-key");
  });
});
