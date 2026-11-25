import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;
const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
const companyId = Number(process.env.ODOO_OVERVIEW_QA_COMPANY_ID);
const otherCompanyId = Number(process.env.ODOO_OVERVIEW_QA_OTHER_COMPANY_ID);
const expected = JSON.parse(process.env.ODOO_OVERVIEW_QA_EXPECTED ?? "{}");
const annualId = Number(process.env.ODOO_OVERVIEW_QA_ANNUAL_ID);
const operationalId = Number(process.env.ODOO_OVERVIEW_QA_OPERATIONAL_ID);
const configured = Boolean(origin && database && apiKey && companyId && otherCompanyId && annualId && operationalId
  && Object.keys(expected).length > 0);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function connected() {
  if (!origin || !database || !apiKey) throw new Error("Overview fixture configuration is incomplete");
  const context: RequestContext = {
    requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "accounting",
    principal: { targetId: "overview-qa", publicOrigin: origin,
      internalOrigin: process.env.ODOO_INTEGRATION_INTERNAL_ORIGIN ?? origin, database, apiKey, authMode: "direct" }
  };
  const odoo = new OdooClient();
  const cache = new AgentAccessSnapshotCache(odoo);
  const snapshot = await cache.initialize(context);
  context.agentIdentity = snapshot.identity;
  context.availableModules = snapshot.surface?.modules ?? null;
  context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
  context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
  const server = createCapabilityRegistry(odoo).createServer(context);
  const client = new Client({ name: "overview-qa", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); await cache.close(); });
  return client;
}

// Read-only calls against externally seeded, wholly synthetic fixture records.
describe.skipIf(!configured)("live Accounting overview scope", () => {
  it("returns both native closing relations and distinct expense state counts", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "accounting_get_overview", arguments: {
      company_id: companyId, context: { allowed_company_ids: [companyId, otherCompanyId], company_id: otherCompanyId }
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { overview: { ...expected,
      open_annual_closing_id: [annualId, expect.any(String)],
      latest_closing_period_id: [operationalId, expect.any(String)],
      _scope: { expense_state_breakdown_available: true, annual_close_fields_available: true,
        expense_counts_grant_edit_permission: false }
    } } });
  }, 60_000);

  it("does not expose the other company's overview through crafted context", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "accounting_get_overview", arguments: {
      company_id: otherCompanyId, context: { allowed_company_ids: [companyId, otherCompanyId] }
    } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent ?? {}).not.toHaveProperty("data.overview");
  }, 60_000);
});
