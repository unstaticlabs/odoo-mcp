import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixturePath = process.env.ODOO_TASK_WAITING_FIXTURE;
const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;

describe.skipIf(!fixturePath).sequential("synthetic task Waiting through the live MCP protocol", () => {
  let client: Client;
  let server: ReturnType<ReturnType<typeof createCapabilityRegistry>["createServer"]>;
  let cache: AgentAccessSnapshotCache;
  let fixture: Record<string, number | string>;

  beforeAll(async () => {
    // The suite creates and changes disposable tasks, so it has no production
    // mode even if unrelated integration variables are configured globally.
    if (database !== "odoo_fb_task_waiting" || !origin || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      throw new Error("Task Waiting integration requires its isolated localhost fixture");
    }
    fixture = JSON.parse(readFileSync(fixturePath!, "utf8"));
    const context: RequestContext = {
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "default",
      principal: { targetId: "task-waiting-qa", publicOrigin: origin, internalOrigin: origin,
        database, apiKey: String(fixture.api_key), authMode: "direct" },
    };
    const odoo = new OdooClient();
    cache = new AgentAccessSnapshotCache(odoo);
    const snapshot = await cache.initialize(context);
    context.agentIdentity = snapshot.identity;
    context.availableModules = snapshot.surface?.modules ?? null;
    context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
    context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context);
    context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
    server = createCapabilityRegistry(odoo).createServer(context);
    client = new Client({ name: "task-waiting-integration", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
  }, 120_000);

  afterAll(async () => { await client?.close(); await server?.close(); await cache?.close(); });

  async function call(name: string, arguments_: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { ...arguments_, context: { allowed_company_ids: [fixture.company_id], lang: "fr_FR" } } });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as Record<string, any>;
  }

  async function nativeHumanCreate() {
    const response = await fetch(`${origin}/json/2/project.task/web_save`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${fixture.human_api_key}`,
        "X-Odoo-Database": database! },
      body: JSON.stringify({ vals: { name: "[QA] Native human creation", project_id: fixture.project_id, state: "04_waiting_normal" },
        specification: { state: {} }, context: { allowed_company_ids: [fixture.company_id], lang: "fr_FR" } }),
    });
    expect(response.ok).toBe(true);
    return await response.json() as Array<{ state: string }>;
  }

  it("explains a real readable open blocker", async () => {
    const result = await call("projects_get_task_context", { task_id: fixture.blocked_id });
    expect(result.data.context.dependencies).toMatchObject({ enabled: true, complete: true,
      waiting_reason: "open_dependencies", open_blockers: [{ id: fixture.blocker_id }] });
  }, 60_000);

  it("does not mistake the native filtered hidden relation for an empty dependency list", async () => {
    const generic = await call("odoo_read_records", { model: "project.task", ids: [fixture.hidden_wait_id],
      fields: ["state", "depend_on_ids", "depend_on_count"] });
    expect(generic.data.records[0]).toMatchObject({ depend_on_ids: [], depend_on_count: 1 });
    const result = await call("projects_get_task_context", { task_id: fixture.hidden_wait_id });
    expect(result.data.context.dependencies).toMatchObject({ complete: false, total_count: 1,
      waiting_reason: "unavailable_dependencies", open_blockers: [] });
    expect(JSON.stringify(result)).not.toContain('"id":' + fixture.hidden_id + ',');
    expect(JSON.stringify(result)).not.toContain("Restricted blocker");
    expect(JSON.stringify(result)).not.toContain('"depend_on_ids"');
  }, 60_000);

  it("preserves and honestly explains a human manual Waiting task", async () => {
    const result = await call("projects_get_task_context", { task_id: fixture.manual_id });
    expect(result.data.context.task.state).toBe("04_waiting_normal");
    expect(result.data.context.dependencies).toMatchObject({ complete: true,
      waiting_reason: "manual_or_stale", open_blockers: [] });
  }, 60_000);

  it("preserves native manual Waiting through generic same-transaction read-back", async () => {
    const result = await call("odoo_update_records", { model: "project.task", ids: [fixture.ordinary_id],
      values: { state: "04_waiting_normal" }, specification: { state: {} } });
    expect(result.data.read_back[0].state).toBe("04_waiting_normal");
  }, 60_000);

  it("keeps a real blocker when asked to resume, then returns to In Progress after removal", async () => {
    const blocked = await call("odoo_update_records", { model: "project.task", ids: [fixture.blocked_id],
      values: { state: "01_in_progress" }, specification: { state: {} } });
    expect(blocked.data.read_back[0].state).toBe("04_waiting_normal");
    const released = await call("odoo_update_records", { model: "project.task", ids: [fixture.blocked_id],
      values: { depend_on_ids: { clear: true } }, specification: { state: {} } });
    expect(released.data.read_back[0].state).toBe("01_in_progress");
    await call("odoo_update_records", { model: "project.task", ids: [fixture.blocked_id],
      values: { depend_on_ids: { link: [fixture.blocker_id] } } });
  }, 60_000);

  it("matches the native human creation outcome through generic same-transaction read-back", async () => {
    const native = await nativeHumanCreate();
    const result = await call("odoo_create_records", { model: "project.task", values: [{
      name: "[QA] MCP generic creation", project_id: fixture.project_id, state: "04_waiting_normal",
    }], specification: { state: {} } });
    expect(result.data.read_back[0].state).toBe(native[0]!.state);
  }, 60_000);

  it("preserves native manual Waiting writes and matches native human batch creation", async () => {
    const native = await nativeHumanCreate();
    await call("odoo_update_records", { model: "project.task", ids: [fixture.ordinary_id],
      values: { state: "04_waiting_normal", name: "[QA] Schedule kickoff" } });
    const created = await call("odoo_create_records", { model: "project.task", values: [1, 2].map((number) => ({
      name: `[QA] MCP batch creation ${number}`, project_id: fixture.project_id, state: "04_waiting_normal",
    })) });
    const result = await call("odoo_read_records", { model: "project.task",
      ids: [fixture.ordinary_id, ...created.data.ids], fields: ["state"] });
    expect(result.data.records).toHaveLength(3);
    expect(result.data.records.find((record: Record<string, unknown>) => record.id === fixture.ordinary_id).state).toBe("04_waiting_normal");
    expect(result.data.records.filter((record: Record<string, unknown>) => record.id !== fixture.ordinary_id)
      .every((record: Record<string, unknown>) => record.state === native[0]!.state)).toBe(true);
  }, 60_000);

  it("covers the public-method write escape hatch", async () => {
    await call("odoo_call_method", { model: "project.task", method: "write", ids: [fixture.ordinary_id],
      kwargs: { vals: { state: "04_waiting_normal" } } });
    const result = await call("odoo_read_records", { model: "project.task", ids: [fixture.ordinary_id], fields: ["state"] });
    expect(result.data.records[0].state).toBe("04_waiting_normal");
  }, 60_000);

  it("creates real dependencies through the existing semantic shortcut", async () => {
    const result = await call("projects_create_task", { name: "[QA] MCP semantic creation", project_id: fixture.project_id,
      dependency_ids: [fixture.blocker_id] });
    const taskId = result.data.record?.id ?? result.data.id;
    expect(taskId).toBeTypeOf("number");
    const context = await call("projects_get_task_context", { task_id: taskId });
    expect(context.data.context.task.state).toBe("04_waiting_normal");
  }, 60_000);
});
