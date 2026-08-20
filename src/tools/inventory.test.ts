/**
 * `inventory.create_draft_vendor_receipt` (ODOO2298) — tool-level contract.
 *
 * The two invariants worth a regression each: the receipt is left **unvalidated** (no
 * `button_validate` / `action_validate` ever leaves this tool), and `dry_run` costs zero writes
 * while returning exactly the payload a real run would send.
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OdooError } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import {
  buildDraftVendorReceiptVals,
  normalizeScheduledDate,
  registerInventoryTools,
  RECEIPT_PRE_VALIDATION_STATES
} from "./inventory";
import { validatedToolHandler } from "./structured-test-util";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
type Call = { model: string; method: string; args: Record<string, unknown> };

/** Queue recording every Odoo call, so "no write at all" and "exactly one create" are assertable. */
function recordingQueue(responder: (call: Call) => unknown) {
  const calls: Call[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const call: Call = { model: a[1] as string, method: a[2] as string, args: a[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call);
  });
  const queue = {
    enqueue,
    snapshot: () => calls.length,
    delta: (snap: number) => ({ odoo_calls: calls.length - snap, total_duration_ms: 0, calls: [] })
  } as unknown as OdooQueue;
  return { queue, calls };
}

const PARTNER = { id: 512, name: "Acme SARL" };
const INTERNAL_LOCATION = { id: 8, complete_name: "WH/Stock", usage: "internal", company_id: [1, "Acme"] };
const INCOMING_TYPE = {
  id: 1,
  name: "Receipts",
  code: "incoming",
  default_location_src_id: [4, "Partners/Vendors"],
  default_location_dest_id: [8, "WH/Stock"],
  warehouse_id: [1, "Acme WH"],
  company_id: [1, "Acme"]
};
const PRODUCT = { id: 77, display_name: "Blue Mug", uom_id: [1, "Units"] };

/**
 * Stands up the pre-reads (partner, location, operation type, products), the picking create, the
 * read-back and the chatter post. Every stub is overridable so refusal paths can swap one row out.
 */
function receiptQueue(
  opts: {
    partner?: Record<string, unknown> | null;
    location?: Record<string, unknown> | null;
    pickingType?: Record<string, unknown> | null;
    pickingTypeCandidates?: Record<string, unknown>[];
    products?: Record<string, unknown>[];
    createdId?: number;
    readBack?: Record<string, unknown> | null;
    failMessagePost?: boolean;
  } = {}
) {
  return recordingQueue((call) => {
    if (call.model === "res.partner") return opts.partner === null ? [] : [opts.partner ?? PARTNER];
    if (call.model === "stock.location") return opts.location === null ? [] : [opts.location ?? INTERNAL_LOCATION];
    if (call.model === "stock.picking.type") {
      if (call.method === "search_read") return opts.pickingTypeCandidates ?? [INCOMING_TYPE];
      return opts.pickingType === null ? [] : [opts.pickingType ?? INCOMING_TYPE];
    }
    if (call.model === "product.product") return opts.products ?? [PRODUCT];
    if (call.model === "stock.picking" && call.method === "create") return [opts.createdId ?? 4242];
    if (call.model === "stock.picking" && call.method === "read") {
      if (opts.readBack === null) return [];
      return [
        opts.readBack ?? {
          id: opts.createdId ?? 4242,
          name: "WH/IN/00042",
          state: "draft",
          picking_type_code: "incoming",
          move_ids: [9001],
          scheduled_date: "2026-06-30 00:00:00",
          origin: "PO-2026-114"
        }
      ];
    }
    if (call.method === "message_post") {
      if (opts.failMessagePost) throw new Error("odoo message_post boom");
      return 123;
    }
    return null;
  });
}

function buildHandler(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerInventoryTools(server, () => props, queue);
  return {
    server,
    createReceipt: validatedToolHandler(server, "inventory.create_draft_vendor_receipt") as (
      args: unknown
    ) => Promise<ToolResult>
  };
}

const baseArgs = {
  partner_id: 512,
  location_dest_id: 8,
  scheduled_date: "2026-06-30",
  origin: "PO-2026-114",
  lines: [{ product_id: 77, product_uom_id: 1, quantity: 3 }],
  context: "FY2025-26 close: reconstructing the June receipt evidence for Acme"
};

describe("registration", () => {
  test("registers as a write tool that documents the missing validate path", () => {
    const { server } = buildHandler(receiptQueue().queue);
    const tool = (server as any)._registeredTools["inventory.create_draft_vendor_receipt"];

    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.annotations.openWorldHint).toBe(false);
    expect(String(tool.description).startsWith("Write:")).toBe(true);
    expect(tool.description).toContain("button_validate");
    expect(tool.description).toContain("web_url");
  });

  test("context is required and non-empty; lines must carry positive quantities", () => {
    const { server } = buildHandler(receiptQueue().queue);
    const shape = (server as any)._registeredTools["inventory.create_draft_vendor_receipt"].inputSchema.shape;

    expect(shape.context.safeParse("recording the June receipt").success).toBe(true);
    expect(shape.context.safeParse("").success).toBe(false);
    expect(shape.context.safeParse(undefined).success).toBe(false);
    expect(shape.lines.safeParse([]).success).toBe(false);
    expect(shape.lines.safeParse([{ product_id: 77, product_uom_id: 1, quantity: 0 }]).success).toBe(false);
    expect(shape.lines.safeParse([{ product_id: 77, product_uom_id: 1, quantity: 2.5 }]).success).toBe(true);
  });
});

describe("dry_run", () => {
  test("returns the planned vals and resolved defaults without a single write", async () => {
    const { queue, calls } = receiptQueue();
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt({ ...baseArgs, dry_run: true, note: "Goods received per delivery note DN-88" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      dry_run: true,
      picking_type_id: 1,
      move_count: 1,
      scheduled_date: "2026-06-30 00:00:00",
      origin: "PO-2026-114"
    });
    expect(result.structuredContent?.planned_vals).toEqual({
      picking_type_id: 1,
      partner_id: 512,
      location_id: 4,
      location_dest_id: 8,
      scheduled_date: "2026-06-30 00:00:00",
      origin: "PO-2026-114",
      note: "Goods received per delivery note DN-88",
      move_ids: [
        [
          0,
          0,
          {
            name: "Blue Mug",
            product_id: 77,
            product_uom: 1,
            product_uom_qty: 3,
            location_id: 4,
            location_dest_id: 8
          }
        ]
      ]
    });
    // Reads only — the whole point of the preview.
    expect(calls.every((c) => ["read", "search_read"].includes(c.method))).toBe(true);
    expect(calls.some((c) => c.model === "stock.picking")).toBe(false);
  });

  test("the previewed vals are byte-identical to what a real run sends", async () => {
    const preview = await (async () => {
      const { queue } = receiptQueue();
      const { createReceipt } = buildHandler(queue);
      const result = await createReceipt({ ...baseArgs, dry_run: true });
      return result.structuredContent?.planned_vals;
    })();

    const { queue, calls } = receiptQueue();
    const { createReceipt } = buildHandler(queue);
    await createReceipt(baseArgs);

    const create = calls.find((c) => c.method === "create")!;
    expect((create.args.vals_list as unknown[])[0]).toEqual(preview);
  });
});

describe("create", () => {
  test("issues exactly one stock.picking create with nested moves, then reads back and stamps chatter", async () => {
    const { queue, calls } = receiptQueue();
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      dry_run: false,
      picking_id: 4242,
      picking_type_id: 1,
      move_count: 1,
      state: "draft",
      move_ids: [9001],
      name: "WH/IN/00042",
      origin: "PO-2026-114",
      // /odoo/receipts/{id} — the verified STOCK_PICKING_PATHS route for an incoming picking.
      web_url: "http://example.com/odoo/receipts/4242"
    });
    expect(typeof result.structuredContent?.trace_token).toBe("string");

    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      "res.partner.read",
      "stock.location.read",
      "stock.picking.type.search_read",
      "product.product.read",
      "stock.picking.create",
      "stock.picking.read",
      "stock.picking.message_post"
    ]);
    expect(calls.filter((c) => c.method === "create").length).toBe(1);

    const body = String(calls.find((c) => c.method === "message_post")!.args.body);
    expect(body).toContain("inventory.create_draft_vendor_receipt");
    expect(body).toContain("PO-2026-114");
    expect(body).toContain("FY2025-26 close");
  });

  test("never calls a validation method, whatever else it does", async () => {
    const { queue, calls } = receiptQueue();
    const { createReceipt } = buildHandler(queue);

    await createReceipt({ ...baseArgs, lines: [{ product_id: 77, product_uom_id: 1, quantity: 3, name: "Mugs" }] });

    for (const call of calls) {
      expect(["read", "search_read", "create", "message_post"]).toContain(call.method);
      expect(call.method).not.toMatch(/validate|_action_done|action_confirm|action_assign/i);
    }
    // The accepted read-back states are all pre-validation: `done` and `cancel` are not among them.
    expect([...RECEIPT_PRE_VALIDATION_STATES].sort()).toEqual(["assigned", "confirmed", "draft", "waiting"]);
  });

  test("an explicit picking_type_id is verified as incoming and used as-is", async () => {
    const { queue, calls } = receiptQueue();
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt({ ...baseArgs, picking_type_id: 1 });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => `${c.model}.${c.method}`)).toContain("stock.picking.type.read");
    expect(calls.some((c) => c.method === "search_read")).toBe(false);
  });

  test("a warehouse_id narrows the incoming-type lookup", async () => {
    const { queue, calls } = receiptQueue();
    const { createReceipt } = buildHandler(queue);

    await createReceipt({ ...baseArgs, warehouse_id: 1, company_id: 1 });

    const search = calls.find((c) => c.method === "search_read")!;
    expect(search.args.domain).toEqual([
      ["code", "=", "incoming"],
      ["warehouse_id", "=", 1],
      ["company_id", "=", 1]
    ]);
    const vals = (calls.find((c) => c.method === "create")!.args.vals_list as Record<string, unknown>[])[0];
    expect(vals.company_id).toBe(1);
  });

  test("several matching incoming types pick the first and say so", async () => {
    const { queue } = receiptQueue({
      pickingTypeCandidates: [INCOMING_TYPE, { ...INCOMING_TYPE, id: 9, name: "Receipts (Annex)" }]
    });
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt(baseArgs);

    expect(result.structuredContent?.picking_type_id).toBe(1);
    expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("2 incoming operation types matched");
  });

  test("an operation type without a default source location omits location_id and warns", async () => {
    const { queue, calls } = receiptQueue({
      pickingTypeCandidates: [{ ...INCOMING_TYPE, default_location_src_id: false }]
    });
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt(baseArgs);

    const vals = (calls.find((c) => c.method === "create")!.args.vals_list as Record<string, unknown>[])[0];
    expect(vals.location_id).toBeUndefined();
    expect((vals.move_ids as any[])[0][2].location_id).toBeUndefined();
    expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("no default source location");
  });

  test("a line UoM that is not the product's own is allowed but flagged", async () => {
    const { queue } = receiptQueue();
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt({
      ...baseArgs,
      lines: [{ product_id: 77, product_uom_id: 5, quantity: 2 }]
    });

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("uses uom 5");
  });

  test("a chatter failure degrades to provenance_warning rather than hiding the receipt", async () => {
    const { queue } = receiptQueue({ failMessagePost: true });
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.picking_id).toBe(4242);
    expect(String(result.structuredContent?.provenance_warning)).toContain("4242");
  });
});

describe("refusals", () => {
  async function refuse(args: Record<string, unknown>, opts: Parameters<typeof receiptQueue>[0] = {}) {
    const { queue, calls } = receiptQueue(opts);
    const { createReceipt } = buildHandler(queue);
    const result = await createReceipt({ ...baseArgs, ...args });
    expect(result.isError).toBe(true);
    return { envelope: JSON.parse(result.content[0].text), calls };
  }

  test("an unparseable scheduled_date, before any Odoo call", async () => {
    const { envelope, calls } = await refuse({ scheduled_date: "last June" });
    expect(envelope.error).toBe("invalid_scheduled_date");
    expect(envelope.intent).toBe("inventory_operation");
    expect(envelope.recoverable).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a non-internal destination location", async () => {
    const { envelope, calls } = await refuse(
      {},
      { location: { id: 4, complete_name: "Partners/Vendors", usage: "supplier", company_id: false } }
    );
    expect(envelope.error).toBe("invalid_destination_location");
    expect(envelope.details).toContain("usage=supplier");
    expect(calls.some((c) => c.method === "create")).toBe(false);
  });

  test("an unknown vendor, before the location is even read", async () => {
    const { envelope, calls } = await refuse({}, { partner: null });
    expect(envelope.error).toBe("not_found");
    expect(envelope.model).toBe("res.partner");
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["res.partner.read"]);
  });

  test("an outgoing picking_type_id", async () => {
    const { envelope, calls } = await refuse(
      { picking_type_id: 2 },
      { pickingType: { ...INCOMING_TYPE, id: 2, code: "outgoing" } }
    );
    expect(envelope.error).toBe("invalid_picking_type");
    expect(envelope.details).toContain("code=outgoing");
    expect(calls.some((c) => c.method === "create")).toBe(false);
  });

  test("no incoming operation type on the database", async () => {
    const { envelope, calls } = await refuse({ warehouse_id: 3 }, { pickingTypeCandidates: [] });
    expect(envelope.error).toBe("picking_type_unresolved");
    expect(envelope.details).toContain("warehouse 3");
    expect(calls.some((c) => c.method === "create")).toBe(false);
  });

  test("a line naming a product that does not exist", async () => {
    const { envelope, calls } = await refuse(
      { lines: [{ product_id: 77, product_uom_id: 1, quantity: 1 }, { product_id: 99, product_uom_id: 1, quantity: 1 }] },
      { products: [PRODUCT] }
    );
    expect(envelope.error).toBe("not_found");
    expect(envelope.model).toBe("product.product");
    expect(envelope.details).toContain("99");
    expect(calls.some((c) => c.method === "create")).toBe(false);
  });

  test("a receipt that reads back already validated is reported, never silently accepted", async () => {
    const { envelope } = await refuse(
      {},
      {
        readBack: {
          id: 4242,
          name: "WH/IN/00042",
          state: "done",
          picking_type_code: "incoming",
          move_ids: [9001],
          scheduled_date: "2026-06-30 00:00:00",
          origin: "PO-2026-114"
        }
      }
    );
    expect(envelope.error).toBe("unexpected_state");
    expect(envelope.details).toContain("state=done");
  });

  test("an Odoo ACL denial on the create surfaces as a structured envelope", async () => {
    const { queue } = recordingQueue((call) => {
      if (call.model === "res.partner") return [PARTNER];
      if (call.model === "stock.location") return [INTERNAL_LOCATION];
      if (call.model === "stock.picking.type") return [INCOMING_TYPE];
      if (call.model === "product.product") return [PRODUCT];
      throw new OdooError({
        message: "Access Denied",
        code: "permission_denied",
        httpStatus: 403,
        model: "stock.picking",
        method: "create",
        details: "You are not allowed to create 'Transfer' (stock.picking) records."
      });
    });
    const { createReceipt } = buildHandler(queue);

    const result = await createReceipt(baseArgs);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("permission_denied");
    expect(envelope.refusing_layer).toBe("odoo_acl");
    expect(result.content[0].text).not.toContain("secret-key");
  });
});

describe("normalizeScheduledDate", () => {
  test("a bare date becomes midnight UTC", () => {
    expect(normalizeScheduledDate("2026-06-30")).toBe("2026-06-30 00:00:00");
  });

  test("Z and space-separated datetimes keep their parts (Odoo stores naive UTC)", () => {
    expect(normalizeScheduledDate("2026-06-30T14:05:09Z")).toBe("2026-06-30 14:05:09");
    expect(normalizeScheduledDate("2026-06-30 14:05")).toBe("2026-06-30 14:05:00");
    expect(normalizeScheduledDate("2026-06-30T14:05:09.123Z")).toBe("2026-06-30 14:05:09");
  });

  test("an explicit offset is converted to UTC", () => {
    expect(normalizeScheduledDate("2026-06-30T14:05:09+02:00")).toBe("2026-06-30 12:05:09");
    expect(normalizeScheduledDate("2026-06-30T00:30:00-05:00")).toBe("2026-06-30 05:30:00");
  });

  test("anything that is not a date is refused, not guessed at", () => {
    expect(normalizeScheduledDate("last June")).toBeNull();
    expect(normalizeScheduledDate("30/06/2026")).toBeNull();
    expect(normalizeScheduledDate("")).toBeNull();
  });
});

describe("buildDraftVendorReceiptVals", () => {
  test("omits optional keys entirely rather than sending false/null", () => {
    const vals = buildDraftVendorReceiptVals({
      picking_type_id: 1,
      partner_id: 512,
      location_id: null,
      location_dest_id: 8,
      scheduled_date: "2026-06-30 00:00:00",
      lines: [{ product_id: 77, product_uom_id: 1, quantity: 1 }]
    });

    expect(Object.keys(vals).sort()).toEqual([
      "location_dest_id",
      "move_ids",
      "partner_id",
      "picking_type_id",
      "scheduled_date"
    ]);
  });

  test("line names fall back to the product display name, then to the id", () => {
    const vals = buildDraftVendorReceiptVals({
      picking_type_id: 1,
      partner_id: 512,
      location_id: 4,
      location_dest_id: 8,
      scheduled_date: "2026-06-30 00:00:00",
      lines: [
        { product_id: 77, product_uom_id: 1, quantity: 1, name: "  " },
        { product_id: 78, product_uom_id: 1, quantity: 2, name: "Handwritten line" }
      ],
      productNames: new Map([[77, "Blue Mug"]])
    });

    const moves = vals.move_ids as any[];
    expect(moves[0][2].name).toBe("Blue Mug");
    expect(moves[1][2].name).toBe("Handwritten line");
    expect(buildDraftVendorReceiptVals({
      picking_type_id: 1,
      partner_id: 512,
      location_dest_id: 8,
      scheduled_date: "2026-06-30 00:00:00",
      lines: [{ product_id: 99, product_uom_id: 1, quantity: 1 }]
    }).move_ids as any[]).toEqual([
      [0, 0, { name: "Product 99", product_id: 99, product_uom: 1, product_uom_qty: 1, location_dest_id: 8 }]
    ]);
  });
});
