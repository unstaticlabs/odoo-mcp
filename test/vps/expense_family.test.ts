import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const callbacks: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(callbacks.splice(0).map((close) => close())); });
async function connected(fetcher: typeof fetch) {
  const context = requestContext();
  context.availablePublicMethods = new Map(context.availablePublicMethods);
  (context.availablePublicMethods as Map<string, ReadonlySet<string>>).set("hr.expense", new Set([
    "configure_draft_expense", "split_draft_expense", "configure_draft_expense_family"
  ]));
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({ ...context, profile: "all" });
  const client = new Client({ name: "expense-family-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  callbacks.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("atomic native draft expense families", () => {
  it("splits explicit gross lines once and returns every native record link and totals", async () => {
    const native = { origin_id: 91, before_total: 160, after_total: 160, currency_id: 1,
      expenses: [{ id: 91, display_name: "[QA] Duty" }, { id: 92, display_name: "[QA] Service" }, { id: 93, display_name: "[QA] Import VAT" }] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(native));
    const client = await connected(fetcher);
    const lines = [{ name: "[QA] Duty", total_amount_currency: 33, tax_ids: [] },
      { name: "[QA] Service", total_amount_currency: 47, tax_ids: [8] },
      { name: "[QA] Import VAT", total_amount_currency: 80, account_id: 9, tax_ids: [] }];
    const result = await client.callTool({ name: "expenses_split_draft", arguments: { expense_id: 91, lines } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/hr\.expense\/split_draft_expense$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({ ids: [91], lines });
    expect(result.structuredContent).toMatchObject({ data: { before_total: 160, after_total: 160,
      source: { model: "hr.expense", id: 91 }, records: [{ id: 91 }, { id: 92 }, { id: 93 }] } });
    expect(JSON.stringify(result.structuredContent)).toContain("/odoo/hr.expense/93");
  });

  it("corrects only an explicitly named complete family in one transaction", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ origin_id: 91, expenses: [{ id: 91 }, { id: 92 }],
      totals: [{ currency_id: 1, before_total: 100, after_total: 100 }] }));
    const client = await connected(fetcher);
    const lines = [{ expense_id: 91, values: { account_id: 9, tax_ids: [], expense_batch_id: false } },
      { expense_id: 92, values: { account_id: 10, tax_ids: [], expense_batch_id: false } }];
    const result = await client.callTool({ name: "expenses_correct_draft_family", arguments: {
      expense_id: 91, expense_ids: [91, 92], company_id: 2, employee_id: 12, lines,
      context: { allowed_company_ids: [1, 2] }
    } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/hr\.expense\/configure_draft_expense_family$/);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ ids: [91], expense_ids: [91, 92], company_id: 2, employee_id: 12, lines });
  });

  it("never replays a split after ambiguous completion", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("Connection closed"); });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "expenses_split_draft", arguments: {
      expense_id: 91, lines: [{ name: "[QA] One", total_amount_currency: 30 }, { name: "[QA] Two", total_amount_currency: 70 }]
    } });
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain("unknown");
  });

  it("rejects unbounded or forged split fields without transport", async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = await connected(fetcher);
    for (const lines of [[], [{ name: "[QA] One", total_amount_currency: 30 }],
      [{ name: "[QA] One", total_amount_currency: 30, company_id: 2 }, { name: "[QA] Two", total_amount_currency: 70 }]]) {
      expect((await client.callTool({ name: "expenses_split_draft", arguments: { expense_id: 91, lines } })).isError).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never replays an ambiguous whole-family correction", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("Connection closed"); });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "expenses_correct_draft_family", arguments: {
      expense_id: 91, expense_ids: [91, 92], company_id: 2, employee_id: 12,
      lines: [{ expense_id: 91, values: {} }, { expense_id: 92, values: {} }]
    } });
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain("unknown");
  });

  it("does not replace an incomplete-family denial with another action", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      name: "odoo.exceptions.UserError", message: "Refresh Split Expenses and review the whole family before retrying."
    }, { status: 400 }));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "expenses_correct_draft_family", arguments: {
      expense_id: 91, expense_ids: [91, 92], company_id: 2, employee_id: 12,
      lines: [{ expense_id: 91, values: {} }, { expense_id: 92, values: {} }]
    } });
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain("review the whole family");
  });

  it("rejects financial-state and amount overrides in family mappings", async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = await connected(fetcher);
    for (const values of [{ state: "paid" }, { total_amount: 999 }, { company_id: 3 }, { employee_id: 99 }]) {
      const result = await client.callTool({ name: "expenses_correct_draft_family", arguments: {
        expense_id: 91, expense_ids: [91, 92], company_id: 2, employee_id: 12,
        lines: [{ expense_id: 91, values }, { expense_id: 92, values: {} }]
      } });
      expect(result.isError).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
