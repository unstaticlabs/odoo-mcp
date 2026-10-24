import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixturePath = process.env.ODOO_INTEGRATION_PURCHASE_ATTACHMENTS_FIXTURE;
describe.skipIf(!fixturePath)("disposable native purchase attachment context through MCP SDK", () => {
  it("discovers affected bills automatically without adding context to ordinary/customer invoices or changing records", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
      disposable: boolean; database: string; origin: string; key: string;
      company_ids: number[]; cases: { grouped: number; ordinary: number; customer: number };
    };
    expect(fixture.disposable).toBe(true);
    expect(fixture.database).toMatch(/^odoo_fb_/);
    expect(new URL(fixture.origin).hostname).toMatch(/^(localhost|127\.0\.0\.1|[a-z-]+\.localhost)$/);
    const context: RequestContext = {
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "accounting",
      principal: { targetId: "disposable-purchase-context", publicOrigin: fixture.origin,
        internalOrigin: fixture.origin, database: fixture.database, apiKey: fixture.key, authMode: "direct" }
    };
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      paths.push(new URL(String(input)).pathname);
      return fetch(input, init);
    };
    const odoo = new OdooClient(8, 1024 * 1024, fetcher);
    const cache = new AgentAccessSnapshotCache(odoo);
    const access = await cache.initialize(context, undefined, { requireSurface: true, timeoutMs: 90_000 });
    context.agentIdentity = access.identity;
    context.availableModules = access.surface?.modules ?? null;
    context.availablePublicMethods = access.surface?.publicMethods ?? null;
    context.availableModelAccess = access.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context);
    context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
    expect(context.availablePublicMethods?.get("account.move")?.has("get_purchase_attachment_context")).toBe(true);
    const server = createCapabilityRegistry(odoo).createServer(context);
    const client = new Client({ name: "disposable-purchase-context", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      async function call(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: { ...args, context: { allowed_company_ids: fixture.company_ids } } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return (result.structuredContent as { data: Record<string, any> }).data;
      }
      const ids = Object.values(fixture.cases);
      async function state() {
        return (await call("odoo_read_records", { model: "account.move", ids,
          fields: ["write_date", "state", "company_id", "line_ids", "message_ids", "message_main_attachment_id"] })).records;
      }
      const before = await state();
      paths.length = 0;
      for (const [kind, id] of Object.entries(fixture.cases)) {
        const data = await call("accounting_get_invoice_context", { move_id: id });
        expect(data.context.invoice.id).toBe(id);
        if (kind === "grouped") {
          const snapshot = data.context.purchase_attachments;
          expect(snapshot).toMatchObject({ version: 1, bill_id: id, offset: 0, limit: 50 });
          expect(snapshot.documents.length).toBeGreaterThan(0);
          expect(snapshot.documents.length).toBeLessThanOrEqual(50);
          expect(snapshot.actions.review).toMatchObject({ model: "account.move", method: "action_review_mail_grouping" });
          expect(snapshot.review_lines.choices).toEqual(["supporting", "main", "separate"]);
        } else expect(data.context).not.toHaveProperty("purchase_attachments");
      }
      expect(paths.filter((path) => path.endsWith("/get_purchase_attachment_context"))).toHaveLength(2);
      expect(paths.some((path) => /\/(write|create|action_\w+)$|\/web\/content/.test(path))).toBe(false);
      expect(await state()).toEqual(before);
    } finally { await client.close(); await server.close(); await cache.close(); }
  }, 120_000);
});
