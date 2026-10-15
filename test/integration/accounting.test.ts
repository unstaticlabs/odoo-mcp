import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;
const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
const companyId = Number(process.env.ODOO_ACCOUNTING_QA_COMPANY_ID);
const otherCompanyId = Number(process.env.ODOO_ACCOUNTING_QA_OTHER_COMPANY_ID);
const code = process.env.ODOO_ACCOUNTING_QA_ACCOUNT_CODE;
const expectedCount = Number(process.env.ODOO_ACCOUNTING_QA_EXPECTED_COUNT);
const dateTo = process.env.ODOO_ACCOUNTING_QA_DATE_TO;
const configured = Boolean(origin && database && apiKey && companyId && otherCompanyId && code && dateTo
  && Number.isInteger(expectedCount) && expectedCount > 1);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

async function connected() {
  if (!origin || !database || !apiKey) throw new Error("Accounting fixture configuration is incomplete");
  const context: RequestContext = {
    requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "accounting",
    principal: { targetId: "accounting-qa", publicOrigin: origin,
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
  const client = new Client({ name: "accounting-qa", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); await cache.close(); });
  return client;
}

// Disposable fixtures: >1 posted open lines before dateTo in companyId; also
// a later line, a draft, a reconciled pair and same-code lines in an inaccessible
// otherCompanyId. All calls below are read-only; fixture creation is external.
describe.skipIf(!configured)("live accounting population", () => {
  it("distinguishes a limited sample from the independently known visible population", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "accounting_review_key_accounts", arguments: {
      company_id: companyId, account_codes: [code, code], date_to: dateTo, open_item_limit: 1, context: {}
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: {
      open_item_count: expectedCount, open_items_returned: 1, open_items_truncated: true,
      read_consistency: "separate_reads", missing_codes: []
    } });
    const data = (result.structuredContent as { data: { open_item_domain: unknown[] } }).data;
    const direct = await client.callTool({ name: "odoo_search_records", arguments: {
      model: "account.move.line", domain: data.open_item_domain, fields: ["date", "company_id", "reconciled"],
      limit: 100, context: { allowed_company_ids: [companyId], company_id: companyId }
    } });
    expect(direct.isError).not.toBe(true);
    const records = (direct.structuredContent as { data: { records: Array<{ company_id: [number, string]; reconciled: boolean; date: string }> } }).data.records;
    expect(records).toHaveLength(expectedCount);
    expect(records.every((row) => row.company_id[0] === companyId && !row.reconciled && row.date <= dateTo!)).toBe(true);
  }, 60_000);

  it("reports zero for a missing account rather than querying every account", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "accounting_review_key_accounts", arguments: {
      company_id: companyId, account_codes: ["QA-MISSING-990031"], date_to: dateTo, context: {}
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: {
      open_item_count: 0, open_items: [], open_items_returned: 0, open_items_truncated: false,
      missing_codes: ["QA-MISSING-990031"]
    } });
  }, 60_000);

  it("does not expose another company's same-code population", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "accounting_review_key_accounts", arguments: {
      company_id: otherCompanyId, account_codes: [code], date_to: dateTo, context: {}
    } });
    expect(result.isError).toBe(true);
  }, 60_000);
});
