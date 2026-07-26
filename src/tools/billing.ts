import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deriveWorkflowStatus } from "../normalizer";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import {
  logWriteContext,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  requireConnection,
  zWarnings,
  zWriteContext,
  type WriteBlockedIntent
} from "./shared";

/** Fields fetched for expense population audit (ids-only taxes — no account.tax round-trip). */
export const EXPENSE_AUDIT_FIELDS = [
  "id",
  "name",
  "state",
  "date",
  "employee_id",
  "product_id",
  "account_id",
  "analytic_distribution",
  "tax_ids",
  "payment_mode",
  "currency_id",
  "total_amount",
  "total_amount_currency",
  "reference",
  "company_id"
] as const;

const EXPENSE_ATTACHMENT_FIELDS = ["id", "name", "mimetype", "file_size", "res_id"] as const;

/** Stable description of the in-page duplicate candidate rule (also returned as `duplicate_heuristic`). */
export const EXPENSE_DUPLICATE_HEURISTIC =
  "Within the returned page, flag a row as duplicate when ≥1 other row shares the same employee_id " +
  "(or both empty), date, total_amount, and product_id (or both empty). Candidate flag for human review, " +
  "not an Odoo uniqueness constraint.";

const zCallMetadata = z.object({
  odoo_calls: z.number().int(),
  cache_hits: z.number().int(),
  duration_seconds: z.number()
});

const zCollapsedM2o = z
  .object({ id: z.number().int(), name: z.string() })
  .nullable()
  .describe("Collapsed many2one, or null when Odoo returned false/empty");

const zAttachmentRef = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  mimetype: z.string().nullable(),
  file_size: z.number().nullable().optional()
});

const zExpenseAuditRow = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  state: z.string().nullable(),
  date: z.string().nullable(),
  employee: zCollapsedM2o,
  product: zCollapsedM2o,
  account: zCollapsedM2o,
  analytic_distribution: z.record(z.string(), z.number()).nullable(),
  taxes: z.array(z.object({ id: z.number().int(), name: z.string().optional() })),
  payment_mode: z.string().nullable(),
  currency: zCollapsedM2o,
  total_amount: z.number().nullable(),
  total_amount_currency: z.number().nullable().optional(),
  reference: z.string().nullable(),
  attachments: z.array(zAttachmentRef),
  duplicate: z.object({
    is_duplicate: z.boolean(),
    reason: z.string().nullable(),
    peer_ids: z.array(z.number().int())
  })
});

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

// ---- Expense population audit (read-only) ----

export type ExpenseAuditFilters = {
  state?: string | string[];
  product_id?: number | number[];
  /** Applied as a post-filter on `analytic_distribution` keys — not part of the Odoo domain. */
  analytic_account_id?: number | number[];
  date_from?: string;
  date_to?: string;
  company_id?: number;
};

function asIdList(value: number | number[] | undefined): number[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asStringList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Build the Odoo domain for expense audit filters.
 * `analytic_account_id` is intentionally omitted — Odoo stores analytics as a JSON map on
 * `analytic_distribution`; rows are post-filtered via {@link expenseMatchesAnalyticAccounts}.
 */
export function buildExpenseAuditDomain(filters: ExpenseAuditFilters): unknown[] {
  const domain: unknown[] = [];

  const states = asStringList(filters.state);
  if (states.length === 1) domain.push(["state", "=", states[0]]);
  else if (states.length > 1) domain.push(["state", "in", states]);

  const products = asIdList(filters.product_id);
  if (products.length === 1) domain.push(["product_id", "=", products[0]]);
  else if (products.length > 1) domain.push(["product_id", "in", products]);

  if (filters.date_from) domain.push(["date", ">=", filters.date_from]);
  if (filters.date_to) domain.push(["date", "<=", filters.date_to]);
  if (filters.company_id !== undefined) domain.push(["company_id", "=", filters.company_id]);

  return domain;
}

/** True when `analytic_distribution` keys intersect the requested analytic account ids. */
export function expenseMatchesAnalyticAccounts(
  distribution: Record<string, number> | null | undefined,
  analyticIds: number[]
): boolean {
  if (analyticIds.length === 0) return true;
  if (!distribution) return false;
  const keys = new Set(Object.keys(distribution));
  return analyticIds.some((id) => keys.has(String(id)));
}

/** Collapse Odoo many2one `[id, name]` / bare id / `false` → `{id,name}` or null. Exported for unit tests. */
export function collapseMany2one(value: unknown): { id: number; name: string } | null {
  if (value === false || value == null) return null;
  if (Array.isArray(value) && typeof value[0] === "number") {
    return { id: value[0], name: typeof value[1] === "string" ? value[1] : String(value[1] ?? "") };
  }
  if (typeof value === "object" && value !== null && "id" in value && typeof (value as { id: unknown }).id === "number") {
    const row = value as { id: number; name?: unknown };
    return { id: row.id, name: typeof row.name === "string" ? row.name : String(row.name ?? "") };
  }
  if (typeof value === "number") return { id: value, name: "" };
  return null;
}

/** Normalize `analytic_distribution` JSON / false → record or null. Exported for unit tests. */
export function normalizeAnalyticDistribution(value: unknown): Record<string, number> | null {
  if (value === false || value == null) return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, pct] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof pct === "number") out[key] = pct;
  }
  return out;
}

/** Normalize `tax_ids` to `{id}` objects (names omitted in v1 to stay within 3 Odoo calls). */
export function normalizeTaxIds(value: unknown): Array<{ id: number; name?: string }> {
  if (value === false || value == null) return [];
  if (!Array.isArray(value)) return [];
  const taxes: Array<{ id: number; name?: string }> = [];
  for (const item of value) {
    if (typeof item === "number") {
      taxes.push({ id: item });
      continue;
    }
    if (Array.isArray(item) && typeof item[0] === "number") {
      taxes.push({
        id: item[0],
        ...(typeof item[1] === "string" ? { name: item[1] } : {})
      });
      continue;
    }
    if (item && typeof item === "object" && typeof (item as { id: unknown }).id === "number") {
      const row = item as { id: number; name?: string };
      taxes.push(row.name !== undefined ? { id: row.id, name: row.name } : { id: row.id });
    }
  }
  return taxes;
}

function scalarOrNull(value: unknown): string | null {
  if (value === false || value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === false || value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Relation id used for duplicate grouping — empty string when both sides are empty. */
function relationGroupKey(value: unknown): string {
  const collapsed = collapseMany2one(value);
  return collapsed ? String(collapsed.id) : "";
}

export type ExpenseDuplicateFlag = {
  is_duplicate: boolean;
  reason: string | null;
  peer_ids: number[];
};

/**
 * Flag duplicate candidates within the returned page using the documented heuristic.
 * Does not call Odoo. Exported for unit tests.
 */
export function flagExpenseDuplicates(
  rows: Array<{
    id: number;
    employee_id?: unknown;
    employee?: { id: number } | null;
    date: unknown;
    total_amount: unknown;
    product_id?: unknown;
    product?: { id: number } | null;
  }>
): Map<number, ExpenseDuplicateFlag> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const employeeKey =
      row.employee !== undefined ? (row.employee ? String(row.employee.id) : "") : relationGroupKey(row.employee_id);
    const productKey =
      row.product !== undefined ? (row.product ? String(row.product.id) : "") : relationGroupKey(row.product_id);
    const amount = numberOrNull(row.total_amount);
    const key = [employeeKey, String(row.date ?? ""), amount === null ? "" : String(amount), productKey].join("\0");
    const list = groups.get(key) ?? [];
    list.push(row.id);
    groups.set(key, list);
  }

  const result = new Map<number, ExpenseDuplicateFlag>();
  for (const row of rows) {
    const employeeKey =
      row.employee !== undefined ? (row.employee ? String(row.employee.id) : "") : relationGroupKey(row.employee_id);
    const productKey =
      row.product !== undefined ? (row.product ? String(row.product.id) : "") : relationGroupKey(row.product_id);
    const amount = numberOrNull(row.total_amount);
    const key = [employeeKey, String(row.date ?? ""), amount === null ? "" : String(amount), productKey].join("\0");
    const peers = (groups.get(key) ?? []).filter((id) => id !== row.id);
    if (peers.length > 0) {
      result.set(row.id, {
        is_duplicate: true,
        reason: "Same employee, date, total_amount, and product as peer row(s) on this page",
        peer_ids: peers
      });
    } else {
      result.set(row.id, { is_duplicate: false, reason: null, peer_ids: [] });
    }
  }
  return result;
}

export function registerBillingReadTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue
) {
  server.registerTool(
    "billing.audit_expenses",
    {
      title: "Audit Expenses",
      description:
        "Read-only: audit an hr.expense population (state/product/analytic/date/company filters) and return " +
        "normalized rows with account, VAT/tax ids, payment_mode, attachment refs, in-page duplicate candidate " +
        "flags, and aggregate totals. Duplicate heuristic: same employee (or both empty), date, total_amount, " +
        "and product (or both empty) within the returned page — for human review, not an Odoo uniqueness " +
        "constraint. analytic_account_id is post-filtered against analytic_distribution keys after search_read. " +
        "Authz is the caller's Odoo permissions (BYO-key / OAuth props). Tax names are omitted in v1 (ids only) " +
        "to stay within ~3 batched Odoo calls. Does not validate, post, approve, or write.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        state: z.union([z.string(), z.array(z.string())]).optional(),
        product_id: z.union([z.number().int().positive(), z.array(z.number().int().positive())]).optional(),
        analytic_account_id: z.union([z.number().int().positive(), z.array(z.number().int().positive())]).optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound on date"),
        date_to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound on date"),
        company_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
        order: z.string().default("date desc, id desc")
      },
      outputSchema: {
        expenses: z.array(zExpenseAuditRow),
        totals: z.object({
          count: z.number().int(),
          matched_count: z.number().int(),
          sum_total_amount: z.number().describe("Sum of total_amount on returned rows (no FX conversion)"),
          duplicate_count: z.number().int()
        }),
        page: z.object({
          limit: z.number().int(),
          offset: z.number().int(),
          has_more: z.boolean(),
          next_offset: z.number().int().nullable()
        }),
        warnings: zWarnings,
        metadata: zCallMetadata,
        duplicate_heuristic: z.string()
      }
    },
    async (input) => {
      const {
        state,
        product_id,
        analytic_account_id,
        date_from,
        date_to,
        company_id,
        limit = 50,
        offset = 0,
        order = "date desc, id desc"
      } = input;

      if (date_from && date_to && date_from > date_to) {
        return mcpError(
          `Inverted date range: date_from (${date_from}) must be ≤ date_to (${date_to}). No Odoo call was made.`
        );
      }

      const before = queue.snapshot();
      const startedAt = Date.now();
      const warnings: string[] = [];
      const model = "hr.expense";

      try {
        const conn = requireConnection(getProps());
        const filters: ExpenseAuditFilters = {
          state,
          product_id,
          analytic_account_id,
          date_from,
          date_to,
          company_id
        };
        const domain = buildExpenseAuditDomain(filters);
        const analyticIds = asIdList(analytic_account_id);
        if (analyticIds.length > 0) {
          warnings.push(
            "analytic_account_id is applied as a post-filter on analytic_distribution keys after search_read " +
              "(no reliable domain operator across Odoo versions); matched_count reflects the pre-filter domain."
          );
        }

        const matchedCountRaw = await queue.enqueue(conn, model, "search_count", { domain });
        const matched_count = typeof matchedCountRaw === "number" ? matchedCountRaw : Number(matchedCountRaw) || 0;

        const rawRows = (await queue.enqueue(conn, model, "search_read", {
          domain,
          fields: [...EXPENSE_AUDIT_FIELDS],
          limit,
          offset,
          order
        })) as Record<string, unknown>[];

        const fetched = Array.isArray(rawRows) ? rawRows : [];
        const has_more = offset + fetched.length < matched_count;
        const next_offset = has_more ? offset + limit : null;

        let filtered = fetched;
        if (analyticIds.length > 0) {
          filtered = fetched.filter((row) =>
            expenseMatchesAnalyticAccounts(normalizeAnalyticDistribution(row.analytic_distribution), analyticIds)
          );
        }

        const expenseIds = filtered
          .map((row) => row.id)
          .filter((id): id is number => typeof id === "number");

        const attachmentsByResId = new Map<
          number,
          Array<{ id: number; name: string | null; mimetype: string | null; file_size?: number | null }>
        >();
        if (expenseIds.length > 0) {
          const attachmentRows = (await queue.enqueue(conn, "ir.attachment", "search_read", {
            domain: [
              ["res_model", "=", "hr.expense"],
              ["res_id", "in", expenseIds],
              ["res_field", "=", false]
            ],
            fields: [...EXPENSE_ATTACHMENT_FIELDS]
          })) as Array<Record<string, unknown>>;

          for (const att of Array.isArray(attachmentRows) ? attachmentRows : []) {
            const resId = typeof att.res_id === "number" ? att.res_id : null;
            const id = typeof att.id === "number" ? att.id : null;
            if (resId == null || id == null) continue;
            const list = attachmentsByResId.get(resId) ?? [];
            list.push({
              id,
              name: scalarOrNull(att.name),
              mimetype: scalarOrNull(att.mimetype),
              file_size: numberOrNull(att.file_size)
            });
            attachmentsByResId.set(resId, list);
          }
        }

        const duplicateFlags = flagExpenseDuplicates(
          filtered.map((row) => ({
            id: row.id as number,
            employee_id: row.employee_id,
            date: row.date,
            total_amount: row.total_amount,
            product_id: row.product_id
          }))
        );

        const currencyIds = new Set<number>();
        let sum_total_amount = 0;
        let duplicate_count = 0;

        const expenses = filtered.map((row) => {
          const id = row.id as number;
          const currency = collapseMany2one(row.currency_id);
          if (currency) currencyIds.add(currency.id);
          const total = numberOrNull(row.total_amount);
          if (total != null) sum_total_amount += total;
          const duplicate = duplicateFlags.get(id) ?? { is_duplicate: false, reason: null, peer_ids: [] };
          if (duplicate.is_duplicate) duplicate_count += 1;

          return {
            id,
            name: scalarOrNull(row.name),
            state: scalarOrNull(row.state),
            date: scalarOrNull(row.date),
            employee: collapseMany2one(row.employee_id),
            product: collapseMany2one(row.product_id),
            account: collapseMany2one(row.account_id),
            analytic_distribution: normalizeAnalyticDistribution(row.analytic_distribution),
            taxes: normalizeTaxIds(row.tax_ids),
            payment_mode: scalarOrNull(row.payment_mode),
            currency,
            total_amount: total,
            total_amount_currency: numberOrNull(row.total_amount_currency),
            reference: scalarOrNull(row.reference),
            attachments: attachmentsByResId.get(id) ?? [],
            duplicate
          };
        });

        if (currencyIds.size > 1) {
          warnings.push(
            `sum_total_amount spans multiple currencies (${[...currencyIds].sort((a, b) => a - b).join(", ")}); ` +
              "amounts were summed without FX conversion."
          );
        }

        const { odoo_calls, total_duration_ms } = queue.delta(before);
        const metadata = {
          odoo_calls,
          cache_hits: 0,
          duration_seconds: total_duration_ms / 1000
        };

        return mcpStructured({
          expenses,
          totals: {
            count: expenses.length,
            matched_count,
            sum_total_amount,
            duplicate_count
          },
          page: { limit, offset, has_more, next_offset },
          warnings,
          metadata,
          duplicate_heuristic: EXPENSE_DUPLICATE_HEURISTIC
        });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
    }
  );
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
