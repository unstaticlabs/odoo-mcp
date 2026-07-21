import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deriveWorkflowStatus } from "../normalizer";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import {
  logWriteContext,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  requireConnection,
  zWriteContext,
  type WriteBlockedIntent
} from "./shared";

/** Preparatory fields allowed on draft `hr.expense` writes (v1). */
export const DRAFT_EXPENSE_FIELDS = new Set([
  "date",
  "name",
  "description",
  "product_id",
  "account_id",
  "analytic_distribution",
  "quantity",
  "price_unit",
  "total_amount",
  "tax_ids",
  "reference"
]);

/** Header fields allowed on draft vendor-bill (`account.move` in_invoice) writes (v1). */
export const DRAFT_VENDOR_BILL_FIELDS = new Set([
  "partner_id",
  "invoice_date",
  "date",
  "invoice_date_due",
  "ref",
  "fiscal_position_id",
  "narration",
  "payment_reference",
  "invoice_line_ids"
]);

/** Nested create/update dict keys allowed inside `invoice_line_ids` commands. */
export const DRAFT_VENDOR_BILL_LINE_FIELDS = new Set([
  "name",
  "account_id",
  "quantity",
  "price_unit",
  "tax_ids",
  "analytic_distribution",
  "product_id",
  "display_type"
]);

/** Explicit lifecycle / payment keys that must never be written via billing tools. */
const HARD_DENY_FIELDS = new Set([
  "state",
  "approval_state",
  "sheet_id",
  "payment_mode",
  "account_move_id",
  "payment_state",
  "move_type",
  "journal_id"
]);

const LIFECYCLE_OR_PAYMENT_FIELD = /^(payment_|reconcil|action_|button_)/i;

export type AllowlistPartition = {
  allowed: Record<string, unknown>;
  blocked: string[];
};

/** Split `values` into allowlisted entries vs blocked keys (unknown + hard-deny). Exported for unit testing. */
export function partitionAllowlistedValues(
  values: Record<string, unknown>,
  allowlist: ReadonlySet<string>
): AllowlistPartition {
  const allowed: Record<string, unknown> = {};
  const blocked: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    // Explicit hard-deny always wins (even if someone expands the allowlist later).
    // Otherwise allowlist is the gate — lifecycle/payment *patterns* only catch unknown keys
    // (so allowlisted `payment_reference` is not blocked by /^payment_/).
    if (HARD_DENY_FIELDS.has(key) || !allowlist.has(key)) {
      blocked.push(key);
      continue;
    }
    allowed[key] = value;
  }
  return { allowed, blocked: [...new Set(blocked)] };
}

/** Collect blocked nested keys inside Odoo `invoice_line_ids` command tuples. Exported for unit testing. */
export function blockedInvoiceLineFields(commands: unknown): string[] {
  if (!Array.isArray(commands)) return ["invoice_line_ids"];
  const blocked: string[] = [];
  for (const cmd of commands) {
    if (!Array.isArray(cmd) || cmd.length === 0) {
      blocked.push("invoice_line_ids");
      continue;
    }
    const op = cmd[0];
    // Create (0) / update (1) carry a vals dict in the last slot.
    if (op === 0 || op === 1) {
      const vals = cmd[cmd.length - 1];
      if (!vals || typeof vals !== "object" || Array.isArray(vals)) {
        blocked.push("invoice_line_ids");
        continue;
      }
      for (const key of Object.keys(vals as Record<string, unknown>)) {
        if (
          HARD_DENY_FIELDS.has(key) ||
          LIFECYCLE_OR_PAYMENT_FIELD.test(key) ||
          !DRAFT_VENDOR_BILL_LINE_FIELDS.has(key)
        ) {
          blocked.push(`invoice_line_ids.${key}`);
        }
      }
    }
  }
  return [...new Set(blocked)];
}

/** True when the record's state / derived workflow status is draft. Exported for unit testing. */
export function isDraftRecord(record: Record<string, unknown>): boolean {
  const status = deriveWorkflowStatus(record);
  if (status != null) return status === "draft";
  return record.state === "draft";
}

function billingBlocked(
  context: { model: string; method?: string },
  opts: { intent?: WriteBlockedIntent; reason: string; blocked_fields?: string[]; error?: string }
) {
  if (opts.error && opts.error !== "write_blocked") {
    const envelope = {
      error: opts.error,
      intent: opts.intent ?? ("financial_mutation" as const),
      model: context.model,
      method: context.method ?? "write",
      http_status: null,
      details: opts.reason,
      recoverable: false,
      ...(opts.blocked_fields?.length ? { blocked_fields: opts.blocked_fields } : {})
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
  }
  return mcpWriteBlockedError(
    { model: context.model, method: context.method ?? "write" },
    {
      intent: opts.intent ?? "financial_mutation",
      reason: opts.reason,
      blocked_fields: opts.blocked_fields
    }
  );
}

function firstRecord(rows: unknown): Record<string, unknown> | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}

export function registerBillingWriteTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue
) {
  server.registerTool(
    "billing.update_draft_expense",
    {
      title: "Update Draft Expense",
      description:
        "Write: update preparatory fields on a draft hr.expense only. Refuses non-draft records and " +
        "lifecycle/payment fields. Does not validate, post, approve, or delete — leave those to a human.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        record_id: z.number().int().positive(),
        values: z.record(z.string(), z.unknown()),
        context: zWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        record_id: z.number().int(),
        state: z.string(),
        warnings: z.array(z.string()).optional()
      }
    },
    async ({ record_id, values, context }) => {
      const model = "hr.expense";
      logWriteContext("billing.update_draft_expense", model, context);
      try {
        const conn = requireConnection(getProps());
        const rows = await queue.enqueue(conn, model, "read", {
          ids: [record_id],
          fields: ["id", "state"]
        });
        const record = firstRecord(rows);
        if (!record) {
          return billingBlocked(
            { model },
            {
              error: "not_found",
              reason: `hr.expense id ${record_id} was not found.`
            }
          );
        }

        if (!isDraftRecord(record)) {
          const current = deriveWorkflowStatus(record) ?? String(record.state ?? "unknown");
          return billingBlocked(
            { model },
            {
              error: "draft_required",
              intent: "financial_mutation",
              reason:
                `hr.expense ${record_id} is not draft (current state: ${current}). ` +
                "billing.update_draft_expense only updates draft expenses; leave validate/post/approve to a human."
            }
          );
        }

        const { allowed, blocked } = partitionAllowlistedValues(values, DRAFT_EXPENSE_FIELDS);
        if (blocked.length > 0) {
          return billingBlocked(
            { model },
            {
              reason:
                `billing.update_draft_expense refuses non-allowlisted or lifecycle fields: ${blocked.join(", ")}. ` +
                `Allowed: ${[...DRAFT_EXPENSE_FIELDS].join(", ")}.`,
              blocked_fields: blocked
            }
          );
        }
        if (Object.keys(allowed).length === 0) {
          return billingBlocked(
            { model },
            { reason: "values must include at least one allowlisted field." }
          );
        }

        await queue.enqueue(conn, model, "write", { ids: [record_id], vals: allowed });
        const state = deriveWorkflowStatus(record) ?? "draft";
        return mcpStructured({ ok: true, record_id, state });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "write" });
      }
    }
  );

  server.registerTool(
    "billing.configure_draft_vendor_bill",
    {
      title: "Configure Draft Vendor Bill",
      description:
        "Write: update preparatory header/line fields on a draft vendor bill (account.move with " +
        "move_type=in_invoice) only. Refuses posted moves, other move types, and lifecycle/payment fields. " +
        "Does not validate, post, reconcile, send, or delete — leave those to a human.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        record_id: z.number().int().positive(),
        values: z.record(z.string(), z.unknown()),
        context: zWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        record_id: z.number().int(),
        state: z.string(),
        move_type: z.string(),
        warnings: z.array(z.string()).optional()
      }
    },
    async ({ record_id, values, context }) => {
      const model = "account.move";
      logWriteContext("billing.configure_draft_vendor_bill", model, context);
      try {
        const conn = requireConnection(getProps());
        const rows = await queue.enqueue(conn, model, "read", {
          ids: [record_id],
          fields: ["id", "state", "move_type"]
        });
        const record = firstRecord(rows);
        if (!record) {
          return billingBlocked(
            { model },
            {
              error: "not_found",
              reason: `account.move id ${record_id} was not found.`
            }
          );
        }

        if (!isDraftRecord(record)) {
          const current = deriveWorkflowStatus(record) ?? String(record.state ?? "unknown");
          return billingBlocked(
            { model },
            {
              error: "draft_required",
              intent: "financial_mutation",
              reason:
                `account.move ${record_id} is not draft (current state: ${current}). ` +
                "billing.configure_draft_vendor_bill only updates draft vendor bills; leave validate/post to a human."
            }
          );
        }

        const moveType = typeof record.move_type === "string" ? record.move_type : String(record.move_type ?? "");
        if (moveType !== "in_invoice") {
          return billingBlocked(
            { model },
            {
              error: "vendor_bill_required",
              intent: "financial_mutation",
              reason:
                `account.move ${record_id} has move_type=${moveType || "unknown"}; ` +
                "this slice only configures draft vendor bills (move_type=in_invoice)."
            }
          );
        }

        const { allowed, blocked } = partitionAllowlistedValues(values, DRAFT_VENDOR_BILL_FIELDS);
        const lineBlocked =
          allowed.invoice_line_ids !== undefined ? blockedInvoiceLineFields(allowed.invoice_line_ids) : [];
        const allBlocked = [...blocked, ...lineBlocked];
        if (allBlocked.length > 0) {
          return billingBlocked(
            { model },
            {
              reason:
                `billing.configure_draft_vendor_bill refuses non-allowlisted or lifecycle fields: ${allBlocked.join(", ")}. ` +
                `Allowed header: ${[...DRAFT_VENDOR_BILL_FIELDS].join(", ")}. ` +
                `Allowed line keys: ${[...DRAFT_VENDOR_BILL_LINE_FIELDS].join(", ")}.`,
              blocked_fields: allBlocked
            }
          );
        }
        if (Object.keys(allowed).length === 0) {
          return billingBlocked(
            { model },
            { reason: "values must include at least one allowlisted field." }
          );
        }

        await queue.enqueue(conn, model, "write", { ids: [record_id], vals: allowed });
        const state = deriveWorkflowStatus(record) ?? "draft";
        return mcpStructured({ ok: true, record_id, state, move_type: moveType });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "write" });
      }
    }
  );
}
