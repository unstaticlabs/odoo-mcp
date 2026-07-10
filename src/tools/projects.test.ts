import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { FINANCE_KEYWORD_PM_TEXT } from "../write-safety.fixtures";
import { registerProjectWriteTools } from "./projects";
import { plaintextToHtml } from "./shared";
import { validatedToolHandler } from "./structured-test-util";

interface StubCall {
  conn: unknown;
  model: string;
  method: string;
  args: Record<string, unknown>;
}

function makeStubQueue({ createId = 99 }: { createId?: number } = {}) {
  const calls: StubCall[] = [];
  return {
    calls,
    enqueue(conn: unknown, model: string, method: string, args: Record<string, unknown>) {
      calls.push({ conn, model, method, args });
      if (method === "create") return Promise.resolve([createId]);
      if (method === "message_post") return Promise.resolve(123);
      return Promise.resolve(true);
    }
  };
}

function buildProjectsAgent(queue: ReturnType<typeof makeStubQueue>) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "key" };
  registerProjectWriteTools(server, () => props, queue as unknown as OdooQueue);
  return server;
}

function hasBookkeepingCall(calls: StubCall[]) {
  return calls.some((c) => c.model.startsWith("bookkeeping") || c.method.startsWith("bookkeeping"));
}

describe("projects.create_activity", () => {
  test("correct Odoo shape + finance keywords", async () => {
    const queue = makeStubQueue({ createId: 501 });
    const server = buildProjectsAgent(queue);
    const handler = validatedToolHandler(server, "projects.create_activity");

    const result = await handler({
      task_id: 42,
      user_id: 7,
      activity_type_id: 4,
      date_deadline: "2026-07-15",
      summary: FINANCE_KEYWORD_PM_TEXT.activitySummary,
      note: FINANCE_KEYWORD_PM_TEXT.activityNote
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id: 501 });
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]).toEqual({
      conn: expect.anything(),
      model: "mail.activity",
      method: "create",
      args: {
        vals_list: [
          {
            res_model: "project.task",
            res_id: 42,
            summary: FINANCE_KEYWORD_PM_TEXT.activitySummary,
            note: FINANCE_KEYWORD_PM_TEXT.activityNote,
            date_deadline: "2026-07-15",
            user_id: 7,
            activity_type_id: 4
          }
        ]
      }
    });
    expect(hasBookkeepingCall(queue.calls)).toBe(false);
  });
});

describe("projects.post_note", () => {
  test("message_post shape + HTML escaping", async () => {
    const queue = makeStubQueue();
    const server = buildProjectsAgent(queue);
    const handler = validatedToolHandler(server, "projects.post_note");
    const note = FINANCE_KEYWORD_PM_TEXT.chatterBody;

    const result = await handler({ task_id: 55, note, body_is_html: false });

    expect(result.isError).toBeUndefined();
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]).toEqual({
      conn: expect.anything(),
      model: "project.task",
      method: "message_post",
      args: {
        ids: [55],
        body: plaintextToHtml(note),
        body_is_html: true,
        message_type: "comment"
      }
    });
    expect(hasBookkeepingCall(queue.calls)).toBe(false);
  });

  test("passes HTML body verbatim when body_is_html is true", async () => {
    const queue = makeStubQueue();
    const server = buildProjectsAgent(queue);
    const handler = validatedToolHandler(server, "projects.post_note");
    const html = "<p>B2C <strong>banking</strong> export</p>";

    await handler({ task_id: 12, note: html, body_is_html: true });

    expect(queue.calls[0].args.body).toBe(html);
    expect(queue.calls[0].args.body_is_html).toBe(true);
  });
});

describe("projects.update_task", () => {
  test("write shape + finance-keyword description", async () => {
    const queue = makeStubQueue();
    const server = buildProjectsAgent(queue);
    const handler = validatedToolHandler(server, "projects.update_task");

    const result = await handler({
      task_id: 990,
      description: FINANCE_KEYWORD_PM_TEXT.taskDescription
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true });
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]).toEqual({
      conn: expect.anything(),
      model: "project.task",
      method: "write",
      args: {
        ids: [990],
        vals: { description: FINANCE_KEYWORD_PM_TEXT.taskDescription }
      }
    });
    expect(hasBookkeepingCall(queue.calls)).toBe(false);
  });

  test("rejects empty update", async () => {
    const queue = makeStubQueue();
    const server = buildProjectsAgent(queue);
    const handler = validatedToolHandler(server, "projects.update_task");

    const result = await handler({ task_id: 1 });

    expect(result.isError).toBe(true);
    expect(queue.calls).toHaveLength(0);
  });
});

describe("registerProjectWriteTools — registration smoke", () => {
  test("registers exactly the three project write tools", () => {
    const queue = makeStubQueue();
    const server = buildProjectsAgent(queue);
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

    for (const name of ["projects.create_activity", "projects.post_note", "projects.update_task"]) {
      expect(registry[name]).toBeDefined();
    }
    expect(Object.keys(registry).filter((k) => k.startsWith("projects."))).toHaveLength(3);
  });
});

describe("registerProjectWriteTools — metadata", () => {
  test("each tool has write annotations and bookkeeping steering in description", () => {
    const queue = makeStubQueue();
    const server = buildProjectsAgent(queue);
    const registry = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean }; description?: string }>;
      }
    )._registeredTools;

    for (const name of ["projects.create_activity", "projects.post_note", "projects.update_task"]) {
      const tool = registry[name];
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.description).toContain("bookkeeping.plan_safe_write");
    }
  });
});
