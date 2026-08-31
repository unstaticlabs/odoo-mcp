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
