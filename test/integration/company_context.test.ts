import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixturePath = process.env.ODOO_COMPANY_CONTEXT_FIXTURE;
const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;

describe.skipIf(!fixturePath).sequential("native optional company context through MCP SDK", () => {
  const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : {};
  function scopedContext(key: string): RequestContext {
    if (!["odoo_fb_bill_company_context", "odoo_fb_bill_company_context_combined"].includes(database ?? "") || !origin || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      throw new Error("Company context qualification requires its isolated localhost fixture");
    }
    return { requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "accounting",
      principal: { targetId: "company-context-qa", publicOrigin: origin, internalOrigin: origin,
        database, apiKey: key, authMode: "direct" } };
  }
  const companyScope = () => ({ allowed_company_ids: [fixture.company_id, fixture.target_company_id, fixture.branch_company_id] });
  async function native(method: string, args: Record<string, unknown>) {
    const response = await fetch(`${origin}/json/2/account.move/${method}`, { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${fixture.human_key}`, "X-Odoo-Database": database! },
      body: JSON.stringify({ ...args, context: companyScope() }) });
    expect(response.ok).toBe(true);
    return response.json();
  }
  it("human reads the same native snapshot under ordinary native authority", async () => {
    const snapshot = await native("get_company_change_context", { ids: [fixture.bill_id], target_company_id: fixture.target_company_id, limit: 100 });
    expect(snapshot.lines.visible_count).toBeGreaterThan(100);
    expect(snapshot.lines.records).toHaveLength(100);
    expect(snapshot.invoice.fields.company_id.id).toBe(fixture.company_id);
    expect(snapshot.target_company.id).toBe(fixture.target_company_id);
  });
  for (const actor of ["read_write", "read_only"]) {
    it(`${actor} reads native bounded facts in one snapshot without changing ledger or evidence`, async () => {
      const before = await native("read", { ids: [fixture.bill_id], fields: ["write_date", "company_id", "amount_total", "amount_residual", "line_ids", "message_ids", "message_main_attachment_id"] });
      const context = scopedContext(fixture[`${actor}_key`]);
      const odoo = new OdooClient();
      const cache = new AgentAccessSnapshotCache(odoo);
      if (actor !== "human") {
        const identity = await cache.initialize(context);
        context.agentIdentity = identity.identity;
        context.availableModules = identity.surface?.modules ?? null;
        context.availablePublicMethods = identity.surface?.publicMethods ?? null;
        context.availableModelAccess = identity.surface?.modelAccess ?? null;
        context.touchAgentAccess = () => cache.touch(context);
        context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
      }
      const server = createCapabilityRegistry(odoo).createServer(context);
      const client = new Client({ name: "company-context-qa", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(st); await client.connect(ct);
        const result = await client.callTool({ name: "accounting_get_invoice_context", arguments: {
          move_id: fixture.bill_id, company_change: { target_company_id: fixture.target_company_id, limit: 100 }, context: companyScope() } });
        expect(result.isError).not.toBe(true);
        const content = result.structuredContent as Record<string, any>;
        const snapshot = content.data.context.company_change;
        expect(snapshot.snapshot).toMatchObject({ boundary: "single_native_rpc", isolation: "repeatable_read", pages_are_independent_snapshots: true });
        expect(snapshot.lines.visible_count).toBeGreaterThan(100);
        expect(snapshot.lines.records).toHaveLength(100);
        expect(snapshot.lines.status).toBe("truncated");
        expect(snapshot.reconciliations.visible_count).toBe(0);
        expect(snapshot.invoice.fields.company_id.id).toBe(fixture.company_id);
        expect(snapshot.target_company.id).toBe(fixture.target_company_id);
        expect(snapshot.choices["account.account"].records.some((row: any) => row.id === fixture.shared_account_id)).toBe(true);
        expect(content.data.context.invoice_ref).toMatchObject({ model: "account.move", id: fixture.bill_id });
        const forged = await client.callTool({ name: "accounting_get_invoice_context", arguments: {
          move_id: fixture.bill_id, company_change: { target_company_id: fixture.foreign_company_id }, context: companyScope() } });
        expect(forged.isError).toBe(true);
      } finally { await client.close(); await server.close(); await cache.close(); }
      const after = await native("read", { ids: [fixture.bill_id], fields: ["write_date", "company_id", "amount_total", "amount_residual", "line_ids", "message_ids", "message_main_attachment_id"] });
      expect(after).toEqual(before);
    }, 120_000);
  }
});
