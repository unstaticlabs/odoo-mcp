import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connected(fetcher: typeof fetch) {
  const odoo = new OdooClient(8, 1024 * 1024, fetcher);
  const server = createCapabilityRegistry(odoo).createServer({ ...requestContext(), profile: "all" });
  const client = new Client({ name: "operational-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("fixed-intent operational capabilities", () => {
  it("renders a vendor receipt dry-run without contacting Odoo", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "inventory_create_draft_vendor_receipt",
      arguments: {
        partner_id: 1,
        picking_type_id: 2,
        location_id: 3,
        location_dest_id: 4,
        scheduled_date: "2026-08-30T10:15:00+02:00",
        lines: [{ product_id: 5, product_uom_id: 6, quantity: 2 }],
        dry_run: true,
        context: {}
      }
    });
    expect(result.isError).not.toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      data: {
        dry_run: true,
        planned_values: {
          scheduled_date: "2026-08-30 08:15:00",
          move_ids: [[0, 0, { product_id: 5, product_uom_qty: 2 }]]
        }
      }
    });
  });

  it("returns the created receipt identity when the follow-up read fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/create")
      ? Response.json(91)
      : new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 503 }));
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "inventory_create_draft_vendor_receipt",
      arguments: {
        partner_id: 1,
        picking_type_id: 2,
        location_id: 3,
        location_dest_id: 4,
        scheduled_date: "2026-08-30T10:15:00+02:00",
        lines: [{ product_id: 5, product_uom_id: 6, quantity: 2 }],
        dry_run: false,
        context: {}
      }
    });
    expect(result.isError).not.toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/create"))).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      data: {
        record: { model: "stock.picking", id: 91 },
        warnings: [expect.stringContaining("do not create another receipt")]
      }
    });
  });

  it("runs an expense transition as one non-retried Odoo method call", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/action_submit")
      ? Response.json(true)
      : Response.json([
          { id: 10, display_name: "Expense 10", state: "submitted" },
          { id: 11, display_name: "Expense 11", state: "approved" }
        ]));
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "expenses_submit",
      arguments: { expense_ids: [10, 11], context: { allowed_company_ids: [2] } }
    });
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const actionCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/json/2/hr.expense/action_submit"));
    expect(actionCalls).toHaveLength(1);
    const [url, init] = actionCalls[0]!;
    expect(String(url).endsWith("/json/2/hr.expense/action_submit")).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      ids: [10, 11],
      context: { allowed_company_ids: [2], usl_agent_origin: "odoo-mcp" }
    });
    expect(result.structuredContent).toMatchObject({
      data: { result: { observed: [{ id: 10, state: "submitted" }, { id: 11, state: "approved" }] } }
    });
  });

  it("configures a draft vendor bill through one atomic Odoo business method", async () => {
    const configured = {
      bill: {
        id: 5161,
        display_name: "BILL/2026/5161",
        move_type: "in_invoice",
        state: "draft",
        company: { id: 1, name: "Unstatic Labs" },
        partner: { id: 20, name: "Supplier" },
        currency: { id: 1, name: "EUR" },
        invoice_date: "2026-09-04",
        accounting_date: "2026-09-04",
        invoice_date_due: "2026-10-04",
        reference: "INV-5161",
        review_state: "reviewed",
        amount_untaxed: 8.61,
        amount_tax: 1.72,
        amount_total: 10.33
      },
      invoice_lines: [{
        id: 12390,
        name: "Service",
        product: null,
        account: { id: 60, name: "Services" },
        quantity: 1,
        price_unit: 8.61,
        discount: 0,
        tax_ids: [26],
        analytic_distribution: {},
        price_subtotal: 8.61,
        price_total: 10.33
      }],
      tax_lines: [{
        id: 12391,
        name: "VAT 20%",
        account: { id: 61, name: "Deductible VAT" },
        tax: { id: 26, name: "20% S" },
        balance: 1.72,
        amount_currency: 1.72
      }],
      payable_lines: [{
        id: 12392,
        name: "INV-5161",
        account: { id: 62, name: "Payable" },
        date_maturity: "2026-10-04",
        balance: -10.33,
        amount_currency: -10.33
      }]
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(configured));
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "expenses_configure_draft_vendor_bill",
      arguments: {
        bill_id: 5161,
        review_state: "reviewed",
        line_patches: [{ line_id: 12390, tax_ids: [26], price_unit: 8.61 }],
        context: { allowed_company_ids: [1] }
      }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith("/json/2/account.move/configure_draft_vendor_bill")).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({
      ids: [5161],
      header_values: { review_state: "reviewed" },
      line_patches: [{ line_id: 12390, tax_ids: [26], price_unit: 8.61 }],
      context: {
        allowed_company_ids: [1],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: expect.any(String)
      }
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        result: configured,
        outcome: "succeeded",
        record: { model: "account.move", id: 5161 }
      }
    });
  });

  it("reports when Odoo returns an approval wizard without reaching the approved state", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/action_approve")
      ? Response.json({ type: "ir.actions.act_window", res_model: "hr.expense.approve.duplicate" })
      : Response.json([{ id: 10, display_name: "Expense 10", state: "submitted" }]));
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "expenses_approve",
      arguments: { expense_ids: [10], context: {} }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        result: { method_result: { type: "ir.actions.act_window" }, observed: [{ id: 10, state: "submitted" }] },
        outcome: "requires_follow_up"
      },
      warnings: [expect.stringContaining("follow-up wizard")]
    });
  });

  it("rejects malformed project attachment bytes before any Odoo call", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "projects_attach_file",
      arguments: {
        task_id: 42,
        name: "evidence.txt",
        data_base64: "not base64!",
        context: {}
      }
    });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
