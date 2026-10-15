import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixture = process.env.ODOO_INTEGRATION_EXPENSE_FIXTURE;
const enabled = process.env.ODOO_INTEGRATION_MUTATION_QA === "1" && Boolean(fixture);

describe.skipIf(!enabled).sequential("synthetic managed Agent draft expense correction", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let input: { source_company_id: number; target_company_id: number; target_employee_id: number; target_account_id: number; expense_ids: number[]; posted_expense_id: number };

  beforeAll(async () => {
    input = JSON.parse(fixture!);
    if (process.env.ODOO_INTEGRATION_DATABASE !== "odoo_action_risk") throw new Error("Use the dedicated synthetic QA registry");
    const context: RequestContext = {
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "all",
      principal: {
        targetId: "synthetic-expense-correction", authMode: "direct",
        publicOrigin: process.env.ODOO_INTEGRATION_ORIGIN!,
        internalOrigin: process.env.ODOO_INTEGRATION_INTERNAL_ORIGIN!,
        database: process.env.ODOO_INTEGRATION_DATABASE!, apiKey: process.env.ODOO_INTEGRATION_API_KEY!
      }
    };
    const odoo = new OdooClient();
    const cache = new AgentAccessSnapshotCache(odoo);
    const snapshot = await cache.initialize(context);
    context.agentIdentity = snapshot.identity;
    context.availableModules = snapshot.surface?.modules ?? null;
    context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
    context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context);
    context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
    const server = createCapabilityRegistry(odoo).createServer(context);
    client = new Client({ name: "synthetic-expense-correction-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup = async () => { await client.close(); await server.close(); await cache.close(); };
  }, 60_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  async function read(expenseId: number) {
    return client.callTool({ name: "odoo_read_records", arguments: {
      model: "hr.expense", ids: [expenseId], fields: ["state", "company_id", "employee_id", "expense_batch_id", "total_amount_currency", "account_move_id"],
      context: { allowed_company_ids: [input.source_company_id, input.target_company_id] }
    }});
  }

  it("corrects owned evidence and batch membership, and reads the persisted target pair", async () => {
    const id = input.expense_ids[0]!;
    const result = await client.callTool({ name: "expenses_update_draft", arguments: {
      expense_id: id, company_id: input.target_company_id, employee_id: input.target_employee_id,
      product_id: false, account_id: input.target_account_id, tax_ids: [], analytic_distribution: {}, expense_batch_id: false,
      context: { allowed_company_ids: [input.source_company_id, input.target_company_id] }
    }});
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: {
      result: true, outcome: "succeeded", expense: {
        id, state: "draft", company_id: [input.target_company_id, expect.any(String)],
        employee_id: [input.target_employee_id, expect.any(String)], expense_batch_id: false,
        total_amount_currency: 42, message_main_attachment_id: expect.any(Array)
      }
    }});
    expect((await read(id)).structuredContent).toMatchObject({ data: { records: [{
      id, state: "draft", company_id: [input.target_company_id, expect.any(String)],
      employee_id: [input.target_employee_id, expect.any(String)], expense_batch_id: false, total_amount_currency: 42
    }] } });
  }, 60_000);

  it("leaves an incompatible existing account and company unchanged after denial", async () => {
    const id = input.expense_ids[1]!;
    const result = await client.callTool({ name: "expenses_update_draft", arguments: {
      expense_id: id, company_id: input.target_company_id, employee_id: input.target_employee_id,
      product_id: false, tax_ids: [], analytic_distribution: {},
      context: { allowed_company_ids: [input.source_company_id, input.target_company_id] }
    }});
    expect(result.isError, JSON.stringify(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("account_id");
    expect((await read(id)).structuredContent).toMatchObject({ data: { records: [{
      id, state: "draft", company_id: [input.source_company_id, expect.any(String)], total_amount_currency: 43
    }] } });
  }, 60_000);

  it("refuses a target outside the selected company context", async () => {
    const id = input.expense_ids[2]!;
    const result = await client.callTool({ name: "expenses_update_draft", arguments: {
      expense_id: id, company_id: input.target_company_id, employee_id: input.target_employee_id,
      product_id: false, account_id: false, tax_ids: [], analytic_distribution: {},
      context: { allowed_company_ids: [input.source_company_id] }
    }});
    expect(result.isError).toBe(true);
    expect((await read(id)).structuredContent).toMatchObject({ data: { records: [{
      id, company_id: [input.source_company_id, expect.any(String)], total_amount_currency: 44
    }] } });
  }, 60_000);

  it("leaves a genuinely posted expense and its journal identity unchanged", async () => {
    const id = input.posted_expense_id;
    expect(id).toBeGreaterThan(0);
    const before = await read(id);
    expect(before.structuredContent).toMatchObject({ data: { records: [{
      id, state: "posted", account_move_id: expect.any(Array), total_amount_currency: 57
    }] } });
    const result = await client.callTool({ name: "expenses_update_draft", arguments: {
      expense_id: id, company_id: input.target_company_id, employee_id: input.target_employee_id,
      product_id: false, account_id: false, tax_ids: [], analytic_distribution: {},
      context: { allowed_company_ids: [input.source_company_id, input.target_company_id] }
    }});
    expect(result.isError).toBe(true);
    const after = await read(id);
    expect(after.structuredContent).toMatchObject({ data: { records: (before.structuredContent as { data: { records: unknown } }).data.records } });
  }, 60_000);
});
