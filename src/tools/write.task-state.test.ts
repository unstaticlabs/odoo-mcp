/**
 * End-to-end guard tests for `project.task.state` across every generic write surface.
 *
 * Odoo 19 computes Waiting from open Blocked By dependencies, so the connector must refuse both
 * writing Waiting directly and writing In Progress that Odoo would immediately recompute away —
 * on create_record, update_record, batch_update and call_model_method alike.
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { validatedToolHandler } from "./structured-test-util";
import { registerWriteTools } from "./write";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

type Call = { model: string; method: string; args: Record<string, unknown> };

function buildHarness(responder: (model: string, method: string, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const call = { model: a[1] as string, method: a[2] as string, args: a[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call.model, call.method, call.args);
  });
  const queue = { enqueue } as unknown as OdooQueue;
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue);
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return { calls, handler };
}

function envelope(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/** Task 42 is blocked by open task 9; task 50 has no dependencies. */
function blockedTaskResponder(model: string, method: string, args: Record<string, unknown>): unknown {
  if (method === "read") {
    const fields = args.fields as string[];
    const ids = args.ids as number[];
    if (fields.includes("depend_on_ids")) {
      return ids.map((id) => ({ id, depend_on_ids: id === 42 ? [9] : [] }));
    }
    return ids.map((id) => ({ id, state: "01_in_progress" }));
  }
  if (method === "create") return [101];
  return true;
}

const WAITING_SURFACES = [
  {
    tool: "create_record",
    args: { model: "project.task", values: { name: "Blocked", project_id: 4, state: "04_waiting_normal" } },
    method: "create"
  },
  {
    tool: "update_record",
    args: { model: "project.task", record_id: 42, values: { state: "04_waiting_normal" } },
    method: "write"
  },
  {
    tool: "batch_update",
    args: {
      model: "project.task",
      updates: [{ record_id: 42, values: { state: "04_waiting_normal" } }]
    },
    method: "write"
  },
  {
    tool: "call_model_method",
    args: { model: "project.task", method: "write", ids: [42], kwargs: { vals: { state: "04_waiting_normal" } } },
    method: "write"
  }
] as const;

describe("write tools — state=04_waiting_normal is refused everywhere", () => {
  for (const surface of WAITING_SURFACES) {
    test(`${surface.tool} returns write_blocked and performs no Odoo write`, async () => {
      const { calls, handler } = buildHarness(blockedTaskResponder);

      const result = await handler(surface.tool)(surface.args);

      expect(result.isError).toBe(true);
      const body = envelope(result);
      expect(body.error).toBe("write_blocked");
      expect(body.intent).toBe("project_management");
      expect(body.model).toBe("project.task");
      expect(body.method).toBe(surface.method);
      expect(body.policy_rule).toBe("waiting_state_forbidden");
      expect(String(body.next_step)).toContain("depend_on_ids");
      expect(body.recoverable).toBe(true);
      expect(calls).toEqual([]);
    });
  }
});

describe("write tools — state=01_in_progress with open blockers", () => {
  test("update_record refuses and reports the open blocker ids", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("update_record")({
      model: "project.task",
      record_id: 42,
      values: { state: "01_in_progress" }
    });

    expect(result.isError).toBe(true);
    const body = envelope(result);
    expect(body.policy_rule).toBe("in_progress_blocked_by_dependencies");
    expect(body.relevant_state).toEqual({ open_blocker_ids: [9], depend_on_ids: [9] });
    expect(String(body.details)).toContain("recompute Waiting");
    expect(calls.every((c) => c.method === "read")).toBe(true);
  });

  test("call_model_method refuses the same write", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("call_model_method")({
      model: "project.task",
      method: "write",
      ids: [42],
      kwargs: { vals: { state: "01_in_progress" } }
    });

    expect(result.isError).toBe(true);
    expect(envelope(result).policy_rule).toBe("in_progress_blocked_by_dependencies");
    expect(calls.every((c) => c.method === "read")).toBe(true);
  });

  test("batch_update refuses before applying ANY update in the batch", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("batch_update")({
      model: "project.task",
      updates: [
        { record_id: 50, values: { stage_id: 7 } },
        { record_id: 42, values: { state: "01_in_progress" } }
      ]
    });

    expect(result.isError).toBe(true);
    expect(envelope(result).policy_rule).toBe("in_progress_blocked_by_dependencies");
    expect(calls.some((c) => c.method === "write")).toBe(false);
  });

  test("create_record refuses when the create itself links an open blocker", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("create_record")({
      model: "project.task",
      values: { name: "Start", project_id: 4, state: "01_in_progress", depend_on_ids: [[4, 9]] }
    });

    expect(result.isError).toBe(true);
    expect(envelope(result).relevant_state).toEqual({ open_blocker_ids: [9], depend_on_ids: [9] });
    expect(calls.some((c) => c.method === "create")).toBe(false);
  });
});

describe("write tools — In Progress is allowed once nothing blocks", () => {
  test("update_record on a task with no dependencies writes through", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("update_record")({
      model: "project.task",
      record_id: 50,
      values: { state: "01_in_progress" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.some((c) => c.method === "write")).toBe(true);
  });

  test("update_record clearing depend_on_ids in the same call writes through", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("update_record")({
      model: "project.task",
      record_id: 42,
      values: { state: "01_in_progress", depend_on_ids: [[5, 0, 0]] }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.some((c) => c.method === "write")).toBe(true);
  });

  test("update_record writes through once the blocker is done", async () => {
    const { calls, handler } = buildHarness((model, method, args) => {
      if (method === "read") {
        const fields = args.fields as string[];
        if (fields.includes("depend_on_ids")) return [{ id: 42, depend_on_ids: [9] }];
        return [{ id: 9, state: "1_done" }];
      }
      return true;
    });

    const result = await handler("update_record")({
      model: "project.task",
      record_id: 42,
      values: { state: "01_in_progress" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.some((c) => c.method === "write")).toBe(true);
  });

  test("create_record with no dependencies costs no extra Odoo read", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("create_record")({
      model: "project.task",
      values: { name: "Start", project_id: 4, state: "01_in_progress" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.some((c) => c.method === "read")).toBe(false);
  });
});

describe("write tools — non-state edits on a Waiting task stay allowed", () => {
  const edits: Record<string, unknown>[] = [
    { stage_id: 7 },
    { user_ids: [[6, 0, [3]]] },
    { date_deadline: "2026-08-01" },
    { depend_on_ids: [[4, 11]] },
    { name: "Renamed while waiting", description: "still editable" }
  ];

  for (const values of edits) {
    test(`update_record with ${Object.keys(values).join("+")} reaches Odoo`, async () => {
      const { calls, handler } = buildHarness(blockedTaskResponder);

      const result = await handler("update_record")({ model: "project.task", record_id: 42, values });

      expect(result.isError).toBeUndefined();
      // No state in the payload → the gate does not pre-read at all.
      expect(calls).toEqual([{ model: "project.task", method: "write", args: { ids: [42], vals: values } }]);
    });
  }

  test("post_message on a Waiting task is untouched", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("post_message")({
      model: "project.task",
      record_id: 42,
      body: "Still blocked on 9."
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0].method).toBe("message_post");
  });

  test("the guard is project.task-only — other models are unaffected", async () => {
    const { calls, handler } = buildHarness(blockedTaskResponder);

    const result = await handler("update_record")({
      model: "project.project",
      record_id: 4,
      values: { name: "Renamed" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toEqual({ model: "project.project", method: "write", args: { ids: [4], vals: { name: "Renamed" } } });
  });
});
