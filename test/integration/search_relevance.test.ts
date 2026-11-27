import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;
const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
const company = Number(process.env.ODOO_SEARCH_QA_COMPANY_ID);
const specificationAllowed = process.env.ODOO_SEARCH_QA_SPECIFICATION_ALLOWED === "1";
const fixtures = JSON.parse(process.env.ODOO_SEARCH_QA_FIXTURES ?? "{}") as Record<string, { query: string; ids: number[] }>;
const models = ["project.task", "project.project", "res.partner"];
const configured = Boolean(origin && database && apiKey && company && models.every(model => fixtures[model]?.ids.length === 4));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function connected() {
  if (!origin || !database || !apiKey) throw new Error("Search fixture configuration is incomplete");
  const context: RequestContext = { requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "default",
    principal: { targetId: "search-relevance-qa", publicOrigin: origin, internalOrigin: origin, database, apiKey, authMode: "direct" } };
  const odoo = new OdooClient(), cache = new AgentAccessSnapshotCache(odoo);
  const snapshot = await cache.initialize(context);
  context.agentIdentity = snapshot.identity;
  context.availableModules = snapshot.surface?.modules ?? null;
  context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
  context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
  const server = createCapabilityRegistry(odoo).createServer(context), client = new Client({ name: "native-content-relevance-qa", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  cleanup.push(async () => { await client.close(); await server.close(); await cache.close(); });
  return client;
}

// External disposable fixtures provide four readable records in this annotated
// order: exact title, phrase title, all title words, content-only mention.
// No fixture creation, accounting mutation or authority change happens here.
describe.skipIf(!configured)("live native content relevance", () => {
  for (const model of models) {
    it.each(["fields", "specification"])(`${model}: respects the native %s search contract`, async (selection) => {
      const client = await connected(), fixture = fixtures[model]!;
      const args = { model, domain: [["id", "in", fixture.ids], ["usl_search_text", "ilike", fixture.query]],
        ...(selection === "fields" ? { fields: ["id"] } : { specification: { id: {} } }),
        order: "usl_search_text", limit: 2, company_ids: [company], lang: process.env.ODOO_SEARCH_QA_LANG ?? "fr_FR",
        active_test: false, context: { search_relevance_query: fixture.query } };
      const first = await client.callTool({ name: "odoo_search_records", arguments: args });
      if (selection === "specification" && !specificationAllowed) {
        expect(first.isError).toBe(true);
        const text = first.content.find(item => item.type === "text");
        const error = text?.type === "text" ? JSON.parse(text.text) : first.structuredContent;
        expect(error).toMatchObject({ error: { code: "agent_read_only_action_denied" } });
        return;
      }
      expect(first.isError).not.toBe(true);
      const a = (first.structuredContent as { data: any }).data;
      expect(a.records.map((r: { id: number }) => r.id)).toEqual(fixture.ids.slice(0, 2));
      expect(a.page.has_more).toBe(true);
      const second = await client.callTool({ name: "odoo_search_records", arguments: { ...args, cursor: a.page.next_cursor } });
      expect(second.isError).not.toBe(true);
      const b = (second.structuredContent as { data: any }).data;
      expect(b.records.map((r: { id: number }) => r.id)).toEqual(fixture.ids.slice(2));
      expect(b.page.has_more).toBe(false);
    }, 60_000);

    it(`${model}: keeps an ordinary explicit ID order`, async () => {
      const client = await connected(), fixture = fixtures[model]!;
      const result = await client.callTool({ name: "odoo_search_records", arguments: {
        model, domain: [["id", "in", fixture.ids]], fields: ["id"], order: "id desc", limit: 4,
        company_ids: [company], context: { search_relevance_query: fixture.query }
      } });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { data: any }).data.records.map((r: { id: number }) => r.id))
        .toEqual([...fixture.ids].sort((a, b) => b - a));
    }, 60_000);
  }
});
