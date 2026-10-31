import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map((callback) => callback())); });
async function connected(fetcher: typeof fetch) {
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer(requestContext());
  const client = new Client({ name: "synthetic-bill-terms-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  close.push(async () => { await client.close(); await server.close(); });
  return client;
}
const configured = {
  bill: { id: 701, display_name: "[QA] Imported bill", move_type: "in_invoice", state: "draft",
    company: { id: 1, name: "[QA] Company" }, partner: { id: 2, name: "[QA] Supplier" },
    currency: { id: 3, name: "EUR" }, invoice_date: "2026-10-17", accounting_date: "2026-10-17",
    invoice_date_due: null, reference: "QA-TERMS", review_state: "todo",
    amount_untaxed: 10, amount_tax: 0, amount_total: 10 },
  invoice_lines: [], tax_lines: [], payable_lines: []
};
function warnings(result: { structuredContent?: unknown }) {
  return (result.structuredContent as { warnings?: string[] } | undefined)?.warnings ?? [];
}
function body(fetcher: ReturnType<typeof vi.fn>, index = 0) {
  return JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body));
}

describe("printable bill terms and internal commentary", () => {
  it("advertises printable contract terms and the existing internal-note destination", async () => {
    const client = await connected(vi.fn<typeof fetch>());
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === "expenses_configure_draft_vendor_bill")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties).not.toHaveProperty("narration");
    expect(properties.terms_and_conditions?.description).toMatch(/printable.*contract/i);
    expect(tool.description).toContain("odoo_add_internal_note");
    for (const name of ["odoo_create_records", "odoo_update_records"]) {
      expect(tools.find((item) => item.name === name)?.description).toMatch(/narration.*printable/i);
    }
  });

  it("writes legal terms unchanged through one native configuration call", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(configured));
    const client = await connected(fetcher);
    const terms = "<p>[QA] The remaining balance is payable within 30 days.</p>";
    const result = await client.callTool({ name: "expenses_configure_draft_vendor_bill", arguments: {
      bill_id: 701, terms_and_conditions: terms, reference: "QA-TERMS", context: {}
    }});
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/account.move\/configure_draft_vendor_bill$/);
    expect(body(fetcher).header_values).toEqual({ narration: terms, ref: "QA-TERMS" });
    expect(body(fetcher)).not.toHaveProperty("internal_note");
    expect(warnings(result).join(" ")).toMatch(/Terms and Conditions/);
  });

  it("requires old specialized clients to refresh their ambiguous narration input", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(configured));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "expenses_configure_draft_vendor_bill", arguments: {
      bill_id: 701, narration: "[QA] Internal closing audit memo", context: {}
    }});
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps existing terms untouched when only another field is configured", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(configured));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "expenses_configure_draft_vendor_bill", arguments: {
      bill_id: 701, reference: "QA-NEW-REFERENCE", context: {}
    }});
    expect(result.isError).not.toBe(true);
    expect(body(fetcher).header_values).toEqual({ ref: "QA-NEW-REFERENCE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnings(result)).toEqual([]);
  });

  it.each([false, true])("preserves native generic terms writes and gives advisory guidance (read-back=%s)", async (readBack) => {
    const terms = "<p>[QA] Closing audit rights remain with the contracting parties.</p>";
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(readBack ? [{ id: 701, narration: terms }] : true));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "odoo_update_records", arguments: {
      model: "account.move", ids: [701], values: { narration: terms }, context: {},
      ...(readBack ? { specification: { narration: {} } } : {})
    }});
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(body(fetcher).vals).toEqual({ narration: terms });
    expect(warnings(result).join(" ")).toMatch(/printable Terms and Conditions/);
    expect(warnings(result).join(" ")).toContain("odoo_add_internal_note");
  });

  it("guides generic creation without adding a note or rewriting the terms", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([701]));
    const client = await connected(fetcher);
    const values = { move_type: "in_invoice", narration: "[QA] Internal accounting memo" };
    const result = await client.callTool({ name: "odoo_create_records", arguments: {
      model: "account.move", values: [values], context: {}
    }});
    expect(result.isError).not.toBe(true);
    expect(body(fetcher).vals_list).toEqual([values]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnings(result).join(" ")).toContain("odoo_add_internal_note");
  });

  it("keeps internal commentary in one non-notifying native Chatter append", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 702 }));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "odoo_add_internal_note", arguments: {
      model: "account.move", id: 701, body: "[QA] Memo: 1 < 2 & internal only", body_is_html: false, context: {}
    }});
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/account.move\/message_post$/);
    expect(body(fetcher)).toMatchObject({ subtype_xmlid: "mail.mt_note", partner_ids: [], notify_skip_followers: true });
    expect(body(fetcher).body).toContain("1 &lt; 2 &amp; internal only");
    expect(body(fetcher)).not.toHaveProperty("narration");
  });

  it.each([
    ["account.move", { narration: "" }],
    ["account.move", { narration: false }],
    ["account.move", { narration: "   " }],
    ["res.partner", { narration: "[QA] Unrelated model value" }],
  ])("does not add terms advice for an empty value or another model (%s, %j)", async (model, values) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(true));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "odoo_update_records", arguments: {
      model, ids: [701], values, context: {}
    }});
    expect(result.isError).not.toBe(true);
    expect(body(fetcher).vals).toEqual(values);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnings(result)).toEqual([]);
  });

  it("does not replay an internal note after a lost response", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("synthetic response lost"); });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "odoo_add_internal_note", arguments: {
      model: "account.move", id: 701, body: "[QA] Internal only", context: {}
    }});
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain("unknown");
  });

  it("does not replay a configuration or append a note after a lost response", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("synthetic response lost"); });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "expenses_configure_draft_vendor_bill", arguments: {
      bill_id: 701, terms_and_conditions: "[QA] Legal terms", context: {}
    }});
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain("unknown");
  });
});
