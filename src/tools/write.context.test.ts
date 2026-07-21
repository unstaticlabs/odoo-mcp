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
      model: "account.move",
      record_id: 1,
      values: { amount_total: 0 },
      context: "declared intent on a blocked write"
    });

    expect(result.isError).toBe(true);
    const logged = log.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(logged).toContainEqual({
      event: "write_context",
      tool: "update_record",
      model: "account.move",
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
