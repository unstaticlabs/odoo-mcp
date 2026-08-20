/**
 * Inventory domain tools (`inventory.*`) — ODOO2298.
 *
 * One dedicated safe write: create a **draft** vendor receipt (`stock.picking`, incoming) so an
 * accounting agent reconstructing ledger evidence can record what physically arrived without the
 * connector opening generic `stock.picking` / `stock.move` CRUD (still default-denied, see
 * `write.inventory.test.ts`) and without the graduated master-data path
 * (`inventory-master-data.ts`) growing an operational-document hole.
 *
 * The receipt is created and left in draft. There is deliberately **no validate path** here:
 * `button_validate` / `action_validate` move stock and can trigger valuation, so they stay
 * human-only and remain refused on the generic tools by the high-risk method regex in
 * `lifecycle-allowlist.ts`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { buildRecordUrl, toRecordId } from "./record-urls";
import {
  logWriteContext,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  plaintextToHtml,
  requireConnection,
  zRequiredWriteContext,
  zWarnings,
  type WriteBlockedIntent
} from "./shared";

/** `stock.picking.type` fields needed to resolve the operation type and its default locations. */
export const PICKING_TYPE_FIELDS = [
  "id",
  "name",
  "code",
  "default_location_src_id",
  "default_location_dest_id",
  "warehouse_id",
  "company_id"
];

/** Fields re-read off the created picking as evidence that it really is an unvalidated receipt. */
export const RECEIPT_READBACK_FIELDS = [
  "id",
  "state",
  "picking_type_code",
  "name",
  "move_ids",
  "scheduled_date",
  "origin"
];

/**
 * States a freshly created (unvalidated) receipt may legitimately hold. Odoo leaves an ORM-created
 * picking in `draft`; `waiting` / `confirmed` / `assigned` only appear if something on the database
 * auto-confirms it — still pre-validation, so still acceptable evidence.
 */
export const RECEIPT_PRE_VALIDATION_STATES = new Set(["draft", "waiting", "confirmed", "assigned"]);

/** Hard cap on lines per receipt: one picking create, one Worker payload. */
export const RECEIPT_LINE_MAX = 200;

type BlockedContext = { model: string; method?: string };

/**
 * Error envelope for `inventory.*` refusals, mirroring `billingBlocked` / `projectsBlocked`:
 * a custom `error` code gets a hand-built envelope, a plain policy refusal goes through
 * `mcpWriteBlockedError`.
 */
function inventoryBlocked(
  context: BlockedContext,
  opts: { intent?: WriteBlockedIntent; reason: string; blocked_fields?: string[]; error?: string; recoverable?: boolean }
) {
  if (opts.error && opts.error !== "write_blocked") {
    const envelope = {
      error: opts.error,
      intent: opts.intent ?? ("inventory_operation" as const),
      model: context.model,
      method: context.method ?? "create",
      http_status: null,
      details: opts.reason,
      recoverable: opts.recoverable ?? false,
      ...(opts.blocked_fields?.length ? { blocked_fields: opts.blocked_fields } : {})
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
  }
  return mcpWriteBlockedError(
    { model: context.model, method: context.method ?? "create" },
    {
      intent: opts.intent ?? "inventory_operation",
      reason: opts.reason,
      blocked_fields: opts.blocked_fields,
      recoverable: opts.recoverable
    }
  );
}

function firstRecord(rows: unknown): Record<string, unknown> | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}

function scalarOrNull(value: unknown): string | null {
  if (value === false || value == null) return null;
  return typeof value === "string" ? value : String(value);
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z)?$/;
const OFFSET_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?[+-]\d{2}:?\d{2}$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Normalize an ISO date / datetime to the naive-UTC `YYYY-MM-DD HH:MM:SS` string Odoo stores in a
 * Datetime column, or null when the value is not a date at all. Exported for unit testing.
 *
 * A bare date becomes midnight UTC; `Z` is already UTC so its parts are kept verbatim; a numeric
 * offset is converted to UTC (the offset makes the instant unambiguous). A datetime with no zone
 * at all is read as UTC rather than guessed at — the Worker has no caller timezone to apply.
 */
export function normalizeScheduledDate(value: string): string | null {
  const raw = value.trim();
  if (DATE_ONLY_RE.test(raw)) return `${raw} 00:00:00`;

  const naive = NAIVE_DATETIME_RE.exec(raw);
  if (naive) {
    const [, date, hh, mm, ss] = naive;
    return `${date} ${hh}:${mm}:${ss ?? "00"}`;
  }

  if (OFFSET_DATETIME_RE.test(raw)) {
    const parsed = new Date(raw.replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) return null;
    return (
      `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ` +
      `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}:${pad(parsed.getUTCSeconds())}`
    );
  }

  return null;
}

export interface DraftVendorReceiptLine {
  product_id: number;
  product_uom_id: number;
  quantity: number;
  name?: string;
}

export interface DraftVendorReceiptValsInput {
  picking_type_id: number;
  partner_id: number;
  /** Vendor-side source location, read off the operation type; omitted when Odoo should compute it. */
  location_id?: number | null;
  location_dest_id: number;
  scheduled_date: string;
  origin?: string;
  note?: string;
  company_id?: number;
  lines: DraftVendorReceiptLine[];
  /** Per-product fallback description when a line carries no `name` (product display name). */
  productNames?: Map<number, string>;
}

/**
 * Assemble the `stock.picking` create vals for a draft vendor receipt, including its `move_ids`
 * nested creates. Pure — no Odoo calls — so the dry-run preview and the real create are provably
 * the same payload. Exported for unit testing.
 *
 * One picking create with nested moves is the standard Odoo pattern; separate `stock.move` creates
 * would need the picking id first and would leave a half-built document if the second call failed.
 */
export function buildDraftVendorReceiptVals(input: DraftVendorReceiptValsInput): Record<string, unknown> {
  const sourceLocationId = input.location_id ?? null;
  const move_ids = input.lines.map((line) => {
    const name = line.name?.trim() || input.productNames?.get(line.product_id) || `Product ${line.product_id}`;
    return [
      0,
      0,
      {
        name,
        product_id: line.product_id,
        product_uom: line.product_uom_id,
        product_uom_qty: line.quantity,
        ...(sourceLocationId != null ? { location_id: sourceLocationId } : {}),
        location_dest_id: input.location_dest_id
      }
    ];
  });

  return {
    picking_type_id: input.picking_type_id,
    partner_id: input.partner_id,
    ...(sourceLocationId != null ? { location_id: sourceLocationId } : {}),
    location_dest_id: input.location_dest_id,
    scheduled_date: input.scheduled_date,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.company_id != null ? { company_id: input.company_id } : {}),
    move_ids
  };
}

const zReceiptLine = z.object({
  product_id: z.number().int().positive().describe("product.product id being received"),
  product_uom_id: z.number().int().positive().describe("uom.uom id the quantity is expressed in (explicit, never guessed)"),
  quantity: z.number().positive().describe("Received quantity in product_uom_id — the move's demand (product_uom_qty)"),
  name: z.string().min(1).max(500).optional().describe("Line description; defaults to the product's display name")
});

const zCallMetadata = z.object({
  odoo_calls: z.number().int(),
  cache_hits: z.number().int(),
  duration_seconds: z.number()
});

export function registerInventoryTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "inventory.create_draft_vendor_receipt",
    {
      title: "Create Draft Vendor Receipt",
      description:
        "Write: create one **draft** incoming stock.picking (vendor receipt) with its move lines, from a vendor, " +
        "an internal destination location, an evidence/scheduled date and explicit line quantities. Built for " +
        "close-time evidence reconstruction: record what arrived, leave the document unvalidated for a human. " +
        "The receipt is never validated — this tool exposes no button_validate / action_validate path, moves no " +
        "stock, touches no valuation and writes no account.move; those stay human-only and remain blocked on the " +
        "generic tools. Pass dry_run: true to get the exact planned vals plus the resolved operation type and " +
        "source location without any Odoo write. picking_type_id is resolved from code=incoming (optionally " +
        "narrowed by warehouse_id) when omitted. The response carries web_url — report the receipt to the user as " +
        "[receipt name](web_url), never as a bare id. This is not generic stock CRUD: create_record / " +
        "update_record / call_model_method on stock.picking and stock.move stay default-denied.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        partner_id: z.number().int().positive().describe("Vendor res.partner id the goods came from"),
        location_dest_id: z
          .number()
          .int()
          .positive()
          .describe("Destination stock.location id; must be an internal location (usage=internal)"),
        picking_type_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Incoming stock.picking.type id; resolved from code=incoming when omitted"),
        warehouse_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only used to pick the incoming operation type when picking_type_id is omitted"),
        scheduled_date: z
          .string()
          .min(1)
          .describe("Evidence / scheduled date, `YYYY-MM-DD` or ISO datetime (UTC or with an explicit offset)"),
        origin: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Source-document reference (PO number, vendor ref, close ticket) written to `origin`"),
        note: z.string().min(1).max(5000).optional().describe("Free-text evidence note written to the picking's `note`"),
        lines: z
          .array(zReceiptLine)
          .min(1)
          .max(RECEIPT_LINE_MAX)
          .describe("Received lines; at least one, each with a positive quantity"),
        company_id: z.number().int().positive().optional().describe("Company id when the database is multi-company"),
        dry_run: z
          .boolean()
          .default(false)
          .describe("When true, return the planned vals and resolved defaults without creating anything"),
        context: zRequiredWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        dry_run: z.boolean().describe("true when nothing was written — planned_vals shows exactly what a real run would send"),
        picking_type_id: z.number().int().describe("Resolved incoming operation type used for the receipt"),
        move_count: z.number().int().describe("Number of stock.move lines planned or created"),
        scheduled_date: z.string().describe("Normalized naive-UTC scheduled date sent to (or planned for) Odoo"),
        origin: z.string().nullable(),
        planned_vals: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Dry-run only: the exact stock.picking create vals, including nested move_ids commands"),
        picking_id: z.number().int().optional().describe("id of the created stock.picking (absent on a dry run)"),
        state: z.string().optional().describe("Live state re-read after the create — always pre-validation"),
        move_ids: z.array(z.number().int()).optional().describe("ids of the stock.move lines Odoo created"),
        name: z.string().optional().describe("Odoo's reference for the receipt (e.g. WH/IN/00042)"),
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL — report the receipt as [receipt name](web_url)"),
        provenance_warning: z
          .string()
          .optional()
          .describe("Receipt created but posting the provenance stamp to the chatter failed"),
        trace_token: z.string().optional().describe("Provenance token stamped into the receipt's chatter"),
        warnings: zWarnings,
        metadata: zCallMetadata
      }
    },
    async ({
      partner_id,
      location_dest_id,
      picking_type_id,
      warehouse_id,
      scheduled_date,
      origin,
      note,
      lines,
      company_id,
      dry_run = false,
      context
    }) => {
      const model = "stock.picking";
      logWriteContext("inventory.create_draft_vendor_receipt", model, context);

      // Deliberately no assessWriteOperation call here: stock.picking is not action-classified, so
      // the generic classifier would default-deny this tool's own create. That denial is correct for
      // create_record / call_model_method and must stay; this tool enforces the narrower invariants
      // itself (incoming type only, internal destination, draft-only, no validate path) — the same
      // shape as projects.attach_file and billing.attach_source_pdf.

      const before = queue.snapshot();
      const warnings: string[] = [];
      const metadata = () => {
        const { odoo_calls, total_duration_ms } = queue.delta(before);
        return { odoo_calls, cache_hits: 0, duration_seconds: total_duration_ms / 1000 };
      };

      // Local validation first — a malformed date or line never costs an Odoo round-trip.
      const scheduled = normalizeScheduledDate(scheduled_date);
      if (scheduled === null) {
        return inventoryBlocked(
          { model, method: "create" },
          {
            error: "invalid_scheduled_date",
            reason:
              `scheduled_date=${JSON.stringify(scheduled_date)} is not a date. Send \`YYYY-MM-DD\` or an ISO ` +
              "datetime (`YYYY-MM-DDTHH:MM:SSZ`, or with an explicit ±HH:MM offset). No Odoo call was made.",
            recoverable: true
          }
        );
      }
      const badQuantity = lines.find((line) => !(line.quantity > 0) || !Number.isFinite(line.quantity));
      if (badQuantity) {
        return inventoryBlocked(
          { model, method: "create" },
          {
            error: "invalid_line_quantity",
            reason:
              `Line for product ${badQuantity.product_id} has quantity=${badQuantity.quantity}; every received line ` +
              "must carry a positive finite quantity. No Odoo call was made.",
            recoverable: true
          }
        );
      }

      try {
        const conn = requireConnection(getProps());

        // 1. Vendor must exist. Odoo ACLs stay the authz layer — a key that may not read the partner
        //    errors out of Odoo here, which is the intended behaviour.
        const partnerRows = await queue.enqueue(conn, "res.partner", "read", {
          ids: [partner_id],
          fields: ["id", "name"]
        });
        const partner = firstRecord(partnerRows);
        if (!partner) {
          return inventoryBlocked(
            { model: "res.partner", method: "read" },
            { error: "not_found", reason: `res.partner id ${partner_id} was not found.` }
          );
        }

        // 2. Destination must be a real internal location — a receipt into a supplier/customer/view
        //    location is an evidence error, not an inventory movement anyone wants.
        const locationRows = await queue.enqueue(conn, "stock.location", "read", {
          ids: [location_dest_id],
          fields: ["id", "complete_name", "usage", "company_id"]
        });
        const location = firstRecord(locationRows);
        if (!location) {
          return inventoryBlocked(
            { model: "stock.location", method: "read" },
            { error: "not_found", reason: `stock.location id ${location_dest_id} was not found.` }
          );
        }
        const usage = scalarOrNull(location.usage);
        if (usage !== "internal") {
          return inventoryBlocked(
            { model: "stock.location", method: "read" },
            {
              error: "invalid_destination_location",
              reason:
                `stock.location ${location_dest_id} (${scalarOrNull(location.complete_name) ?? "unnamed"}) has ` +
                `usage=${usage ?? "unknown"}; a vendor receipt must land in an internal location (usage=internal). ` +
                "Pick the warehouse stock location or one of its internal children.",
              recoverable: true
            }
          );
        }

        // 3. Operation type: verified when supplied, resolved from code=incoming when not.
        let pickingType: Record<string, unknown>;
        if (picking_type_id != null) {
          const typeRows = await queue.enqueue(conn, "stock.picking.type", "read", {
            ids: [picking_type_id],
            fields: PICKING_TYPE_FIELDS
          });
          const found = firstRecord(typeRows);
          if (!found) {
            return inventoryBlocked(
              { model: "stock.picking.type", method: "read" },
              { error: "not_found", reason: `stock.picking.type id ${picking_type_id} was not found.` }
            );
          }
          const code = scalarOrNull(found.code);
          if (code !== "incoming") {
            return inventoryBlocked(
              { model: "stock.picking.type", method: "read" },
              {
                error: "invalid_picking_type",
                reason:
                  `stock.picking.type ${picking_type_id} has code=${code ?? "unknown"}; this tool only creates ` +
                  "incoming receipts. Omit picking_type_id to let the connector resolve the incoming type.",
                recoverable: true
              }
            );
          }
          pickingType = found;
        } else {
          const domain: unknown[] = [["code", "=", "incoming"]];
          if (warehouse_id != null) domain.push(["warehouse_id", "=", warehouse_id]);
          if (company_id != null) domain.push(["company_id", "=", company_id]);
          const candidates = (await queue.enqueue(conn, "stock.picking.type", "search_read", {
            domain,
            fields: PICKING_TYPE_FIELDS,
            limit: 10,
            order: "sequence, id"
          })) as Record<string, unknown>[];
          const rows = Array.isArray(candidates) ? candidates : [];
          if (rows.length === 0) {
            return inventoryBlocked(
              { model: "stock.picking.type", method: "search_read" },
              {
                error: "picking_type_unresolved",
                reason:
                  "No incoming stock.picking.type is visible" +
                  (warehouse_id != null ? ` for warehouse ${warehouse_id}` : "") +
                  (company_id != null ? ` in company ${company_id}` : "") +
                  ". Pass picking_type_id explicitly, or check the Inventory operation types in Odoo.",
                recoverable: true
              }
            );
          }
          pickingType = rows[0];
          if (rows.length > 1) {
            warnings.push(
              `${rows.length} incoming operation types matched; used ${scalarOrNull(pickingType.name) ?? "the first"} ` +
                `(id ${toRecordId(pickingType.id)}). Pass picking_type_id (or warehouse_id) to choose deliberately.`
            );
          }
        }

        const resolvedPickingTypeId = toRecordId(pickingType.id);
        if (resolvedPickingTypeId == null) {
          return mcpError("Odoo returned a stock.picking.type without a usable id");
        }
        const sourceLocationId = toRecordId(pickingType.default_location_src_id);
        if (sourceLocationId == null) {
          warnings.push(
            `Operation type ${resolvedPickingTypeId} has no default source location; location_id was left out of ` +
              "the vals so Odoo computes the vendor-side location itself."
          );
        }

        // 4. Every line's product must exist; the UoM is the caller's explicit choice, and a UoM that
        //    is not the product's own is legitimate (buying by box, stocking by unit) but worth saying.
        const productIds = [...new Set(lines.map((line) => line.product_id))];
        const productRows = (await queue.enqueue(conn, "product.product", "read", {
          ids: productIds,
          fields: ["id", "display_name", "uom_id"]
        })) as Record<string, unknown>[];
        const products = new Map<number, Record<string, unknown>>();
        for (const row of Array.isArray(productRows) ? productRows : []) {
          const id = toRecordId(row?.id);
          if (id != null) products.set(id, row);
        }
        const missingProducts = productIds.filter((id) => !products.has(id));
        if (missingProducts.length > 0) {
          return inventoryBlocked(
            { model: "product.product", method: "read" },
            {
              error: "not_found",
              reason:
                `product.product id(s) ${missingProducts.join(", ")} were not found (or record rules hide them). ` +
                "No receipt was created."
            }
          );
        }
        const productNames = new Map<number, string>();
        for (const [id, row] of products) {
          productNames.set(id, scalarOrNull(row.display_name) ?? `Product ${id}`);
          const productUomId = toRecordId(row.uom_id);
          const requested = lines.filter((line) => line.product_id === id).map((line) => line.product_uom_id);
          for (const uomId of new Set(requested)) {
            if (productUomId != null && uomId !== productUomId) {
              warnings.push(
                `Line for product ${id} uses uom ${uomId}, not the product's own uom ${productUomId}; Odoo will ` +
                  "refuse the create if the two are not in the same UoM category."
              );
            }
          }
        }

        // 5. One payload, built once — the dry run returns exactly what the real create would send.
        const vals = buildDraftVendorReceiptVals({
          picking_type_id: resolvedPickingTypeId,
          partner_id,
          location_id: sourceLocationId,
          location_dest_id,
          scheduled_date: scheduled,
          origin,
          note,
          company_id,
          lines,
          productNames
        });

        if (dry_run) {
          return mcpStructured({
            ok: true,
            dry_run: true,
            planned_vals: vals,
            picking_type_id: resolvedPickingTypeId,
            move_count: lines.length,
            scheduled_date: scheduled,
            origin: origin ?? null,
            warnings,
            metadata: metadata()
          });
        }

        const created = await queue.enqueue(conn, model, "create", { vals_list: [vals] });
        const picking_id = Array.isArray(created) ? created[0] : created;
        if (typeof picking_id !== "number" || !Number.isInteger(picking_id) || picking_id <= 0) {
          return mcpError("Odoo create returned no stock.picking id");
        }

        // 6. Read-back gate: prove the document is a receipt and is still unvalidated.
        const readBack = firstRecord(
          await queue.enqueue(conn, model, "read", { ids: [picking_id], fields: RECEIPT_READBACK_FIELDS })
        );
        const state = scalarOrNull(readBack?.state);
        if (state !== null && !RECEIPT_PRE_VALIDATION_STATES.has(state)) {
          return inventoryBlocked(
            { model, method: "read" },
            {
              error: "unexpected_state",
              reason:
                `stock.picking ${picking_id} was created but read back in state=${state}, which is not a ` +
                "pre-validation state. This tool never validates or cancels a receipt, so something else on the " +
                "database acted on it — inspect the picking in Odoo before relying on it as evidence."
            }
          );
        }
        const pickingTypeCode = scalarOrNull(readBack?.picking_type_code);
        if (pickingTypeCode !== null && pickingTypeCode !== "incoming") {
          return inventoryBlocked(
            { model, method: "read" },
            {
              error: "unexpected_state",
              reason:
                `stock.picking ${picking_id} was created but read back with picking_type_code=${pickingTypeCode}; ` +
                "it is not a receipt. Inspect the picking in Odoo before relying on it as evidence."
            }
          );
        }
        if (readBack === null) {
          warnings.push(
            `stock.picking ${picking_id} was created but could not be re-read; state and move ids are unconfirmed.`
          );
        }

        const move_ids = Array.isArray(readBack?.move_ids)
          ? (readBack.move_ids as unknown[]).map(toRecordId).filter((id): id is number => id != null)
          : [];
        const receiptName = scalarOrNull(readBack?.name);
        // picking_type_code is read live above, so the link keeps the Receipts route (/odoo/receipts/{id}).
        const webUrl = buildRecordUrl(conn.url, model, picking_id, { picking_type_code: "incoming" });

        const success = {
          ok: true as const,
          dry_run: false as const,
          picking_id,
          picking_type_id: resolvedPickingTypeId,
          move_count: lines.length,
          scheduled_date: scalarOrNull(readBack?.scheduled_date) ?? scheduled,
          origin: scalarOrNull(readBack?.origin) ?? origin ?? null,
          ...(state !== null ? { state } : {}),
          ...(move_ids.length > 0 ? { move_ids } : {}),
          ...(receiptName ? { name: receiptName } : {}),
          ...(webUrl ? { web_url: webUrl } : {})
        };

        // 7. Provenance stamp. A chatter failure must not hide a receipt that already exists, so it
        //    degrades to a warning field rather than an error (same shape as projects.create_task).
        const trace_token = "src-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        const body =
          `[agent-source] inventory.create_draft_vendor_receipt corr=${trace_token} ` +
          `context=${context} origin=${origin ?? "none"} lines=${lines.length} scheduled=${scheduled}`;
        try {
          await queue.enqueue(conn, model, "message_post", {
            ids: [picking_id],
            body: plaintextToHtml(body),
            body_is_html: true,
            message_type: "comment"
          });
          return mcpStructured({ ...success, trace_token, warnings, metadata: metadata() });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return mcpStructured({
            ...success,
            provenance_warning: `created stock.picking ${picking_id} but failed to post the provenance stamp (${message})`,
            warnings,
            metadata: metadata()
          });
        }
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "create" });
      }
    }
  );
}
