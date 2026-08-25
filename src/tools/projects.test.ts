import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import { OdooError } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import { FINANCE_KEYWORD_PM_TEXT } from "../write-safety.fixtures";
import { registerProjectsTools, registerProjectWriteTools } from "./projects";
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

/** Verbatim Odoo 19 text for a field gated behind a group the API user is not in. */
function aclFieldError(field: string): OdooError {
  const details =
    `You do not have enough rights to access the field "${field}" on Project (project.project). ` +
    "Operation: read. Groups: allowed for groups 'Use Stages on Project'.";
  return new OdooError({
    message: details,
    code: "permission_denied",
    httpStatus: 403,
    model: "project.project",
    method: "search_read",
    details
  });
}

function buildProjectsServer(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerProjectsTools(server, () => props, queue, new TtlCache());
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return { server, handler };
}

describe("projects.* registration", () => {
  test("registers M1/M2 projects surface (reads + create_task + attach_file)", () => {
    const { server } = buildProjectsServer(dispatchQueue(() => []));
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    for (const name of [
      "projects.list_projects",
      "projects.list_tasks",
      "projects.get_task",
      "projects.list_stages",
      "projects.list_chatter",
      "projects.create_task",
      "projects.attach_file"
    ]) {
      expect(tools[name]).toBeDefined();
    }
    expect((tools["projects.create_task"] as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(
      false
    );
    expect((tools["projects.list_projects"] as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(
      true
    );

    const attach = tools["projects.attach_file"] as {
      description: string;
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
    };
    expect(attach.annotations.readOnlyHint).toBe(false);
    expect(attach.annotations.destructiveHint).toBe(false);
    expect(attach.annotations.openWorldHint).toBe(false);
    expect(String(attach.description).startsWith("Write:")).toBe(true);
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
      web_url: "http://example.com/odoo/project/4/tasks/88",
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
    expect(tools["projects.create_task"].description).toContain("stage_id");
    expect(tools["projects.create_task"].description).toMatch(/deferred|On Hold/i);
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
    expect(result.structuredContent?.records).toEqual([
      { id: 4, name: "Demo", _web_url: "http://example.com/odoo/project/4" }
    ]);
  });

  test("list_projects default fields exclude the ACL-gated stage_id", async () => {
    const calls: Record<string, unknown>[] = [];
    const queue = dispatchQueue((_model, _method, args) => {
      calls.push(args);
      return [{ id: 4, name: "Demo", partner_id: [7, "ACME"], user_id: [2, "Mitchell"] }];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.list_projects")({});

    expect(calls).toHaveLength(1);
    expect(calls[0].fields).toEqual(["id", "name", "partner_id", "user_id"]);
    expect(calls[0].fields).not.toContain("stage_id");
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent?.records as Record<string, unknown>[])[0]._web_url).toBe(
      "http://example.com/odoo/project/4"
    );
    expect(result.structuredContent?.warnings).toEqual([]);
  });

  test("list_projects degrades instead of failing when Odoo refuses an explicitly requested field", async () => {
    const calls: Record<string, unknown>[] = [];
    const queue = dispatchQueue((_model, _method, args) => {
      calls.push(args);
      if ((args.fields as string[]).includes("stage_id")) throw aclFieldError("stage_id");
      return [{ id: 4, name: "Demo" }];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.list_projects")({ fields: ["id", "name", "stage_id"] });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1].fields).toEqual(["id", "name"]);
    expect(result.structuredContent?.records).toEqual([
      { id: 4, name: "Demo", _web_url: "http://example.com/odoo/project/4" }
    ]);
    expect(result.structuredContent?.omitted_fields).toContainEqual({ field: "stage_id", reason: "acl-denied" });
    expect((result.structuredContent?.warnings as string[]).some((w) => w.includes("stage_id"))).toBe(true);
  });

  test("list_projects with readable explicit fields is unchanged — one call, no warnings", async () => {
    const calls: Record<string, unknown>[] = [];
    const queue = dispatchQueue((_model, _method, args) => {
      calls.push(args);
      return [{ id: 4, name: "Demo" }];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.list_projects")({ fields: ["id", "name"] });

    expect(calls).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.returned_fields).toEqual(["id", "name"]);
    expect(result.structuredContent?.omitted_fields).toEqual([]);
    expect(result.structuredContent?.warnings).toEqual([]);
  });

  test("list_projects still fails closed when id itself is unreadable", async () => {
    const calls: Record<string, unknown>[] = [];
    const queue = dispatchQueue((_model, _method, args) => {
      calls.push(args);
      throw aclFieldError("id");
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.list_projects")({});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.refusing_layer).toBe("odoo_acl");
    expect(envelope.model).toBe("project.project");
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

    const result = await handler("projects.list_stages")({ project_id: 4 });

    expect(calls[0].args.domain).toEqual([["project_ids", "in", [4]]]);
    expect(calls[0].args.order).toBe("sequence, id");
    // Stages are linkable too — Task Stages is a real Odoo action path (ODOO2272).
    expect(result.structuredContent?.records).toEqual([
      { id: 1, name: "Inbox", _web_url: "http://example.com/odoo/task-stages/1" }
    ]);
  });
});

describe("projects.attach_file", () => {
  /** "hello" — 5 decoded bytes. */
  const HELLO_B64 = "aGVsbG8=";

  type ZodLike = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

  function attachSchema(): Record<string, ZodLike> {
    const { server } = buildProjectsServer(dispatchQueue(() => []));
    const tools = (
      server as unknown as { _registeredTools: Record<string, { inputSchema: { shape: Record<string, ZodLike> } }> }
    )._registeredTools;
    return tools["projects.attach_file"].inputSchema.shape;
  }

  function envelope(result: ToolResult): Record<string, unknown> {
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  test("input schema requires context, non-empty datas, a real task_id and project.task", () => {
    const shape = attachSchema();

    expect(shape.context.safeParse("").success).toBe(false);
    expect(shape.context.safeParse(undefined).success).toBe(false);
    expect(shape.context.safeParse("Attaching the Q3 audit workbook.").success).toBe(true);

    expect(shape.datas.safeParse("").success).toBe(false);

    expect(shape.task_id.safeParse(0).success).toBe(false);
    expect(shape.task_id.safeParse(1.5).success).toBe(false);

    expect(shape.res_model.safeParse("account.move").success).toBe(false);
    expect(shape.res_model.parse(undefined)).toBe("project.task");
  });

  test("creates one binary ir.attachment linked to the task and returns its id", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (model === "project.task" && method === "read") return [{ id: 88, name: "Q3 audit" }];
      if (model === "ir.attachment" && method === "create") return [7101];
      throw new Error(`unexpected call ${model}.${method}`);
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 88,
      name: "q3-audit-workbook.xlsx",
      datas: HELLO_B64,
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      context: "Attaching the generated Q3 audit workbook as evidence."
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      attachment_id: 7101,
      task_id: 88,
      res_model: "project.task",
      res_id: 88,
      name: "q3-audit-workbook.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      file_size: 5
    });

    expect(calls).toHaveLength(2);
    const create = calls[1];
    expect(create.model).toBe("ir.attachment");
    expect(create.method).toBe("create");
    const vals = (create.args.vals_list as Record<string, unknown>[])[0];
    expect(vals).toMatchObject({
      name: "q3-audit-workbook.xlsx",
      type: "binary",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      res_model: "project.task",
      res_id: 88
    });
    expect(vals.datas).toBe(HELLO_B64);
    // Write context is audit-only — it must never reach Odoo.
    expect(vals).not.toHaveProperty("context");

    // The task is read, never mutated; no existing attachment is touched.
    for (const call of calls) {
      expect(["write", "unlink"]).not.toContain(call.method);
    }
  });

  test("defaults mimetype to application/octet-stream", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (model === "project.task") return [{ id: 5, name: "Task" }];
      return [900];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 5,
      name: "evidence.bin",
      datas: HELLO_B64,
      context: "Evidence upload."
    });

    expect(result.structuredContent?.mimetype).toBe("application/octet-stream");
    expect((calls[1].args.vals_list as Record<string, unknown>[])[0].mimetype).toBe("application/octet-stream");
  });

  test("refuses an unknown task before creating anything", async () => {
    const calls: { model: string; method: string }[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push({ model, method });
      return [];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 4242,
      name: "evidence.bin",
      datas: HELLO_B64,
      context: "Evidence upload."
    });

    expect(result.isError).toBe(true);
    const env = envelope(result);
    expect(env.error).toBe("not_found");
    expect(env.model).toBe("project.task");
    expect(calls).toEqual([{ model: "project.task", method: "read" }]);
  });

  test("refuses a non-project.task res_model that slipped past the schema", async () => {
    const calls: unknown[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push({ model, method });
      return [];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 88,
      name: "evidence.bin",
      datas: HELLO_B64,
      res_model: "account.move",
      context: "Evidence upload."
    });

    expect(result.isError).toBe(true);
    expect(envelope(result).error).toBe("invalid_res_model");
    expect(calls).toHaveLength(0);
  });

  test("refuses invalid base64 with zero Odoo calls", async () => {
    const calls: unknown[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push({ model, method });
      return [];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 88,
      name: "evidence.bin",
      datas: "not base64!!",
      context: "Evidence upload."
    });

    expect(result.isError).toBe(true);
    expect(envelope(result).error).toBe("invalid_base64");
    expect(calls).toHaveLength(0);
  });

  test("refuses a payload over max_bytes with zero Odoo calls, naming both sizes", async () => {
    const calls: unknown[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push({ model, method });
      return [];
    });
    const { handler } = buildProjectsServer(queue);

    // 30 decoded bytes against a 16-byte cap.
    const datas = btoa("a".repeat(30));
    const result = await handler("projects.attach_file")({
      task_id: 88,
      name: "big.bin",
      datas,
      max_bytes: 16,
      context: "Evidence upload."
    });

    expect(result.isError).toBe(true);
    const env = envelope(result);
    expect(env.error).toBe("oversize");
    expect(String(env.details)).toContain("30");
    expect(String(env.details)).toContain("16");
    expect(calls).toHaveLength(0);
  });

  test("refuses base64 that decodes to zero bytes", async () => {
    const calls: unknown[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push({ model, method });
      return [];
    });
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 88,
      name: "empty.bin",
      datas: "   ",
      context: "Evidence upload."
    });

    expect(result.isError).toBe(true);
    expect(envelope(result).error).toBe("empty_datas");
    expect(calls).toHaveLength(0);
  });

  test("issues no confirmation token — attachment creation is reversible", async () => {
    const queue = dispatchQueue((model) => (model === "project.task" ? [{ id: 88, name: "Q3" }] : [7101]));
    const { handler } = buildProjectsServer(queue);

    const result = await handler("projects.attach_file")({
      task_id: 88,
      name: "evidence.bin",
      datas: HELLO_B64,
      context: "Evidence upload."
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty("confirmation_token");
    expect(result.structuredContent).not.toHaveProperty("confirmation_required");
  });
});

/**
 * Fixed-intent PM writes (projects.create_activity / post_note / update_task).
 *
 * Deliberately no import of the bookkeeping module anywhere in this file: these tools must reach
 * Odoo directly, and the "no bookkeeping.* code path" claim is only credible if the module is
 * never linked in. Isolation is proved by recorded (model, method, args) triples + registry checks.
 */
type WriteCall = { model: string; method: string; args: Record<string, unknown> };

const PM_MODELS = new Set(["project.task", "mail.activity"]);
const PM_METHODS = new Set(["create", "write", "message_post"]);
/** Substrings that would indicate an accounting/bookkeeping code path. */
const FORBIDDEN_MODEL_PREFIXES = ["account.", "hr.payslip", "res.partner.bank", "res.company"];

/** Every call any write-suite queue sees this test file over, asserted in afterEach. */
const allWriteCalls: WriteCall[] = [];

function buildProjectWriteServer(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  // Central recorder: every enqueue lands here regardless of the per-test responder.
  const wrapped = {
    enqueue: async (...a: unknown[]) => {
      allWriteCalls.push({
        model: a[1] as string,
        method: a[2] as string,
        args: a[3] as Record<string, unknown>
      });
      return (queue.enqueue as (...args: unknown[]) => Promise<unknown>)(...a);
    },
    snapshot: () => queue.snapshot(),
    delta: (s: number) => queue.delta(s)
  } as unknown as OdooQueue;
  registerProjectWriteTools(server, () => props, wrapped);
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return { server, handler };
}

/** Queue that records every enqueued call and answers create/message_post/write plausibly. */
function recordingQueue(calls: WriteCall[], responder?: (call: WriteCall) => unknown): OdooQueue {
  return dispatchQueue((model, method, args) => {
    const call = { model, method, args };
    calls.push(call);
    if (responder) return responder(call);
    if (method === "create") return [901];
    if (method === "message_post") return 4242;
    return true;
  });
}

afterEach(() => {
  for (const call of allWriteCalls) {
    expect(PM_MODELS.has(call.model), `non-PM model reached Odoo: ${call.model}`).toBe(true);
    expect(PM_METHODS.has(call.method), `unexpected method: ${call.method}`).toBe(true);
    for (const prefix of FORBIDDEN_MODEL_PREFIXES) {
      expect(call.model.startsWith(prefix), `${call.model} looks like an accounting model`).toBe(false);
    }
    expect(call.method).not.toBe("plan_safe_write");
    expect(JSON.stringify(call.args)).not.toContain("plan_safe_write");
  }
  allWriteCalls.length = 0;
});

describe("projects.* write registration", () => {
  test("registers exactly the three fixed-intent PM write tools", () => {
    const bare = new McpServer({ name: "test", version: "0.0.0" });
    const baseNames = Object.keys((bare as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const { server } = buildProjectWriteServer(dispatchQueue(() => []));
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

    expect(new Set(names.filter((n) => !baseNames.includes(n)))).toEqual(
      new Set(["projects.create_activity", "projects.post_note", "projects.update_task"])
    );
  });

  test("newly registered names are projects.* only — never bookkeeping.*", () => {
    const bare = new McpServer({ name: "test", version: "0.0.0" });
    const baseNames = Object.keys((bare as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const { server } = buildProjectWriteServer(dispatchQueue(() => []));
    const newlyRegistered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    ).filter((n) => !baseNames.includes(n));

    for (const name of newlyRegistered) {
      expect(name.startsWith("bookkeeping."), name).toBe(false);
      expect(name.startsWith("projects."), name).toBe(true);
    }
  });

  test("each write tool carries the PM-safe metadata invariants", () => {
    const { server } = buildProjectWriteServer(dispatchQueue(() => []));
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          title: string;
          description: string;
          outputSchema?: unknown;
          inputSchema?: Record<string, unknown>;
          annotations: { readOnlyHint: boolean; openWorldHint: boolean };
        }
      >;
    })._registeredTools;

    for (const name of ["projects.create_activity", "projects.post_note", "projects.update_task"]) {
      const tool = tools[name];
      expect(tool, `missing ${name}`).toBeDefined();
      expect(tool.annotations.readOnlyHint, name).toBe(false);
      expect(tool.annotations.openWorldHint, name).toBe(false);
      expect(tool.title, name).toBeTruthy();
      expect(tool.outputSchema, name).toBeDefined();
      expect(tool.description.startsWith("Write:"), name).toBe(true);
      expect(tool.description, name).toContain("bookkeeping.plan_safe_write");
      // No caller-supplied model / free-form values: structural safety of these tools.
      const keys = Object.keys(tool.inputSchema ?? {});
      for (const forbidden of ["model", "values", "res_model", "method"]) {
        expect(keys, name).not.toContain(forbidden);
      }
    }
  });
});

describe("projects.create_activity", () => {
  test("creates one mail.activity with res_model/res_id set by the tool", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls, () => [77]));

    const result = await handler("projects.create_activity")({
      task_id: 42,
      summary: "CEO follow-up",
      note: "Ring Valentin",
      date_deadline: "2026-07-15",
      user_id: 7,
      activity_type_id: 4
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id: 77, web_url: "http://example.com/odoo/all-tasks/42" });
    expect(calls).toEqual([
      {
        model: "mail.activity",
        method: "create",
        args: {
          vals_list: [
            {
              res_model: "project.task",
              res_id: 42,
              activity_type_id: 4,
              user_id: 7,
              summary: "CEO follow-up",
              note: "Ring Valentin",
              date_deadline: "2026-07-15"
            }
          ]
        }
      }
    ]);
    // The caller never supplied res_model; the tool did.
    const vals = (calls[0].args.vals_list as Record<string, unknown>[])[0];
    expect(vals.res_model).toBe("project.task");
  });

  test("finance-keyword prose with date_deadline fills the full vals_list shape", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls, () => [77]));

    await handler("projects.create_activity")({
      task_id: 42,
      summary: FINANCE_KEYWORD_PM_TEXT.activitySummary,
      note: FINANCE_KEYWORD_PM_TEXT.activityNote,
      date_deadline: "2026-07-15",
      user_id: 7,
      activity_type_id: 4
    });

    expect(calls).toEqual([
      {
        model: "mail.activity",
        method: "create",
        args: {
          vals_list: [
            {
              res_model: "project.task",
              res_id: 42,
              activity_type_id: 4,
              user_id: 7,
              summary: FINANCE_KEYWORD_PM_TEXT.activitySummary,
              note: FINANCE_KEYWORD_PM_TEXT.activityNote,
              date_deadline: "2026-07-15"
            }
          ]
        }
      }
    ]);
  });

  test("omits note and date_deadline when the caller does not supply them", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls, () => [78]));

    await handler("projects.create_activity")({ task_id: 42, summary: "Ping", user_id: 7, activity_type_id: 4 });

    const vals = (calls[0].args.vals_list as Record<string, unknown>[])[0];
    expect(Object.keys(vals).sort()).toEqual(["activity_type_id", "res_id", "res_model", "summary", "user_id"]);
  });

  test("a create returning no usable id is an error, not a fake success", async () => {
    const { handler } = buildProjectWriteServer(dispatchQueue(() => []));

    const result = await handler("projects.create_activity")({
      task_id: 42,
      summary: "Ping",
      user_id: 7,
      activity_type_id: 4
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no activity id");
  });

  test("an Odoo failure returns a structured error envelope without the API key", async () => {
    const queue = dispatchQueue(() => {
      throw new OdooError({
        code: "permission_denied",
        message: "Access Denied",
        httpStatus: 403,
        model: "mail.activity",
        method: "create",
        details: "Access Denied"
      });
    });
    const { handler } = buildProjectWriteServer(queue);

    const result = await handler("projects.create_activity")({
      task_id: 42,
      summary: "Ping",
      user_id: 7,
      activity_type_id: 4
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.model).toBe("mail.activity");
    expect(body.method).toBe("create");
    expect(result.content.map((c) => c.text).join("\n")).not.toContain(props.odooApiKey);
  });
});

describe("projects.post_note", () => {
  test("posts plain text as escaped HTML on project.task chatter", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));

    const result = await handler("projects.post_note")({ task_id: 42, note: "Line 1\nR&D <ok>" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ result: 4242, web_url: "http://example.com/odoo/all-tasks/42" });
    expect(calls).toEqual([
      {
        model: "project.task",
        method: "message_post",
        args: {
          ids: [42],
          body: "Line 1<br>R&amp;D &lt;ok&gt;",
          body_is_html: true,
          message_type: "comment"
        }
      }
    ]);
  });

  test("body_is_html passes the body through unescaped, still declaring body_is_html on the wire", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));

    await handler("projects.post_note")({ task_id: 42, note: "<p>Already <b>HTML</b></p>", body_is_html: true });

    expect(calls[0].args.body).toBe("<p>Already <b>HTML</b></p>");
    expect(calls[0].args.body_is_html).toBe(true);
  });

  test("finance-keyword HTML note passes through with body_is_html", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));
    const html = `<p>${FINANCE_KEYWORD_PM_TEXT.chatterBody}</p>`;

    await handler("projects.post_note")({ task_id: 42, note: html, body_is_html: true });

    expect(calls).toEqual([
      {
        model: "project.task",
        method: "message_post",
        args: {
          ids: [42],
          body: html,
          body_is_html: true,
          message_type: "comment"
        }
      }
    ]);
  });

  test("an Odoo failure returns a structured error envelope naming the task", async () => {
    const queue = dispatchQueue(() => {
      throw new OdooError({
        code: "permission_denied",
        message: "Access Denied",
        httpStatus: 403,
        model: "project.task",
        method: "message_post",
        details: "Access Denied"
      });
    });
    const { handler } = buildProjectWriteServer(queue);

    const result = await handler("projects.post_note")({ task_id: 42, note: "hi" });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.model).toBe("project.task");
    expect(body.method).toBe("message_post");
    expect(body.record_ids).toEqual([42]);
  });
});

describe("projects.update_task", () => {
  test("writes only the curated fields the caller supplied", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));

    const result = await handler("projects.update_task")({
      task_id: 42,
      name: "Renamed",
      description: "New body",
      date_deadline: "2026-09-30",
      stage_id: 5,
      priority: "1"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, web_url: "http://example.com/odoo/all-tasks/42" });
    expect(calls).toEqual([
      {
        model: "project.task",
        method: "write",
        args: {
          ids: [42],
          vals: {
            name: "Renamed",
            description: "New body",
            date_deadline: "2026-09-30",
            stage_id: 5,
            priority: "1"
          }
        }
      }
    ]);
  });

  test("only supplied keys reach vals", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));

    await handler("projects.update_task")({ task_id: 42, stage_id: 5 });

    expect(calls[0].args.vals).toEqual({ stage_id: 5 });
  });

  test("an explicit null date_deadline is forwarded as null (clears the deadline)", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));

    await handler("projects.update_task")({ task_id: 42, date_deadline: null });

    expect(calls[0].args.vals).toEqual({ date_deadline: null });
  });

  test("an empty update is refused before any Odoo call", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls));

    const result = await handler("projects.update_task")({ task_id: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "projects.update_task requires at least one of name, description, date_deadline, stage_id, priority"
    );
    expect(calls).toEqual([]);
    expect(allWriteCalls).toEqual([]);
  });

  test("an Odoo failure returns a structured error envelope naming the task", async () => {
    const queue = dispatchQueue(() => {
      throw new OdooError({
        code: "permission_denied",
        message: "Access Denied",
        httpStatus: 403,
        model: "project.task",
        method: "write",
        details: "Access Denied"
      });
    });
    const { handler } = buildProjectWriteServer(queue);

    const result = await handler("projects.update_task")({ task_id: 42, name: "X" });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.model).toBe("project.task");
    expect(body.method).toBe("write");
    expect(body.record_ids).toEqual([42]);
  });
});

describe("projects.* write context is audit-only", () => {
  const CONTEXT = "USL Admin cleanup — banking/B2C follow-up";

  test("create_activity: context never reaches the Odoo wire", async () => {
    const without: WriteCall[] = [];
    const withCtx: WriteCall[] = [];
    const { handler: h1 } = buildProjectWriteServer(recordingQueue(without, () => [77]));
    const { handler: h2 } = buildProjectWriteServer(recordingQueue(withCtx, () => [77]));
    const args = { task_id: 42, summary: "Ping", user_id: 7, activity_type_id: 4 };

    await h1("projects.create_activity")(args);
    await h2("projects.create_activity")({ ...args, context: CONTEXT });

    expect(withCtx[0].args).toEqual(without[0].args);
    expect(JSON.stringify(withCtx[0].args)).not.toContain("context");
  });

  test("post_note: context never reaches the Odoo wire", async () => {
    const without: WriteCall[] = [];
    const withCtx: WriteCall[] = [];
    const { handler: h1 } = buildProjectWriteServer(recordingQueue(without));
    const { handler: h2 } = buildProjectWriteServer(recordingQueue(withCtx));
    const args = { task_id: 42, note: "hi" };

    await h1("projects.post_note")(args);
    await h2("projects.post_note")({ ...args, context: CONTEXT });

    expect(withCtx[0].args).toEqual(without[0].args);
    expect(JSON.stringify(withCtx[0].args)).not.toContain("context");
  });

  test("update_task: context never reaches the Odoo wire", async () => {
    const without: WriteCall[] = [];
    const withCtx: WriteCall[] = [];
    const { handler: h1 } = buildProjectWriteServer(recordingQueue(without));
    const { handler: h2 } = buildProjectWriteServer(recordingQueue(withCtx));
    const args = { task_id: 42, name: "Renamed" };

    await h1("projects.update_task")(args);
    await h2("projects.update_task")({ ...args, context: CONTEXT });

    expect(withCtx[0].args).toEqual(without[0].args);
    expect(JSON.stringify(withCtx[0].args)).not.toContain("context");
  });
});

describe("projects.* PM writes — finance-keyword prose is stored verbatim", () => {
  test("all three tools accept banking / B2C / VAT / payroll / deadline prose", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls, (call) => (call.method === "create" ? [77] : 1)));

    const activity = await handler("projects.create_activity")({
      task_id: 42,
      summary: FINANCE_KEYWORD_PM_TEXT.activitySummary,
      note: FINANCE_KEYWORD_PM_TEXT.activityNote,
      user_id: 7,
      activity_type_id: 4
    });
    const payrollActivity = await handler("projects.create_activity")({
      task_id: 42,
      summary: FINANCE_KEYWORD_PM_TEXT.activitySummary,
      note: FINANCE_KEYWORD_PM_TEXT.payrollNote,
      user_id: 7,
      activity_type_id: 4
    });
    const note = await handler("projects.post_note")({
      task_id: 42,
      note: FINANCE_KEYWORD_PM_TEXT.chatterBody
    });
    const update = await handler("projects.update_task")({
      task_id: 42,
      name: FINANCE_KEYWORD_PM_TEXT.taskName,
      description: FINANCE_KEYWORD_PM_TEXT.taskDescription
    });

    for (const result of [activity, payrollActivity, note, update]) {
      expect(result.isError).toBeUndefined();
    }

    // Prose survives byte-identical, modulo plaintextToHtml escaping (none of this text needs escaping).
    const activityVals = (calls[0].args.vals_list as Record<string, unknown>[])[0];
    expect(activityVals.summary).toBe(FINANCE_KEYWORD_PM_TEXT.activitySummary);
    expect(activityVals.note).toBe(FINANCE_KEYWORD_PM_TEXT.activityNote);
    const payrollVals = (calls[1].args.vals_list as Record<string, unknown>[])[0];
    expect(payrollVals.note).toBe(FINANCE_KEYWORD_PM_TEXT.payrollNote);
    expect(calls[2].args.body).toBe(FINANCE_KEYWORD_PM_TEXT.chatterBody);
    expect(calls[3].args.vals).toEqual({
      name: FINANCE_KEYWORD_PM_TEXT.taskName,
      description: FINANCE_KEYWORD_PM_TEXT.taskDescription
    });
  });

  test("the same prose in a note is escaped, not rewritten or stripped", async () => {
    const calls: WriteCall[] = [];
    const { handler } = buildProjectWriteServer(recordingQueue(calls, () => [77]));

    await handler("projects.create_activity")({
      task_id: 42,
      summary: "Month-end close",
      note: `${FINANCE_KEYWORD_PM_TEXT.activityNote}\nVAT & B2C <cutoff>`,
      user_id: 7,
      activity_type_id: 4
    });

    const vals = (calls[0].args.vals_list as Record<string, unknown>[])[0];
    expect(vals.note).toBe(`${FINANCE_KEYWORD_PM_TEXT.activityNote}<br>VAT &amp; B2C &lt;cutoff&gt;`);
  });
});
