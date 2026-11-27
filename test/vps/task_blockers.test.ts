import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

async function taskContext(task: Record<string, unknown>, dependencies: unknown[], waiting?: Record<string, unknown>) {
  task = { depend_on_count: Array.isArray(task.depend_on_ids) ? task.depend_on_ids.length : 0, closed_depend_on_count: 0, ...task };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/project.task/fields_get")) {
      expect(body.allfields).toEqual(["usl_waiting_details"]);
      return Response.json(waiting ? { usl_waiting_details: { type: "json" } } : {});
    }
    if (url.endsWith("/project.task/read") && body.fields?.includes("usl_waiting_details")) {
      expect(body.ids).toEqual([42]);
      expect(body.context.allowed_company_ids).toEqual([3]);
      return Response.json([{ id: 42, display_name: "[QA] Launch", ...task, state: waiting?.state ?? task.state, usl_waiting_details: { id: 42, state: task.state,
        has_open_causes: true, legacy_unexplained: false, can_change: true,
        native_dependencies: { enabled: false, total_count: 0, visible_count: 0, complete: true }, ...waiting } }]);
    }
    if (url.endsWith("/project.task/read")) return Response.json([{ id: 42, display_name: "[QA] Launch", ...task }]);
    if (url.endsWith("/project.task/search_read")) {
      expect(body.context.allowed_company_ids).toEqual([3]);
      expect(body.context.active_test).toBe(false);
      return Response.json(dependencies);
    }
    return Response.json([]);
  });
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({
    ...requestContext(), profile: "projects", availableModules: new Set(["base", "api_doc", "mail", "project", "usl_project"]),
  });
  const client = new Client({ name: "task-blocker-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const result = await client.callTool({ name: "projects_get_task_context", arguments: { task_id: 42, context: { allowed_company_ids: [3] } } });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as { data: { context: { task: Record<string, unknown>; dependencies: Record<string, unknown>; waiting?: Record<string, unknown> } } };
  } finally {
    await client.close(); await server.close();
  }
}

describe("task blocker explanations", () => {
  it("explains Waiting from readable open dependencies and excludes closed ones", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [7, 8] }, [
      { id: 7, display_name: "[QA] Approval", state: "01_in_progress" },
      { id: 8, display_name: "[QA] Done", state: "1_done" },
    ]);
    expect(result.data.context.dependencies).toMatchObject({ enabled: true, complete: true, waiting_reason: "open_dependencies", open_blockers: [{ id: 7, _ref: { model: "project.task", id: 7 } }] });
    expect(JSON.stringify(result.data.context.dependencies)).toContain("/odoo/project.task/7");
  });

  it("does not invent blockers for native manual Waiting", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [] }, []);
    expect(result.data.context.dependencies).toMatchObject({ enabled: true, complete: true, waiting_reason: "manual_or_stale", open_blockers: [] });
  });

  it("states uncertainty when dependency details are inaccessible", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [7, 8] }, [
      { id: 7, display_name: "[QA] Done", state: "1_done" },
    ]);
    expect(result.data.context.dependencies).toMatchObject({ complete: false, waiting_reason: "unavailable_dependencies", open_blockers: [] });
  });

  it("distinguishes disabled dependencies from manual Waiting", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: false, depend_on_ids: [7] }, [
      { id: 7, display_name: "[QA] Open", state: "01_in_progress" },
    ]);
    expect(result.data.context.dependencies).toMatchObject({ enabled: false, waiting_reason: "dependencies_disabled", open_blockers: [] });
  });

  it("does not claim an open blocker makes an already completed task Waiting", async () => {
    const result = await taskContext({ state: "1_done", allow_task_dependencies: true, depend_on_ids: [7] }, [
      { id: 7, display_name: "[QA] Open", state: "01_in_progress" },
    ]);
    expect(result.data.context.dependencies).toMatchObject({ waiting_reason: "not_waiting", open_blockers: [{ id: 7 }] });
  });

  it("retains readable open blockers while disclosing incomplete details", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [7, 8] }, [
      { id: 7, display_name: "[QA] Readable blocker", state: "02_changes_requested" },
    ]);
    expect(result.data.context.dependencies).toMatchObject({ complete: false, waiting_reason: "open_dependencies", open_blockers: [{ id: 7 }] });
    expect(JSON.stringify(result)).not.toContain('"id":8');
    expect(JSON.stringify(result)).not.toContain('"depend_on_ids"');
  });

  it("marks a capped dependency listing incomplete", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: ids },
      ids.slice(0, 100).map((id) => ({ id, display_name: `[QA] Task ${id}`, state: "1_canceled" })));
    expect(result.data.context.dependencies).toMatchObject({ complete: false, waiting_reason: "unavailable_dependencies", open_blockers: [] });
  });

  it("uses the native aggregate when the relational read already hides a blocker", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true,
      depend_on_ids: [], depend_on_count: 1, closed_depend_on_count: 0 }, []);
    expect(result.data.context.dependencies).toMatchObject({ complete: false, total_count: 1,
      waiting_reason: "unavailable_dependencies", open_blockers: [] });
    expect(JSON.stringify(result)).not.toContain('"depend_on_ids"');
  });

  it("does not claim completeness when the native count is unavailable", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true,
      depend_on_ids: [], depend_on_count: undefined }, []);
    expect(result.data.context.dependencies).toMatchObject({ complete: false, total_count: null,
      waiting_reason: "unavailable_dependencies" });
  });
});


describe("explained waiting server compatibility", () => {
  it("recognizes an external cause even without native project dependencies", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: false, depend_on_ids: [] }, [], {
      causes: [{ id: 31, kind: "external", reason: "Awaiting a synthetic external reply", lifted: false, is_blocking: true }],
    });
    expect(result.data.context.dependencies.waiting_reason).toBe("explained_causes");
    expect(result.data.context.waiting).toMatchObject({ has_open_causes: true,
      causes: [{ kind: "external", reason: "Awaiting a synthetic external reply" }] });
  });
  it("preserves unavailable causes without inventing a record identity", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [] }, [], {
      causes: [{ id: 31, kind: "unavailable", lifted: false, is_blocking: null, message: "The linked record is no longer accessible." }],
    });
    expect(result.data.context.dependencies.waiting_reason).toBe("explained_causes");
    expect(JSON.stringify(result.data.context.waiting)).not.toContain('"reference"');
  });
  it("identifies older unexplained Waiting precisely on the new server", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [] }, [], {
      has_open_causes: false, legacy_unexplained: true, causes: [],
    });
    expect(result.data.context.dependencies.waiting_reason).toBe("legacy_unexplained");
  });
});


it("uses the current native Waiting snapshot instead of earlier task and blocker reads", async () => {
  const result = await taskContext({ state: "01_in_progress", allow_task_dependencies: true,
    depend_on_ids: [7], depend_on_count: 1 }, [{ id: 7, display_name: "[QA] Previously readable blocker", state: "01_in_progress" }], {
    state: "04_waiting_normal", causes: [{ id: 31, kind: "unavailable", lifted: false, is_blocking: null,
      message: "The linked record is no longer accessible." }],
    native_dependencies: { enabled: true, total_count: 1, visible_count: 0, complete: false },
  });
  expect(result.data.context.task.state).toBe("04_waiting_normal");
  expect(result.data.context.dependencies).toMatchObject({ waiting_reason: "explained_causes", complete: false, open_blockers: [] });
  expect(JSON.stringify(result)).not.toContain("Previously readable blocker");
});
