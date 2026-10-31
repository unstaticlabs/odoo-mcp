import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixture = process.env.ODOO_INTEGRATION_EXPENSE_FAMILY_FIXTURE;
const enabled = process.env.ODOO_INTEGRATION_MUTATION_QA === "1" && Boolean(fixture);
type Part = { id: number; state: string; company_id: [number, string]; total_amount_currency: number };
type Fixture = { source_company_id: number; target_company_id: number; target_employee_id: number;
  target_account_id: number; expense_ids: number[]; family_ids: number[]; family_origin_id: number; split_lines: unknown[] };

describe.skipIf(!enabled)("synthetic managed Agent native expense families", () => {
  let client: Client; let cleanup: () => Promise<void>; let input: Fixture;
  beforeAll(async () => {
    input = JSON.parse(fixture!);
    if (process.env.ODOO_INTEGRATION_DATABASE !== "odoo_action_risk") throw new Error("Use the dedicated synthetic QA registry");
    const context: RequestContext = {
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "all",
      principal: { targetId: "synthetic-expense-family", authMode: "direct", publicOrigin: process.env.ODOO_INTEGRATION_ORIGIN!,
        internalOrigin: process.env.ODOO_INTEGRATION_INTERNAL_ORIGIN!, database: process.env.ODOO_INTEGRATION_DATABASE!,
        apiKey: process.env.ODOO_INTEGRATION_API_KEY! }
    };
    const odoo = new OdooClient(); const cache = new AgentAccessSnapshotCache(odoo); const snapshot = await cache.initialize(context);
    context.agentIdentity = snapshot.identity; context.availableModules = snapshot.surface?.modules ?? null;
    context.availablePublicMethods = snapshot.surface?.publicMethods ?? null; context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context); context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
    const server = createCapabilityRegistry(odoo).createServer(context);
    client = new Client({ name: "synthetic-expense-family-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    cleanup = async () => { await client.close(); await server.close(); await cache.close(); };
  }, 60_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  const companies = () => ({ allowed_company_ids: [input.source_company_id, input.target_company_id] });
  async function read(ids: number[]) {
    const reply = await client.callTool({ name: "odoo_read_records", arguments: { model: "hr.expense", ids,
      fields: ["state", "company_id", "employee_id", "account_id", "tax_ids", "expense_batch_id", "total_amount_currency", "currency_id", "account_move_id", "message_main_attachment_id", "split_expense_origin_id"], context: companies() } });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true); return (reply.structuredContent as { data: { records: Part[] } }).data.records;
  }
  function correction(ids: number[], context = companies()) {
    return { expense_id: input.family_origin_id, expense_ids: ids, company_id: input.target_company_id,
      employee_id: input.target_employee_id, lines: ids.map((id) => ({ expense_id: id, values: {
        product_id: false, account_id: input.target_account_id, tax_ids: [], analytic_distribution: {}, expense_batch_id: false } })), context };
  }
  it("creates mixed native draft parts and reads persisted totals and evidence", async () => {
    const id = input.expense_ids[0]!;
    const reply = await client.callTool({ name: "expenses_split_draft", arguments: { expense_id: id, lines: input.split_lines, context: companies() } });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const data = (reply.structuredContent as { data: { records: { id: number; url: string }[] } }).data;
    expect(reply.structuredContent).toMatchObject({ data: { origin_id: id, before_total: 160, after_total: 160 } });
    const parts = await read(data.records.map((part) => part.id));
    expect(parts.map((part) => part.total_amount_currency)).toEqual([33, 47, 80]);
    expect(parts.every((part) => part.state === "draft")).toBe(true);
    expect(data.records.every((part) => part.url.endsWith(`/odoo/hr.expense/${part.id}`))).toBe(true);
    for (const part of parts) expect(part).toMatchObject({ company_id: [input.source_company_id, expect.any(String)], message_main_attachment_id: expect.any(Array) });
  }, 60_000);
  it("denies an incomplete family without changing any named member", async () => {
    const before = await read(input.family_ids);
    const reply = await client.callTool({ name: "expenses_correct_draft_family", arguments: correction(input.family_ids.slice(0, 2)) });
    expect(reply.isError).toBe(true); expect(await read(input.family_ids)).toEqual(before);
  }, 60_000);
  it("denies an unselected target company without changing the family", async () => {
    const before = await read(input.family_ids);
    const reply = await client.callTool({ name: "expenses_correct_draft_family", arguments: correction(input.family_ids, { allowed_company_ids: [input.source_company_id] }) });
    expect(reply.isError).toBe(true); expect(await read(input.family_ids)).toEqual(before);
  }, 60_000);
  it("corrects the explicitly named complete family and reads target ownership", async () => {
    const reply = await client.callTool({ name: "expenses_correct_draft_family", arguments: correction(input.family_ids) });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(reply.structuredContent).toMatchObject({ data: { totals: [{ before_total: 160, after_total: 160 }] } });
    const parts = await read(input.family_ids);
    expect(parts.map((part) => part.total_amount_currency)).toEqual([33, 47, 80]);
    for (const part of parts) expect(part).toMatchObject({ state: "draft", company_id: [input.target_company_id, expect.any(String)], employee_id: [input.target_employee_id, expect.any(String)], expense_batch_id: false });
  }, 60_000);
  it("denies genuine posted expense splitting and preserves its journal identity", async () => {
    const id = input.expense_ids[5]!; const before = await read([id]);
    expect(before[0]).toMatchObject({ state: "posted", account_move_id: expect.any(Array) });
    const reply = await client.callTool({ name: "expenses_split_draft", arguments: { expense_id: id, lines: input.split_lines, context: companies() } });
    expect(reply.isError).toBe(true); expect(await read([id])).toEqual(before);
  }, 60_000);
});
