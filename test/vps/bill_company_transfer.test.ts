import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const callbacks: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(callbacks.splice(0).map((close) => close())); });
async function connected(fetcher: typeof fetch, profile: "all" | "accounting" = "accounting") {
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({ ...requestContext(), profile });
  const client = new Client({ name: "bill-company-transfer-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  callbacks.push(async () => { await client.close(); await server.close(); });
  return client;
}

const reference = (model: string, id: number, name: string) => ({ model, id, display_name: name, url: `http://localhost:8069/odoo/${model}/${id}` });
// The shape account.move.change_bill_company returns for a taxed bill with two installments.
const preview = {
  status: "ready",
  bill: reference("account.move", 4771, "Draft studio bill"),
  source_company: reference("res.company", 1, "Source Studio"),
  target_company: reference("res.company", 2, "Amber Workshop"),
  blockers: [],
  unresolved: [],
  current: { company: reference("res.company", 1, "Source Studio"), amount_total: 97.75, due_dates: [] },
  proposal: {
    journal: reference("account.journal", 12, "Vendor Bills"),
    fiscal_position: null,
    payment_term: reference("account.payment.term", 3, "30% Now, Balance 60 Days"),
    payable_account: reference("account.account", 449, "211000 Accounts Payable"),
    lines: [{
      line_id: 9001, label: "Studio rehearsal",
      from: { account: reference("account.account", 40, "600000 Expenses"), taxes: [reference("account.tax", 5, "15%")] },
      to: { account: reference("account.account", 71, "600000 Expenses"), taxes: [reference("account.tax", 15, "15%")] },
      unresolved: []
    }]
  },
  destination: {
    currency: "EUR", amount_untaxed: 85, amount_tax: 12.75, amount_total: 97.75,
    tax_groups: [{ name: "Tax 15%", amount: 12.75, base: 85 }],
    due_dates: [{ date: "2026-04-07", amount: 29.33 }, { date: "2026-06-06", amount: 68.42 }]
  },
  preview_id: "5b2f7d64c1a94f53a1b0e0c3a6d7f2b8e9c4d1a0b3f6e7d8c9a1b2c3d4e5f607",
  next_step: "Confirm with the preview_id to apply this proposal."
};
const done = {
  status: "done",
  bill: reference("account.move", 4771, "Draft studio bill"),
  before: preview.current,
  after: { company: reference("res.company", 2, "Amber Workshop"), amount_total: 97.75, due_dates: preview.destination.due_dates }
};

describe("accounting_change_bill_company", () => {
  it("moves a taxed two-installment draft bill in two calls", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(Response.json(done));
    const client = await connected(fetcher);

    const first = await client.callTool({ name: "accounting_change_bill_company", arguments: { bill_id: 4771, target_company_id: 2 } });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    const shown = (first.structuredContent as { data: { result: typeof preview } }).data.result;
    expect(shown.status).toBe("ready");
    expect(shown.proposal.lines[0]!.to.taxes[0]).toMatchObject({ id: 15 });
    expect(shown.destination.due_dates).toHaveLength(2);

    const second = await client.callTool({
      name: "accounting_change_bill_company",
      arguments: { bill_id: 4771, target_company_id: 2, confirm: true, preview_id: shown.preview_id }
    });
    expect(second.isError, JSON.stringify(second)).not.toBe(true);
    expect(second.structuredContent).toMatchObject({
      data: { outcome: "succeeded", result: { status: "done", after: { company: { id: 2 } } }, record: { model: "account.move", id: 4771 } }
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [previewUrl, previewInit] = fetcher.mock.calls[0]!;
    expect(String(previewUrl).endsWith("/json/2/account.move/change_bill_company")).toBe(true);
    expect(JSON.parse(String(previewInit?.body))).toMatchObject({ ids: [4771], target_company_id: 2, confirm: false });
    expect(JSON.parse(String(previewInit?.body))).not.toHaveProperty("preview_id");
    const [, confirmInit] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(confirmInit?.body))).toMatchObject({
      ids: [4771], target_company_id: 2, confirm: true, preview_id: shown.preview_id
    });
  });

  it("sends only the explicit mapping choices and never confirms without a preview", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(preview));
    const client = await connected(fetcher);
    const mapping = { fiscal_position_id: false, lines: [{ line_id: 9001, tax_ids: [] }] };

    await client.callTool({ name: "accounting_change_bill_company", arguments: { bill_id: 4771, target_company_id: 2, mapping } });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ mapping });

    const refused = await client.callTool({ name: "accounting_change_bill_company", arguments: { bill_id: 4771, target_company_id: 2, confirm: true } });
    expect(refused.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports blockers from the preview without treating them as a failure", async () => {
    const blocked = {
      ...preview, status: "blocked", destination: null, preview_id: preview.preview_id,
      blockers: [{
        code: "payment_linked", message: "Payment BNK1/2026/0001 is linked to this bill.",
        next_step: "Open the payment and unreconcile it from this bill, then reopen Change company.",
        records: [reference("account.payment", 88, "BNK1/2026/0001")]
      }]
    };
    const client = await connected(vi.fn<typeof fetch>(async () => Response.json(blocked)));
    const result = await client.callTool({ name: "accounting_change_bill_company", arguments: { bill_id: 4771, target_company_id: 2 } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("/odoo/account.payment/88");
  });

  it("is advertised on the accounting profile", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const accounting = await connected(fetcher, "accounting");
    expect((await accounting.listTools()).tools.map((tool) => tool.name)).toContain("accounting_change_bill_company");
  });
});
