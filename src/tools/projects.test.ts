import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import type { OdooQueue } from "../odoo-queue";
import { registerProjectsTools } from "./projects";
import { validatedToolHandler } from "./structured-test-util";

const props = {
  odooBaseUrl: "http://example.com",
  odooDb: "test-db",
  odooApiKey: "secret-key",
  clientName: "test client"
};

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return {
    enqueue,
    snapshot: () => ({ odoo_calls: 0 }),
    delta: () => ({ odoo_calls: 0 })
  } as unknown as OdooQueue;
}

function buildProjectsServer(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerProjectsTools(server, () => props, queue, new TtlCache());
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return { server, handler };
}

describe("projects.* registration", () => {
  test("registers M1/M2 projects surface (reads + create_task)", () => {
    const { server } = buildProjectsServer(dispatchQueue(() => []));
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    for (const name of [
      "projects.list_projects",
      "projects.list_tasks",
      "projects.get_task",
      "projects.list_stages",
      "projects.list_chatter",
      "projects.create_task"
    ]) {
      expect(tools[name]).toBeDefined();
    }
    expect((tools["projects.create_task"] as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(
      false
    );
    expect((tools["projects.list_projects"] as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(
      true
    );
  });
});

describe("projects.create_task", () => {
  test("creates via vals_list with project_id and stamps provenance", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "create") return [501];
      return 99;
    });
    const { handler } = buildProjectsServer(queue);
    const create = handler("projects.create_task");

    const result = await create({
      name: "Lodge card for project 4",
      project_id: 4,
      description: "From Claude Code",
      tag_ids: [10, 11]
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe(501);
    expect(result.structuredContent?.trace_token).toMatch(/^src-[0-9a-f]{8}$/);
    expect(calls[0]).toEqual({
      model: "project.task",
      method: "create",
      args: {
        vals_list: [
          {
            name: "Lodge card for project 4",
            project_id: 4,
            description: "From Claude Code",
            tag_ids: [[6, 0, [10, 11]]]
          }
        ]
      }
    });
    expect(calls[1].method).toBe("message_post");
    expect(calls[1].args.ids).toEqual([501]);
    expect(String(calls[1].args.body)).toContain("[agent-source]");
    expect(String(result.content[0].text)).toContain(String(result.structuredContent?.trace_token));
  });

  test("named fields win over values overrides for name/project_id", async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((_model, method, args) => {
      if (method === "create") {
        calls.push({ args });
        return [7];
      }
      return 1;
    });
    const { handler } = buildProjectsServer(queue);

    await handler("projects.create_task")({
      name: "Correct",
      project_id: 4,
      values: { name: "Wrong", project_id: 99, priority: "1" }
    });

    const vals = (calls[0].args.vals_list as Record<string, unknown>[])[0];
    expect(vals.name).toBe("Correct");
    expect(vals.project_id).toBe(4);
    expect(vals.priority).toBe("1");
  });

  test("message_post failure still returns id with provenance_warning", async () => {
    const queue = dispatchQueue((_model, method) => {
      if (method === "create") return [88];
      throw new Error("chatter down");
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.create_task")({ name: "X", project_id: 4 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: 88,
      provenance_warning: "created task 88 but failed to post the provenance stamp (chatter down)"
    });
    expect(String(result.content[0].text)).not.toContain("secret-key");
  });

  test("Odoo create errors never echo the API key", async () => {
    const { OdooError } = await import("../odoo");
    const queue = dispatchQueue(() => {
      throw new OdooError({
        code: "permission_denied",
        message: "Access Denied",
        httpStatus: 403,
        model: "project.task",
        method: "create",
        details: "Access Denied"
      });
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.create_task")({ name: "X", project_id: 4 });

    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain(props.odooApiKey);
  });
});

describe("projects.create_task — Waiting is derived, not set", () => {
  test("state=04_waiting_normal returns write_blocked and never reaches Odoo", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return [1];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.create_task")({
      name: "Blocked work",
      project_id: 4,
      values: { state: "04_waiting_normal" }
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe("write_blocked");
    expect(body.model).toBe("project.task");
    expect(body.policy_rule).toBe("waiting_state_forbidden");
    expect(body.next_step).toContain("depend_on_ids");
    expect(body.recoverable).toBe(true);
    expect(calls).toEqual([]);
  });

  test("state=01_in_progress with an open blocker is refused with the blocker ids", async () => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((_model, method, args) => {
      calls.push({ method, args });
      if (method === "read") return [{ id: 9, state: "01_in_progress" }];
      return [1];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.create_task")({
      name: "Start now",
      project_id: 4,
      values: { state: "01_in_progress", depend_on_ids: [[6, 0, [9]]] }
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.policy_rule).toBe("in_progress_blocked_by_dependencies");
    expect(body.relevant_state).toEqual({ open_blocker_ids: [9], depend_on_ids: [9] });
    expect(calls.map((c) => c.method)).toEqual(["read"]);
  });

  test("state=01_in_progress without blockers creates normally", async () => {
    const queue = dispatchQueue((_model, method) => (method === "create" ? [77] : 1));
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.create_task")({
      name: "Start now",
      project_id: 4,
      values: { state: "01_in_progress" }
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe(77);
  });

  test("the tool description tells agents Waiting is derived from depend_on_ids", () => {
    const { server } = buildProjectsServer(dispatchQueue(() => []));
    const tools = (server as unknown as { _registeredTools: Record<string, { description: string }> })
      ._registeredTools;
    expect(tools["projects.create_task"].description).toContain("depend_on_ids");
    expect(tools["projects.create_task"].description).toContain("04_waiting_normal");
  });
});

describe("projects read tools", () => {
  test("list_projects searches project.project", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      return [{ id: 4, name: "Demo" }];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.list_projects")({ domain: [["id", "=", 4]] });

    expect(result.isError).toBeUndefined();
    expect(calls[0].model).toBe("project.project");
    expect(calls[0].method).toBe("search_read");
    expect(calls[0].args.domain).toEqual([["id", "=", 4]]);
    expect(result.structuredContent?.records).toEqual([{ id: 4, name: "Demo" }]);
  });

  test("get_task returns null when missing", async () => {
    const queue = dispatchQueue(() => []);
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.get_task")({ task_id: 999 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.record).toBeNull();
  });

  test("get_task projects state + depend_on_ids so Waiting can be explained", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      return [{ id: 42, name: "Ordinary", state: "01_in_progress", depend_on_ids: [] }];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.get_task")({ task_id: 42 });

    expect(calls[0].args.fields).toEqual(["id", "name", "stage_id", "project_id", "state", "depend_on_ids"]);
    // Not Waiting → no annotation, and no follow-up read.
    expect(result.structuredContent?.record).not.toHaveProperty("_waiting_derived");
    expect(calls).toHaveLength(1);
  });

  test("get_task annotates a Waiting task with its open blockers", async () => {
    const queue = dispatchQueue((_model, method, args) => {
      if (method === "search_read") {
        return [{ id: 42, name: "Successor", state: "04_waiting_normal", depend_on_ids: [9, 10] }];
      }
      expect(args.ids).toEqual([9, 10]);
      return [
        { id: 9, state: "01_in_progress", name: "Still open" },
        { id: 10, state: "1_done", name: "Finished" }
      ];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.get_task")({ task_id: 42 });

    const record = result.structuredContent?.record as Record<string, unknown>;
    expect(record._waiting_derived).toBe(true);
    expect(record._open_blocker_ids).toEqual([9]);
    expect(String(record._waiting_explanation)).toContain("depend_on_ids");
    expect(String(record._waiting_explanation)).toContain("9");
    expect(record._workflow_status).toBe("04_waiting_normal");
  });

  test("get_task calls a Waiting task with no open blockers stale", async () => {
    const queue = dispatchQueue((_model, method) => {
      if (method === "search_read") {
        return [{ id: 42, name: "Wedged", state: "04_waiting_normal", depend_on_ids: [] }];
      }
      return [];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.get_task")({ task_id: 42 });

    const record = result.structuredContent?.record as Record<string, unknown>;
    expect(record._open_blocker_ids).toEqual([]);
    expect(String(record._waiting_explanation)).toContain("stale");
    expect(String(record._waiting_explanation)).toContain("01_in_progress");
  });

  test("get_task degrades to 'blockers unknown' when the blocker read fails", async () => {
    const queue = dispatchQueue((_model, method) => {
      if (method === "search_read") {
        return [{ id: 42, name: "Successor", state: "04_waiting_normal", depend_on_ids: [9] }];
      }
      throw new Error("odoo down");
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.get_task")({ task_id: 42 });

    const record = result.structuredContent?.record as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect(record._waiting_derived).toBe(true);
    expect(record).not.toHaveProperty("_open_blocker_ids");
    expect(String(record._waiting_explanation)).toContain("could not be read");
  });

  test("list_stages scopes by project_id", async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((_model, _method, args) => {
      calls.push({ args });
      return [{ id: 1, name: "Inbox" }];
    });
    const { handler } = buildProjectsServer(queue);

    await handler("projects.list_stages")({ project_id: 4 });

    expect(calls[0].args.domain).toEqual([["project_ids", "in", [4]]]);
    expect(calls[0].args.order).toBe("sequence, id");
  });
});
