import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const path = process.env.ODOO_WAITING_CAUSES_FIXTURE;

describe.skipIf(!path)("explained Waiting through real Agent JSON-2 and MCP SDK", () => {
  it("uses the native action once, explains it, denies readonly lifting and resumes after the last cause", async () => {
    const fixture = JSON.parse(readFileSync(path!, "utf8"));
    if (fixture.database !== "qa_task_waiting_3748" || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(fixture.url)) {
      throw new Error("Explained Waiting integration requires the disposable localhost fixture");
    }
    async function connect(mode: "read_write" | "read_only") {
      const odoo = new OdooClient();
      const cache = new AgentAccessSnapshotCache(odoo);
      const context: RequestContext = {
        requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "default",
        principal: { targetId: "waiting-causes-qa", publicOrigin: fixture.url, internalOrigin: fixture.url,
          database: fixture.database, apiKey: fixture[mode].api_key, authMode: "direct" },
      };
      const snapshot = await cache.initialize(context);
      context.agentIdentity = snapshot.identity;
      context.availableModules = snapshot.surface?.modules ?? null;
      context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
      context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
      context.touchAgentAccess = () => cache.touch(context);
      context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
      const server = createCapabilityRegistry(odoo).createServer(context);
      const client = new Client({ name: "waiting-causes-native-integration", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st); await client.connect(ct);
      return { client, close: async () => { await client.close(); await server.close(); await cache.close(); } };
    }
    const rw = await connect("read_write");
    const ro = await connect("read_only");
    const args = { context: { allowed_company_ids: [fixture.company_id] } };
    const context = async () => {
      const result = await rw.client.callTool({ name: "projects_get_task_context", arguments: { ...args, task_id: fixture.task_id } });
      expect(result.isError).not.toBe(true);
      return (result.structuredContent as Record<string, any>).data.context;
    };
    try {
      expect((await context()).task.state).toBe("01_in_progress");
      const deniedUnexplained = await rw.client.callTool({ name: "odoo_call_method", arguments: { ...args,
        model: "project.task", method: "write", ids: [fixture.task_id], kwargs: { vals: { state: "04_waiting_normal" } } } });
      expect(deniedUnexplained.isError).toBe(true);
      expect((await context()).task.state).toBe("01_in_progress");
      const saved = await rw.client.callTool({ name: "odoo_call_method", arguments: { ...args,
        model: "project.task", method: "action_set_waiting", ids: [fixture.task_id],
        kwargs: { reason: "Synthetic MCP external response" } } });
      expect(saved.isError).not.toBe(true);
      const waiting = await context();
      expect(waiting.task.state).toBe("04_waiting_normal");
      expect(waiting.dependencies.waiting_reason).toBe("explained_causes");
      expect(waiting.waiting.causes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "external", reason: "Synthetic MCP external response" })]));
      const cause = waiting.waiting.causes.find((item: Record<string, unknown>) => item.kind === "external" && !item.lifted);
      const denied = await ro.client.callTool({ name: "odoo_call_method", arguments: { ...args,
        model: "project.task", method: "action_lift_waiting_cause", ids: [fixture.task_id], kwargs: { cause_id: cause.id } } });
      expect(denied.isError).toBe(true);
      expect((await context()).waiting.has_open_causes).toBe(true);
      const lifted = await rw.client.callTool({ name: "odoo_call_method", arguments: { ...args,
        model: "project.task", method: "action_lift_waiting_cause", ids: [fixture.task_id], kwargs: { cause_id: cause.id } } });
      expect(lifted.isError).not.toBe(true);
      const resumed = await context();
      expect(resumed.task.state).toBe("01_in_progress");
      expect(resumed.waiting.has_open_causes).toBe(false);
    } finally { await rw.close(); await ro.close(); }
  }, 120_000);
});
