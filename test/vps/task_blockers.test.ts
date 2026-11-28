import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

let fetcherUrls: string[] = [];

async function taskContext(task: Record<string, unknown>, dependencies: unknown[],
  availableWaiting: string[] = ["usl_waiting_reason", "usl_waiting_partner_id"],
  readError?: { message: string; status: number }) {
  fetcherUrls = [];
  task = { depend_on_count: Array.isArray(task.depend_on_ids) ? task.depend_on_ids.length : 0, closed_depend_on_count: 0, ...task };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    fetcherUrls.push(url.split("/").pop() ?? "");
    if (url.endsWith("/project.task/fields_get")) {
      expect(body.context.allowed_company_ids).toEqual([3]);
      expect(body.allfields).toEqual(["usl_waiting_reason", "usl_waiting_partner_id"]);
      return Response.json(Object.fromEntries(availableWaiting.map(field => [field, { type: field === "usl_waiting_reason" ? "char" : "many2one" }])));
    }
    if (url.endsWith("/project.task/read")) {
      expect(body.ids).toEqual([42]);
      expect(body.context.allowed_company_ids).toEqual([3]);
      if (readError) return Response.json({ message: readError.message }, { status: readError.status });
      const unsupported = body.fields.find((field: string) => field.startsWith("usl_waiting_") && !availableWaiting.includes(field));
      if (unsupported) return Response.json({ message: `Invalid field '${unsupported}' on 'project.task'` }, { status: 500 });
      const selected = Object.fromEntries(Object.entries(task).filter(([field]) => body.fields.includes(field)));
      return Response.json([{ id: 42, display_name: "[QA] Launch", ...selected }]);
    }
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
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as { data: { context: { task: Record<string, unknown>; dependencies: Record<string, unknown> } } };
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

  it("reports an external reason and its contact, with one task read and no field probe", async () => {
    const result = await taskContext({
      state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [],
      usl_waiting_reason: "[QA] Supplier quote", usl_waiting_partner_id: [9, "[QA] Synthetic supplier"],
    }, []);
    expect(result.data.context.dependencies).toMatchObject({ waiting_reason: "external_reason", open_blockers: [] });
    expect(result.data.context.task).toMatchObject({ usl_waiting_reason: "[QA] Supplier quote" });
    expect(fetcherUrls).not.toContain("fields_get");
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

  it("reads a task and explains its open dependency on a server without external waiting fields", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true, depend_on_ids: [7] },
      [{ id: 7, display_name: "[QA] Rehearsal", state: "01_in_progress" }], []);
    expect(result.data.context.task).toMatchObject({ id: 42, display_name: "[QA] Launch" });
    expect(result.data.context.task).not.toHaveProperty("usl_waiting_reason");
    expect(result.data.context.dependencies).toMatchObject({ complete: true, waiting_reason: "open_dependencies",
      open_blockers: [{ id: 7 }] });
  });

  it("keeps the external reason when the server exposes it without the optional contact", async () => {
    const result = await taskContext({ state: "04_waiting_normal", usl_waiting_reason: "[QA] Sound check", depend_on_ids: [] },
      [], ["usl_waiting_reason"]);
    expect(result.data.context.task.usl_waiting_reason).toBe("[QA] Sound check");
    expect(result.data.context.task).not.toHaveProperty("usl_waiting_partner_id");
    expect(result.data.context.dependencies.waiting_reason).toBe("external_reason");
  });

  it.each([
    ["denied reads", 403, "Access to this task is denied"],
    ["field visibility denials", 403, "Invalid field 'usl_waiting_reason' on 'project.task'"],
    ["missing core fields", 500, "Invalid field 'state' on 'project.task'"],
    ["errors from another model", 500, "Invalid field 'usl_waiting_reason' on 'res.partner'"],
  ])("preserves %s", async (_case, status, message) => {
    await expect(taskContext({}, [], [], { status: Number(status), message: String(message) })).rejects.toThrow(String(message));
    expect(fetcherUrls).not.toContain("fields_get");
  });

  it("returns the original read error when Odoo still declares the rejected field", async () => {
    const message = "Invalid field 'usl_waiting_reason' on 'project.task'";
    await expect(taskContext({}, [], ["usl_waiting_reason"], { status: 500, message })).rejects.toThrow(message);
    expect(fetcherUrls.filter(method => method === "read")).toHaveLength(1);
    expect(fetcherUrls.filter(method => method === "fields_get")).toHaveLength(1);
  });

  it("does not claim completeness when the native count is unavailable", async () => {
    const result = await taskContext({ state: "04_waiting_normal", allow_task_dependencies: true,
      depend_on_ids: [], depend_on_count: undefined }, []);
    expect(result.data.context.dependencies).toMatchObject({ complete: false, total_count: null,
      waiting_reason: "unavailable_dependencies" });
  });
});
