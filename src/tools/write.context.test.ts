import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { registerBillingWriteTools } from "./billing";
import { logWriteContext } from "./shared";
import { validatedToolHandler } from "./structured-test-util";
import { registerWriteTools } from "./write";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return { enqueue } as unknown as OdooQueue;
}

function buildWriteHandlers(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue);
  registerBillingWriteTools(server, () => props, queue);
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return {
    createRecord: handler("create_record"),
    updateRecord: handler("update_record"),
    deleteRecord: handler("delete_record"),
    batchUpdate: handler("batch_update"),
    callModelMethod: handler("call_model_method"),
    updateExpense: handler("billing.update_draft_expense")
  };
}

describe("logWriteContext", () => {
  afterEach(() => {
    mock.restore();
  });

  test("logs a structured line when context is present, nothing otherwise", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    logWriteContext("update_record", "project.task", "user asked to rename task 7");
    logWriteContext("update_record", "project.task", undefined);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      event: "write_context",
      tool: "update_record",
      model: "project.task",
      context: "user asked to rename task 7"
    });
  });
});

describe("context param on write tools", () => {
  afterEach(() => {
    mock.restore();
  });

  test("update_record accepts context, logs it, and never forwards it to Odoo", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const calls: Record<string, unknown>[] = [];
    const queue = dispatchQueue((_model, _method, args) => {
      calls.push(args);
      return true;
    });
    const { updateRecord } = buildWriteHandlers(queue);

    const result = await updateRecord({
      model: "project.task",
      record_id: 7,
      values: { name: "Renamed" },
      context: "user asked to rename task 7"
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([{ ids: [7], vals: { name: "Renamed" } }]);
    const logged = log.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(logged).toContainEqual({
      event: "write_context",
      tool: "update_record",
      model: "project.task",
      context: "user asked to rename task 7"
    });
  });

  test("writes without context log nothing", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const queue = dispatchQueue(() => true);
    const { updateRecord } = buildWriteHandlers(queue);

    await updateRecord({ model: "project.task", record_id: 7, values: { name: "X" } });

    const events = log.mock.calls
      .map((c: unknown[]) => {
        try {
          return (JSON.parse(c[0] as string) as { event?: string }).event;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(events).not.toContain("write_context");
  });

  test("context is logged even when the safety gate blocks the write", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const queue = dispatchQueue(() => true);
    const { updateRecord } = buildWriteHandlers(queue);

    const result = await updateRecord({
      model: "project.task",
      record_id: 1,
      values: { sale_line_id: 99 },
      context: "declared intent on a blocked write"
    });

    expect(result.isError).toBe(true);
    const logged = log.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(logged).toContainEqual({
      event: "write_context",
      tool: "update_record",
      model: "project.task",
      context: "declared intent on a blocked write"
    });
  });

  test("create_record and delete_record accept context without altering Odoo call shapes", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((_model, method, args) => {
      calls.push({ method, args });
      if (method === "create") return [5];
      return true;
    });
    const { createRecord, deleteRecord } = buildWriteHandlers(queue);

    await createRecord({ model: "project.tags", values: { name: "urgent" }, context: "user wants an urgent tag" });
    await deleteRecord({ model: "project.tags", record_id: 5, context: "user asked to remove the tag" });

    expect(calls).toEqual([
      { method: "create", args: { vals_list: [{ name: "urgent" }] } },
      { method: "unlink", args: { ids: [5] } }
    ]);
  });

  test("batch_update logs one context line for the whole batch", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const queue = dispatchQueue(() => true);
    const { batchUpdate } = buildWriteHandlers(queue);

    await batchUpdate({
      model: "project.task",
      updates: [
        { record_id: 1, values: { name: "A" } },
        { record_id: 2, values: { name: "B" } }
      ],
      context: "user asked to rename two tasks"
    });

    const contextLines = log.mock.calls.filter((c: unknown[]) => String(c[0]).includes("write_context"));
    expect(contextLines.length).toBe(1);
  });

  test("billing.update_draft_expense accepts context and keeps the write payload clean", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((_model, method, args) => {
      calls.push({ method, args });
      if (method === "read") return [{ id: 394, state: "draft" }];
      return true;
    });
    const { updateExpense } = buildWriteHandlers(queue);

    const result = await updateExpense({
      record_id: 394,
      values: { date: "2026-07-04" },
      context: "user asked to correct the expense date"
    });

    expect(result.isError).toBeUndefined();
    expect(calls[1]).toEqual({ method: "write", args: { ids: [394], vals: { date: "2026-07-04" } } });
    const logged = log.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(logged).toContainEqual({
      event: "write_context",
      tool: "billing.update_draft_expense",
      model: "hr.expense",
      context: "user asked to correct the expense date"
    });
  });
});

describe("call_model_method — reversible lifecycle preflight", () => {
  afterEach(() => {
    mock.restore();
  });

  test("allowlisted action_reset with compatible state + context reaches Odoo enqueue", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 394, state: "approved" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);

    const reset = await callModelMethod({
      model: "hr.expense",
      method: "action_reset",
      ids: [394],
      context: "user asked to reset expense 394 to draft for date correction"
    });
    expect(reset.isError).toBeUndefined();
    expect(calls.some((c) => c.method === "action_reset")).toBe(true);
    expect(calls.find((c) => c.method === "action_reset")?.args).toEqual({ ids: [394] });
    expect(calls.find((c) => c.method === "action_reset")?.args).not.toHaveProperty("context");

    // After reset, draft billing update still works.
    const draftQueue = dispatchQueue((_model, method) => {
      if (method === "read") return [{ id: 394, state: "draft" }];
      return true;
    });
    const { updateExpense: updateDraft } = buildWriteHandlers(draftQueue);
    const upd = await updateDraft({
      record_id: 394,
      values: { date: "2026-07-04" },
      context: "user asked to fix the date after reset"
    });
    expect(upd.isError).toBeUndefined();
  });

  test("action_submit happy path with draft state + context reaches enqueue", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      if (method === "read") return [{ id: 10, state: "draft" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "hr.expense",
      method: "action_submit",
      ids: [10],
      context: "user asked to submit expense 10"
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["read", "action_submit"]);
  });

  test("action_approve happy path with submitted state + context reaches enqueue", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      if (method === "read") return [{ id: 11, state: "submitted" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "hr.expense",
      method: "action_approve",
      ids: [11],
      context: "manager approved expense 11"
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["read", "action_approve"]);
  });

  test("sheet action_submit_sheet happy path (pre-19 model) reaches enqueue", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      if (method === "read") return [{ id: 5, state: "draft" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "hr.expense.sheet",
      method: "action_submit_sheet",
      ids: [5],
      context: "user asked to submit expense sheet 5"
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["read", "action_submit_sheet"]);
  });

  test("sheet action_approve_expense_sheets and action_reset_expense_sheets happy paths", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const approveQueue = dispatchQueue((_model, method) => {
      if (method === "read") return [{ id: 6, state: "submit" }];
      return true;
    });
    const { callModelMethod: approveCall } = buildWriteHandlers(approveQueue);
    const approved = await approveCall({
      model: "hr.expense.sheet",
      method: "action_approve_expense_sheets",
      ids: [6],
      context: "manager approved sheet 6"
    });
    expect(approved.isError).toBeUndefined();

    const resetQueue = dispatchQueue((_model, method) => {
      if (method === "read") return [{ id: 7, state: "approve" }];
      return true;
    });
    const { callModelMethod: resetCall } = buildWriteHandlers(resetQueue);
    const reset = await resetCall({
      model: "hr.expense.sheet",
      method: "action_reset_expense_sheets",
      ids: [7],
      context: "user asked to reset sheet 7 to draft"
    });
    expect(reset.isError).toBeUndefined();
  });

  test("button_draft happy path on vendor bill reaches enqueue", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((_model, method, args) => {
      calls.push({ method, args });
      if (method === "read") return [{ id: 9, state: "cancel", move_type: "in_invoice" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "user asked to reset cancelled vendor bill 9 to draft"
    });
    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["read", "button_draft"]);
    expect(calls.find((c) => c.method === "read")?.args.fields).toEqual(["id", "state"]);
  });

  test("partial pre-read (fewer rows than ids) refuses before mutate", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      // Odoo often omits missing ids silently — only return one of two requested.
      if (method === "read") return [{ id: 1, state: "approved" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "hr.expense",
      method: "action_reset",
      ids: [1, 2],
      context: "user asked to reset expenses 1 and 2"
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_ids_invalid");
    expect(envelope.details).toContain("2");
    expect(calls).toEqual(["read"]);
  });

  test("empty ids list uses lifecycle_ids_invalid not state_incompatible", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "hr.expense",
      method: "action_reset",
      ids: [],
      context: "user asked to reset"
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_ids_invalid");
    expect(calls).toEqual([]);
  });

  test("missing context blocks allowlisted lifecycle before mutate", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);

    const result = await callModelMethod({
      model: "hr.expense",
      method: "action_reset",
      ids: [394]
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(envelope.policy_rule).toBe("lifecycle_context_required");
    expect(envelope.recoverable).toBe(true);
    expect(calls).toEqual([]);
  });

  test("incompatible state blocks before mutate", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      if (method === "read") return [{ id: 394, state: "draft" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);

    const result = await callModelMethod({
      model: "hr.expense",
      method: "action_reset",
      ids: [394],
      context: "user asked to reset"
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_state_incompatible");
    expect(envelope.details).toContain("draft");
    expect(calls).toEqual(["read"]);
  });

  test("action_post requires confirmation even with context (no keyword bypass)", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);

    const result = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      context: "please post this invoice urgently for payment"
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("confirmation_required");
    expect(envelope.policy_rule).toBe("irreversible_confirmation_required");
    expect(envelope.risk_class).toBe("irreversible_posting");
    expect(envelope.next_step).toMatch(/confirmation/i);
    expect(calls).toEqual([]);
  });

  test("CRUD write on hr.expense via update_record reaches Odoo (no prefix deny)", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { updateRecord } = buildWriteHandlers(queue);
    const result = await updateRecord({
      model: "hr.expense",
      record_id: 394,
      values: { date: "2026-07-04" },
      context: "try generic write"
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["write"]);
  });

  test("button_draft on customer invoice reaches Odoo (move_type no longer connector-gated)", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      if (method === "read") return [{ id: 9, state: "cancel", move_type: "out_invoice" }];
      return true;
    });
    const { callModelMethod } = buildWriteHandlers(queue);
    const result = await callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "user asked to reset customer invoice"
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["read", "button_draft"]);
  });
});
