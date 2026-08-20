import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deriveWorkflowStatus } from "../normalizer";
import type { OdooConnection } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { getReversibleLifecycleRule } from "../lifecycle-allowlist";
import { runLifecycleAction } from "../lifecycle-gate";
import {
  PdfPagesError,
  base64ToBytes,
  bytesToBase64,
  countPdfPages,
  extractPdfPages,
  looksLikePdf
} from "../pdf-pages";
import {
  DOCUMENT_SEARCH_FIELDS,
  documentsPreconditionError,
  isDocumentsUnavailableError,
  normalizeSourceDocument,
  zSourceDocument
} from "./bookkeeping";
import { buildRecordUrl, toRecordId } from "./record-urls";
import {
  logWriteContext,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  plaintextToHtml,
  redactDetails,
  requireConnection,
  zRequiredWriteContext,
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
  web_url: z.string().optional().describe("Canonical clickable Odoo URL — cite the expense as [name](web_url)"),
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
  "currency_id",
  "narration",
  "payment_reference",
  // Native Reviewed / To Review queue status. Not a lifecycle field: it does not post,
  // validate, reconcile, pay, or change amounts.
  "review_state",
  "invoice_line_ids"
]);

/** Odoo's native `account.move.review_state` selection used for the Reviewed / To Review queue. */
export const VENDOR_BILL_REVIEW_STATES = new Set(["todo", "reviewed"]);

/**
 * Return the offending value when `values.review_state` is present but not a supported selection key.
 * Fails closed locally so the agent gets a clear, recoverable error instead of an Odoo traceback
 * (or, worse, a write that silently no-ops). Exported for unit testing.
 */
export function invalidReviewState(values: Record<string, unknown>): string | null {
  if (!("review_state" in values)) return null;
  const raw = values.review_state;
  if (typeof raw === "string" && VENDOR_BILL_REVIEW_STATES.has(raw)) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
}

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

/**
 * Default byte cap for `billing.attach_source_pdf`, matching `bookkeeping.fetch_attachment`:
 * base64 inflates a payload ~1.37x, so this is the size we are willing to hold in Worker memory.
 */
export const SOURCE_PDF_MAX_BYTES = 10485760;

const ATTACHMENT_NAME_MAX = 255;

/** Source metadata read before any byte fetch by `billing.copy_or_relink_source_attachment`. */
export const COPY_SOURCE_ATTACHMENT_FIELDS = [
  "id",
  "name",
  "mimetype",
  "file_size",
  "type",
  "url",
  "checksum",
  "res_model",
  "res_id"
];

/** Fields re-read off the newly created copy — the evidence that the bytes really landed. */
const COPIED_ATTACHMENT_FIELDS = ["id", "name", "mimetype", "file_size", "checksum"];

/** Fallback mimetype when the source attachment declares none. */
const DEFAULT_COPY_MIMETYPE = "application/octet-stream";

/**
 * Default file name for the attachment `billing.attach_source_pdf` creates: the source's own
 * name, minus its `.pdf` extension, plus a suffix recording what was taken from it. Odoo allows
 * duplicate attachment names, so this is provenance for humans, not a uniqueness key.
 * Exported for unit testing.
 */
export function deriveSourcePdfName(
  sourceName: unknown,
  sourceAttachmentId: number,
  range: { page_from: number; page_to: number } | null
): string {
  const raw = typeof sourceName === "string" ? sourceName.trim() : "";
  const stem = raw.replace(/\.pdf$/i, "").trim() || `attachment-${sourceAttachmentId}`;
  const suffix = range ? `-p${range.page_from}-${range.page_to}.pdf` : "-copy.pdf";
  return `${stem.slice(0, ATTACHMENT_NAME_MAX - suffix.length)}${suffix}`;
}

function billingBlocked(
  context: { model: string; method?: string },
  opts: {
    intent?: WriteBlockedIntent;
    reason: string;
    blocked_fields?: string[];
    error?: string;
    recoverable?: boolean;
  }
) {
  if (opts.error && opts.error !== "write_blocked") {
    const envelope = {
      error: opts.error,
      intent: opts.intent ?? ("financial_mutation" as const),
      model: context.model,
      method: context.method ?? "write",
      http_status: null,
      details: opts.reason,
      recoverable: opts.recoverable ?? false,
      ...(opts.blocked_fields?.length ? { blocked_fields: opts.blocked_fields } : {})
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
  }
  return mcpWriteBlockedError(
    { model: context.model, method: context.method ?? "write" },
    {
      intent: opts.intent ?? "financial_mutation",
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
          const webUrl = buildRecordUrl(conn.url, model, id, row);

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
            ...(webUrl ? { web_url: webUrl } : {}),
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
  const draftExpenseFieldList = [...DRAFT_EXPENSE_FIELDS].join(", ");
  const draftExpenseValuesDescribe =
    `Allowlisted preparatory keys only: ${draftExpenseFieldList}. ` +
    "Use total_amount for monetary corrections; total_amount_currency is audit/read-only and not writable.";

  server.registerTool(
    "billing.update_draft_expense",
    {
      title: "Update Draft Expense",
      description:
        "Write: update preparatory fields on a draft hr.expense only. Allowlisted fields: " +
        `${draftExpenseFieldList}. Use total_amount for monetary corrections; total_amount_currency is ` +
        "not writable (audit/read-only). Refuses non-draft records and lifecycle/payment fields. " +
        "Does not validate, post, or delete. For reset→edit→resubmit/reapprove hygiene use " +
        "call_model_method on allowlisted methods (action_reset / action_submit / action_approve) " +
        "with write context and a compatible record state (see list_model_actions executable:true).",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        record_id: z.number().int().positive(),
        values: z.record(z.string(), z.unknown()).describe(draftExpenseValuesDescribe),
        context: zWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        record_id: z.number().int(),
        state: z.string(),
        web_url: z.string().optional().describe("Canonical clickable Odoo URL — confirm the write as [record name](web_url)"),
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
                "billing.update_draft_expense only updates draft expenses. " +
                "If the expense is submitted/approved, call_model_method action_reset (with write context) first, then retry; " +
                "post/pay remain blocked on generic MCP tools."
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
        const webUrl = buildRecordUrl(conn.url, model, record_id, record);
        return mcpStructured({ ok: true, record_id, state, ...(webUrl ? { web_url: webUrl } : {}) });
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
        "Write: update preparatory header/line fields (including currency_id) on a draft vendor bill " +
        "(account.move with move_type=in_invoice) only. Includes `review_state` (`todo` / `reviewed`) to maintain " +
        "Odoo's native Reviewed / To Review queue — a status flip only; it does not validate, post, reconcile, send, pay, or delete. " +
        "Refuses posted moves, other move types, and lifecycle/payment fields. " +
        "Does not validate, post, reconcile, send, or delete. To reset a posted/cancel vendor bill to draft, " +
        "use call_model_method button_draft with write context (in_invoice / in_refund only; see list_model_actions).",
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
        web_url: z.string().optional().describe("Canonical clickable Odoo URL — confirm the write as [record name](web_url)"),
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
                "billing.configure_draft_vendor_bill only updates draft vendor bills. " +
                "If the bill is posted/cancel, call_model_method button_draft (vendor bills only, with write context) first; " +
                "post/reconcile remain blocked on generic MCP tools."
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
        const badReviewState = invalidReviewState(allowed);
        if (badReviewState !== null) {
          return billingBlocked(
            { model },
            {
              error: "invalid_review_state",
              reason:
                `review_state=${badReviewState} is not a supported value. ` +
                `Allowed: ${[...VENDOR_BILL_REVIEW_STATES].join(", ")} (Odoo's Reviewed / To Review queue).`,
              recoverable: true
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
        // moveType is read live above, so the bill links to Vendor Bills rather than Journal Entries.
        const webUrl = buildRecordUrl(conn.url, model, record_id, { ...record, move_type: moveType });
        return mcpStructured({
          ok: true,
          record_id,
          state,
          move_type: moveType,
          ...(webUrl ? { web_url: webUrl } : {})
        });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "write" });
      }
    }
  );

  server.registerTool(
    "billing.attach_source_pdf",
    {
      title: "Attach Source PDF To Draft Vendor Bill",
      description:
        "Write: copy — or extract a page range out of — an existing PDF ir.attachment and link the result to a " +
        "draft vendor bill (account.move with move_type=in_invoice, state=draft) as a new attachment. Built for " +
        "composite source documents (one supplier PDF holding several vendors' invoices): page-split it per bill " +
        "without leaving the connector. Omit page_from/page_to to copy the whole PDF. The source attachment is " +
        "never modified or deleted, the move is never written, and nothing is validated, posted or reconciled. " +
        "This is not generic ir.attachment CRUD: it only ever creates a PDF attachment on a draft vendor bill.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        bill_id: z.number().int().positive().describe("Draft account.move (move_type=in_invoice) to attach to"),
        source_attachment_id: z.number().int().positive().describe("Existing binary PDF ir.attachment to read"),
        page_from: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based inclusive first page; set together with page_to to extract a range"),
        page_to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based inclusive last page; must be ≥ page_from. Omit both to copy the whole PDF"),
        max_bytes: z
          .number()
          .int()
          .positive()
          .default(SOURCE_PDF_MAX_BYTES)
          .describe("Refuse sources (and outputs) larger than this, before decoding into Worker memory"),
        name: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("File name for the new attachment; defaults to the source name plus a page suffix"),
        context: zRequiredWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        attachment_id: z.number().int().describe("id of the newly created ir.attachment"),
        bill_id: z.number().int(),
        res_model: z.literal("account.move"),
        res_id: z.number().int(),
        name: z.string(),
        mimetype: z.literal("application/pdf"),
        mode: z.enum(["page_extract", "full_copy"]),
        page_from: z.number().int().nullable(),
        page_to: z.number().int().nullable(),
        source_attachment_id: z.number().int(),
        source_page_count: z
          .number()
          .int()
          .nullable()
          .describe("Pages in the source PDF; null when a full copy was made from bytes that would not parse")
      }
    },
    async ({ bill_id, source_attachment_id, page_from, page_to, max_bytes = SOURCE_PDF_MAX_BYTES, name, context }) => {
      const model = "ir.attachment";
      const billModel = "account.move";
      logWriteContext("billing.attach_source_pdf", model, context);

      // Page args are self-contained — check them before spending an Odoo round-trip.
      if ((page_from === undefined) !== (page_to === undefined)) {
        return billingBlocked(
          { model, method: "create" },
          {
            error: "invalid_page_range",
            reason:
              "page_from and page_to must be supplied together (omit both to copy the whole PDF). " +
              "No Odoo call was made."
          }
        );
      }
      if (page_from !== undefined && page_to !== undefined && page_from > page_to) {
        return billingBlocked(
          { model, method: "create" },
          {
            error: "invalid_page_range",
            reason: `Inverted page range: page_from (${page_from}) must be ≤ page_to (${page_to}). No Odoo call was made.`
          }
        );
      }
      const range = page_from !== undefined && page_to !== undefined ? { page_from, page_to } : null;

      try {
        const conn = requireConnection(getProps());

        // 1. The bill must be a draft vendor bill — same gate as billing.configure_draft_vendor_bill.
        const billRows = await queue.enqueue(conn, billModel, "read", {
          ids: [bill_id],
          fields: ["id", "state", "move_type"]
        });
        const bill = firstRecord(billRows);
        if (!bill) {
          return billingBlocked(
            { model: billModel, method: "read" },
            { error: "not_found", reason: `account.move id ${bill_id} was not found.` }
          );
        }
        if (!isDraftRecord(bill)) {
          const current = deriveWorkflowStatus(bill) ?? String(bill.state ?? "unknown");
          return billingBlocked(
            { model: billModel, method: "read" },
            {
              error: "draft_required",
              reason:
                `account.move ${bill_id} is not draft (current state: ${current}). ` +
                "billing.attach_source_pdf only attaches to draft vendor bills. " +
                "If the bill is posted/cancel, call_model_method button_draft (vendor bills only, with write context) first; " +
                "post/reconcile remain blocked on generic MCP tools."
            }
          );
        }
        const moveType = typeof bill.move_type === "string" ? bill.move_type : String(bill.move_type ?? "");
        if (moveType !== "in_invoice") {
          return billingBlocked(
            { model: billModel, method: "read" },
            {
              error: "vendor_bill_required",
              reason:
                `account.move ${bill_id} has move_type=${moveType || "unknown"}; ` +
                "this slice only attaches source PDFs to draft vendor bills (move_type=in_invoice)."
            }
          );
        }

        // 2. Source metadata first, so an oversize or contentless attachment is refused before the fetch.
        const metaRows = await queue.enqueue(conn, model, "read", {
          ids: [source_attachment_id],
          fields: ["id", "name", "mimetype", "file_size", "type", "url"]
        });
        const meta = firstRecord(metaRows);
        if (!meta) {
          return billingBlocked(
            { model, method: "read" },
            { error: "not_found", reason: `ir.attachment id ${source_attachment_id} was not found.` }
          );
        }
        if (meta.type === "url") {
          return billingBlocked(
            { model, method: "create" },
            {
              error: "url_attachment",
              reason:
                `ir.attachment ${source_attachment_id} is a URL attachment (type=url), so it stores no bytes ` +
                "to copy or page-extract. Upload the PDF to Odoo as a stored attachment first."
            }
          );
        }
        const fileSize = numberOrNull(meta.file_size);
        if (fileSize !== null && fileSize > max_bytes) {
          return billingBlocked(
            { model, method: "read" },
            {
              error: "oversize",
              reason:
                `ir.attachment ${source_attachment_id} is ${fileSize} bytes, exceeding max_bytes (${max_bytes}). ` +
                "Base64 encoding inflates the payload ~1.37x against Worker memory limits, so it was not fetched. " +
                "Raise max_bytes if you really need this file."
            }
          );
        }

        const dataRows = await queue.enqueue(conn, model, "read", {
          ids: [source_attachment_id],
          fields: ["datas"]
        });
        const datas = firstRecord(dataRows)?.datas;
        if (typeof datas !== "string" || datas.length === 0) {
          return billingBlocked(
            { model, method: "read" },
            {
              error: "pdf_error",
              reason: `ir.attachment ${source_attachment_id} returned no stored content (datas is empty); there is nothing to copy.`
            }
          );
        }

        // 3. Decode and slice in-Worker. PdfPagesError carries the envelope code to surface.
        let outputBytes: Uint8Array;
        let sourcePageCount: number | null;
        try {
          const sourceBytes = base64ToBytes(datas);
          if (sourceBytes.length > max_bytes) {
            return billingBlocked(
              { model, method: "read" },
              {
                error: "oversize",
                reason:
                  `ir.attachment ${source_attachment_id} decodes to ${sourceBytes.length} bytes, exceeding ` +
                  `max_bytes (${max_bytes}). Raise max_bytes if you really need this file.`
              }
            );
          }
          // The stored mimetype is whatever the uploader's browser guessed; the header decides.
          if (!looksLikePdf(sourceBytes)) {
            return billingBlocked(
              { model, method: "create" },
              {
                error: "not_pdf",
                reason:
                  `ir.attachment ${source_attachment_id} (mimetype=${scalarOrNull(meta.mimetype) ?? "unset"}) has no ` +
                  "%PDF header. billing.attach_source_pdf only copies or page-extracts PDFs."
              }
            );
          }

          if (range) {
            const extracted = await extractPdfPages(sourceBytes, range.page_from, range.page_to);
            outputBytes = extracted.bytes;
            sourcePageCount = extracted.sourcePageCount;
          } else {
            // Byte-for-byte copy — parse only to report the page count, and tolerate a parse
            // failure (e.g. an encrypted PDF) rather than refuse a copy we can already make.
            outputBytes = sourceBytes;
            sourcePageCount = await countPdfPages(sourceBytes).catch(() => null);
          }
        } catch (err) {
          if (err instanceof PdfPagesError) {
            return billingBlocked(
              { model, method: "create" },
              {
                error: err.code,
                reason:
                  redactDetails(err.message) +
                  (err.pageCount !== null ? ` The source PDF has ${err.pageCount} page(s).` : "")
              }
            );
          }
          throw err;
        }

        if (outputBytes.length > max_bytes) {
          return billingBlocked(
            { model, method: "create" },
            {
              error: "oversize",
              reason:
                `The PDF produced for pages ${range?.page_from}-${range?.page_to} is ${outputBytes.length} bytes, ` +
                `exceeding max_bytes (${max_bytes}). Raise max_bytes or extract a narrower range.`
            }
          );
        }

        // 4. Link the result. Odoo may auto-adopt it as message_main_attachment_id; we never write the move.
        const attachmentName = name ?? deriveSourcePdfName(meta.name, source_attachment_id, range);
        const created = await queue.enqueue(conn, model, "create", {
          vals_list: [
            {
              name: attachmentName,
              type: "binary",
              mimetype: "application/pdf",
              datas: bytesToBase64(outputBytes),
              res_model: billModel,
              res_id: bill_id
            }
          ]
        });
        const attachment_id = Array.isArray(created) ? created[0] : created;
        if (typeof attachment_id !== "number" || !Number.isInteger(attachment_id) || attachment_id <= 0) {
          return mcpError("Odoo create returned no ir.attachment id");
        }

        return mcpStructured({
          ok: true,
          attachment_id,
          bill_id,
          res_model: "account.move" as const,
          res_id: bill_id,
          name: attachmentName,
          mimetype: "application/pdf" as const,
          mode: range ? ("page_extract" as const) : ("full_copy" as const),
          page_from: range?.page_from ?? null,
          page_to: range?.page_to ?? null,
          source_attachment_id,
          source_page_count: sourcePageCount
        });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "create" });
      }
    }
  );

  server.registerTool(
    "billing.copy_or_relink_source_attachment",
    {
      title: "Copy Or Relink Source Attachment To Draft Vendor Bill",
      description:
        "Write: put an existing piece of evidence — any binary ir.attachment, or the attachment behind a " +
        "documents.document — onto a canonical draft vendor bill (account.move, move_type=in_invoice, state=draft). " +
        "Built for de-duplication: when a zero-value duplicate shell bill is about to be deleted, its source file " +
        "must first be moved onto the bill that survives. Two modes: `copy` (default, non-destructive) creates a " +
        "NEW ir.attachment holding the same bytes on the target bill and leaves the source untouched, so the " +
        "duplicate can then be deleted safely; `relink` (destructive to the previous filing) repoints the " +
        "documents.document res_model/res_id at the target without duplicating bytes, and requires " +
        "source_document_id plus the Documents app. Supply exactly one of source_attachment_id / " +
        "source_document_id. The bill itself is never written, and nothing is validated, posted or reconciled. " +
        "Pick the right tool: fresh page-split bytes out of a composite supplier PDF → billing.attach_source_pdf; " +
        "plain Documents filing with no bill involved → bookkeeping.link_source_document; agent-generated bytes on " +
        "a task → projects.attach_file. This is not generic ir.attachment CRUD.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        source_attachment_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("ir.attachment id holding the evidence (e.g. one orphaned by a deleted duplicate bill)"),
        source_document_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("documents.document id; its attachment_id supplies the bytes. Required for mode=relink"),
        target_model: z
          .enum(["account.move"])
          .default("account.move")
          .describe("Always account.move — v1 targets draft vendor bills only"),
        target_id: z.number().int().positive().describe("Canonical draft vendor bill (account.move, in_invoice) id"),
        mode: z
          .enum(["copy", "relink"])
          .default("copy")
          .describe("copy = new ir.attachment with the same bytes (non-destructive); relink = move the Documents filing"),
        name: z
          .string()
          .min(1)
          .max(ATTACHMENT_NAME_MAX)
          .optional()
          .describe("File name override for the copy; defaults to preserving the source name"),
        max_bytes: z
          .number()
          .int()
          .positive()
          .default(SOURCE_PDF_MAX_BYTES)
          .describe("Refuse sources larger than this, before decoding into Worker memory (copy mode)"),
        context: zRequiredWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        mode: z.enum(["copy", "relink"]),
        target_id: z.number().int(),
        target_web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the bill — cite it as [bill reference](target_web_url)"),
        source_attachment_id: z.number().int().optional().describe("ir.attachment the bytes were read from (copy mode)"),
        source_document_id: z.number().int().optional().describe("documents.document the source was resolved through"),
        attachment_id: z.number().int().optional().describe("copy mode: id of the newly created ir.attachment"),
        name: z.string().optional().describe("copy mode: file name of the new attachment"),
        mimetype: z.string().optional(),
        file_size: z.number().int().optional().describe("copy mode: stored byte length of the new attachment"),
        checksum: z.string().nullable().optional().describe("copy mode: Odoo's sha1 of the stored copy"),
        attachment_web_url: z.string().optional().describe("copy mode: clickable URL of the new attachment record"),
        changed: z
          .boolean()
          .optional()
          .describe("relink mode: false when the document already pointed at this bill and no write was issued"),
        document: zSourceDocument
          .optional()
          .describe("relink mode: the re-read documents.document row (tags are reported by id, not name)"),
        previous_link: z
          .object({ res_model: z.string().nullable(), res_id: z.number().int().nullable() })
          .optional()
          .describe("relink mode: the document's related-record fields before this call"),
        document_web_url: z.string().optional(),
        trace_token: z.string().optional().describe("Provenance token stamped into the bill's chatter"),
        provenance_warning: z
          .string()
          .optional()
          .describe("The write succeeded but stamping the bill's chatter failed"),
        warnings: zWarnings,
        metadata: zCallMetadata
      }
    },
    async ({
      source_attachment_id,
      source_document_id,
      target_model,
      target_id,
      mode = "copy",
      name,
      max_bytes = SOURCE_PDF_MAX_BYTES,
      context
    }) => {
      const model = "ir.attachment";
      const billModel = "account.move";
      logWriteContext("billing.copy_or_relink_source_attachment", model, context);

      // Deliberately no assessWriteOperation call: ir.attachment / documents.document creates and
      // writes are default-denied by the generic classifier, which is correct for create_record and
      // must stay. This tool enforces the narrower invariants itself (one draft in_invoice target,
      // one source, size cap, no byte mutation of the source) — same shape as billing.attach_source_pdf.

      const before = queue.snapshot();
      const warnings: string[] = [];
      const metadata = () => {
        const { odoo_calls, total_duration_ms } = queue.delta(before);
        return { odoo_calls, cache_hits: 0, duration_seconds: total_duration_ms / 1000 };
      };

      // Source selection is self-contained — settle it before spending an Odoo round-trip.
      if ((source_attachment_id === undefined) === (source_document_id === undefined)) {
        return billingBlocked(
          { model, method: "create" },
          {
            error: "invalid_source",
            reason:
              "Supply exactly one of source_attachment_id or source_document_id: the first reads bytes straight " +
              "off an ir.attachment, the second resolves them through a documents.document. No Odoo call was made.",
            recoverable: true
          }
        );
      }
      if (mode === "relink" && source_document_id === undefined) {
        return billingBlocked(
          { model: "documents.document", method: "write" },
          {
            error: "relink_requires_document",
            reason:
              "mode=relink moves a documents.document's filing, so it needs source_document_id. A bare " +
              "ir.attachment has no Documents row to repoint — use mode=copy to duplicate its bytes onto the bill " +
              "instead. No Odoo call was made.",
            recoverable: true
          }
        );
      }

      try {
        const conn = requireConnection(getProps());

        // 1. Resolve the source. The Documents read doubles as the app-availability probe.
        let documentRow: Record<string, unknown> | null = null;
        let attachmentId = source_attachment_id ?? null;
        if (source_document_id !== undefined) {
          let docRows: unknown;
          try {
            docRows = await queue.enqueue(conn, "documents.document", "read", {
              ids: [source_document_id],
              fields: DOCUMENT_SEARCH_FIELDS
            });
          } catch (err) {
            if (isDocumentsUnavailableError(err)) return documentsPreconditionError(err);
            throw err;
          }
          documentRow = firstRecord(docRows);
          if (!documentRow) {
            return billingBlocked(
              { model: "documents.document", method: "read" },
              {
                error: "not_found",
                reason: `documents.document id ${source_document_id} was not found (or record rules hide it).`
              }
            );
          }
          attachmentId = toRecordId(documentRow.attachment_id);
        }

        if (mode === "copy") {
          if (attachmentId == null) {
            return billingBlocked(
              { model: "documents.document", method: "read" },
              {
                error: "no_source_attachment",
                reason:
                  `documents.document ${source_document_id} carries no attachment_id, so it holds no bytes to copy. ` +
                  "Check the document in Odoo, or pass source_attachment_id directly."
              }
            );
          }

          // 2. Source metadata first, so a URL-only or oversize attachment is refused before the fetch.
          const metaRows = await queue.enqueue(conn, model, "read", {
            ids: [attachmentId],
            fields: COPY_SOURCE_ATTACHMENT_FIELDS
          });
          const meta = firstRecord(metaRows);
          if (!meta) {
            return billingBlocked(
              { model, method: "read" },
              { error: "not_found", reason: `ir.attachment id ${attachmentId} was not found.` }
            );
          }
          if (meta.type === "url") {
            return billingBlocked(
              { model, method: "create" },
              {
                error: "url_attachment",
                reason:
                  `ir.attachment ${attachmentId} is a URL attachment (type=url), so it stores no bytes to copy. ` +
                  "Upload the file to Odoo as a stored attachment first, or use mode=relink to move its Documents filing."
              }
            );
          }
          const fileSize = numberOrNull(meta.file_size);
          if (fileSize !== null && fileSize > max_bytes) {
            return billingBlocked(
              { model, method: "read" },
              {
                error: "oversize",
                reason:
                  `ir.attachment ${attachmentId} is ${fileSize} bytes, exceeding max_bytes (${max_bytes}). ` +
                  "Base64 encoding inflates the payload ~1.37x against Worker memory limits, so it was not fetched. " +
                  "Raise max_bytes if you really need this file."
              }
            );
          }

          // 3. Target gate — identical to billing.attach_source_pdf: draft vendor bills only.
          const bill = await readDraftVendorBill(queue, conn, billModel, target_id);
          if ("blocked" in bill) return bill.blocked;

          // 4. Fetch and re-measure: file_size is Odoo metadata and can understate the real payload.
          const dataRows = await queue.enqueue(conn, model, "read", { ids: [attachmentId], fields: ["datas"] });
          const datas = firstRecord(dataRows)?.datas;
          if (typeof datas !== "string" || datas.length === 0) {
            return billingBlocked(
              { model, method: "read" },
              {
                error: "empty_source",
                reason: `ir.attachment ${attachmentId} returned no stored content (datas is empty); there is nothing to copy.`
              }
            );
          }
          const compact = datas.replace(/\s+/g, "");
          let decodedLength: number;
          try {
            decodedLength = base64ToBytes(compact).length;
          } catch (err) {
            if (err instanceof PdfPagesError) {
              return billingBlocked(
                { model, method: "read" },
                {
                  error: "invalid_base64",
                  reason: `ir.attachment ${attachmentId} returned content that is not valid base64, so it could not be copied.`
                }
              );
            }
            throw err;
          }
          if (decodedLength > max_bytes) {
            return billingBlocked(
              { model, method: "create" },
              {
                error: "oversize",
                reason:
                  `ir.attachment ${attachmentId} decodes to ${decodedLength} bytes, exceeding max_bytes ` +
                  `(${max_bytes}). Raise max_bytes if you really need this file.`
              }
            );
          }

          // 5. Create the copy. The source is never modified; the bill is never written.
          const copyName = name ?? scalarOrNull(meta.name) ?? `attachment-${attachmentId}`;
          const copyMimetype = scalarOrNull(meta.mimetype) ?? DEFAULT_COPY_MIMETYPE;
          const created = await queue.enqueue(conn, model, "create", {
            vals_list: [
              {
                name: copyName,
                type: "binary",
                mimetype: copyMimetype,
                // The source's own base64, not a re-encode — the copy is byte-identical by construction.
                datas: compact,
                res_model: billModel,
                res_id: target_id
              }
            ]
          });
          const attachment_id = Array.isArray(created) ? created[0] : created;
          if (typeof attachment_id !== "number" || !Number.isInteger(attachment_id) || attachment_id <= 0) {
            return mcpError("Odoo create returned no ir.attachment id");
          }

          // 6. Read back checksum/size — re-readable proof the copy matches the source.
          const copyRow = firstRecord(
            await queue.enqueue(conn, model, "read", { ids: [attachment_id], fields: COPIED_ATTACHMENT_FIELDS })
          );
          const checksum = scalarOrNull(copyRow?.checksum);
          const sourceChecksum = scalarOrNull(meta.checksum);
          if (checksum !== null && sourceChecksum !== null && checksum !== sourceChecksum) {
            warnings.push(
              `Copied attachment ${attachment_id} reports checksum ${checksum}, which differs from the source's ` +
                `${sourceChecksum}; compare the two files in Odoo before deleting the original.`
            );
          }
          const sourceResModel = scalarOrNull(meta.res_model);
          const sourceResId = numberOrNull(meta.res_id);
          if (sourceResModel === billModel && sourceResId !== null && sourceResId !== target_id) {
            warnings.push(
              `The source was still filed against ${sourceResModel},${sourceResId}; the copy on bill ${target_id} ` +
                "is independent, so deleting that record now leaves this evidence intact."
            );
          }

          const target_web_url = buildRecordUrl(conn.url, billModel, target_id, bill.record);
          const attachment_web_url = buildRecordUrl(conn.url, model, attachment_id);
          const success = {
            ok: true as const,
            mode: "copy" as const,
            target_id,
            attachment_id,
            source_attachment_id: attachmentId,
            ...(source_document_id !== undefined ? { source_document_id } : {}),
            name: scalarOrNull(copyRow?.name) ?? copyName,
            mimetype: scalarOrNull(copyRow?.mimetype) ?? copyMimetype,
            file_size: numberOrNull(copyRow?.file_size) ?? decodedLength,
            checksum,
            ...(target_web_url ? { target_web_url } : {}),
            ...(attachment_web_url ? { attachment_web_url } : {})
          };

          const provenance = await postAttachmentProvenance(queue, conn, billModel, target_id, [
            "mode=copy",
            `source_attachment=${attachmentId}`,
            `source_document=${source_document_id ?? "none"}`,
            `new_attachment=${attachment_id}`,
            `checksum=${checksum ?? "unreported"}`,
            `name=${success.name}`,
            `context=${context}`
          ]);
          return mcpStructured({ ...success, ...provenance, warnings, metadata: metadata() });
        }

        // ---- mode: relink (destructive to the document's previous filing) ----
        const document = documentRow as Record<string, unknown>;
        const bill = await readDraftVendorBill(queue, conn, billModel, target_id);
        if ("blocked" in bill) return bill.blocked;

        const previous_link = {
          res_model: scalarOrNull(document.res_model),
          res_id: numberOrNull(document.res_id)
        };
        let changed = false;
        if (previous_link.res_model === billModel && previous_link.res_id === target_id) {
          warnings.push(
            `documents.document ${source_document_id} was already linked to ${billModel},${target_id}; no write was issued.`
          );
        } else {
          if (previous_link.res_model !== null) {
            warnings.push(
              `Relinked documents.document ${source_document_id} from ${previous_link.res_model},${previous_link.res_id} ` +
                `to ${billModel},${target_id}; the previous link no longer exists. Use mode=copy instead if the ` +
                "old record must keep its own evidence."
            );
          }
          try {
            await queue.enqueue(conn, "documents.document", "write", {
              ids: [source_document_id],
              vals: { res_model: billModel, res_id: target_id }
            });
          } catch (err) {
            if (isDocumentsUnavailableError(err)) return documentsPreconditionError(err);
            return mcpErrorFromException(err, { model: "documents.document", method: "write" });
          }
          changed = true;
        }

        // Read-back evidence — a fresh call, not the pre-read row.
        let readBackRows: unknown;
        try {
          readBackRows = await queue.enqueue(conn, "documents.document", "read", {
            ids: [source_document_id],
            fields: DOCUMENT_SEARCH_FIELDS
          });
        } catch (err) {
          if (isDocumentsUnavailableError(err)) return documentsPreconditionError(err);
          throw err;
        }
        const readBackRow = firstRecord(readBackRows);
        if (!readBackRow) {
          return billingBlocked(
            { model: "documents.document", method: "read" },
            {
              error: "not_found",
              reason: `documents.document id ${source_document_id} was not found after the write (or record rules hide it).`
            }
          );
        }

        const target_web_url = buildRecordUrl(conn.url, billModel, target_id, bill.record);
        const document_web_url = buildRecordUrl(conn.url, "documents.document", source_document_id);
        const relinked = {
          ok: true as const,
          mode: "relink" as const,
          target_id,
          changed,
          source_document_id: source_document_id as number,
          document: normalizeSourceDocument(readBackRow, new Map(), conn.url),
          previous_link,
          ...(document_web_url ? { document_web_url } : {}),
          ...(target_web_url ? { target_web_url } : {})
        };

        const provenance = changed
          ? await postAttachmentProvenance(queue, conn, billModel, target_id, [
              "mode=relink",
              `source_document=${source_document_id}`,
              `previous_link=${previous_link.res_model ?? "none"},${previous_link.res_id ?? "none"}`,
              `context=${context}`
            ])
          : {};
        return mcpStructured({ ...relinked, ...provenance, warnings, metadata: metadata() });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: mode === "relink" ? "write" : "create" });
      }
    }
  );
}

/**
 * Read the target move and apply the shared draft-vendor-bill gate, returning either the record or
 * the refusal to hand straight back. Same rules (and wording) as `billing.attach_source_pdf`.
 */
async function readDraftVendorBill(
  queue: OdooQueue,
  conn: OdooConnection,
  billModel: string,
  bill_id: number
): Promise<{ record: Record<string, unknown> } | { blocked: ReturnType<typeof billingBlocked> }> {
  const rows = await queue.enqueue(conn, billModel, "read", {
    ids: [bill_id],
    fields: ["id", "state", "move_type"]
  });
  const bill = firstRecord(rows);
  if (!bill) {
    return {
      blocked: billingBlocked(
        { model: billModel, method: "read" },
        { error: "not_found", reason: `account.move id ${bill_id} was not found.` }
      )
    };
  }
  if (!isDraftRecord(bill)) {
    const current = deriveWorkflowStatus(bill) ?? String(bill.state ?? "unknown");
    return {
      blocked: billingBlocked(
        { model: billModel, method: "read" },
        {
          error: "draft_required",
          reason:
            `account.move ${bill_id} is not draft (current state: ${current}). ` +
            "This tool only files evidence onto draft vendor bills. " +
            "If the bill is posted/cancel, call_model_method button_draft (vendor bills only, with write context) first; " +
            "post/reconcile remain blocked on generic MCP tools."
        }
      )
    };
  }
  const moveType = typeof bill.move_type === "string" ? bill.move_type : String(bill.move_type ?? "");
  if (moveType !== "in_invoice") {
    return {
      blocked: billingBlocked(
        { model: billModel, method: "read" },
        {
          error: "vendor_bill_required",
          reason:
            `account.move ${bill_id} has move_type=${moveType || "unknown"}; ` +
            "this slice only files evidence onto draft vendor bills (move_type=in_invoice)."
        }
      )
    };
  }
  return { record: bill };
}

/**
 * Stamp the bill's chatter with what was filed and why. Fails open: a chatter failure must never
 * hide a write that already happened, so it degrades to `provenance_warning` (same shape as
 * `projects.create_task`).
 */
async function postAttachmentProvenance(
  queue: OdooQueue,
  conn: OdooConnection,
  billModel: string,
  bill_id: number,
  parts: string[]
): Promise<{ trace_token?: string; provenance_warning?: string }> {
  const trace_token = "src-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const body = `[agent-source] billing.copy_or_relink_source_attachment corr=${trace_token} ${parts.join(" ")}`;
  try {
    await queue.enqueue(conn, billModel, "message_post", {
      ids: [bill_id],
      body: plaintextToHtml(body),
      body_is_html: true,
      message_type: "comment"
    });
    return { trace_token };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provenance_warning: `the write succeeded but posting the provenance stamp to account.move ${bill_id} failed (${message})`
    };
  }
}

// ---- Expense lifecycle (dedicated tools over the shared lifecycle gate) ----

/**
 * The reversible expense transitions, exposed as named tools so the accounting-only surface
 * (`/accounting/mcp`) can drive reset -> edit -> submit -> approve without shipping the generic
 * `call_model_method` escape hatch. Policy, state checks and audit all come from the shared gate —
 * these are thin, self-describing front doors onto the same rules.
 */
const EXPENSE_LIFECYCLE_TOOLS = [
  {
    name: "billing.reset_expense",
    title: "Reset Expense To Draft",
    method: "action_reset",
    summary: "Reset submitted/approved/refused expenses back to draft so preparatory fields can be corrected.",
    follow_up: "Then use billing.update_draft_expense to fix fields, and billing.submit_expense to send them back."
  },
  {
    name: "billing.submit_expense",
    title: "Submit Expense",
    method: "action_submit",
    summary: "Submit draft expenses for approval.",
    follow_up: "Then use billing.approve_expense if you hold approval rights in Odoo."
  },
  {
    name: "billing.approve_expense",
    title: "Approve Expense",
    method: "action_approve",
    summary: "Approve submitted expenses.",
    follow_up: "Posting the journal entry and paying stay human-only — do those in the Odoo UI."
  }
] as const;

const zLifecycleRecord = z.object({
  id: z.number().int(),
  state_before: z.string().nullable().describe("Live state read during the preflight, before the transition"),
  state_after: z.string().nullable().describe("State re-read after the transition; null when the follow-up read failed")
});

export function registerExpenseLifecycleTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue
) {
  const model = "hr.expense";

  for (const spec of EXPENSE_LIFECYCLE_TOOLS) {
    const rule = getReversibleLifecycleRule(model, spec.method);
    // A tool without a backing allowlist rule would be refused by the gate on every call.
    if (!rule) throw new Error(`${spec.name}: no lifecycle rule for ${model}.${spec.method}`);

    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description:
          `Write: ${spec.summary} Requires state in (${rule.from_states.join(", ")}) on every requested record; ` +
          `the whole call is refused if any record is in another state, is missing, or Odoo withholds the action. ` +
          `${spec.follow_up} Never posts, pays, reconciles or deletes.`,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        inputSchema: {
          record_ids: z
            .array(z.number().int().positive())
            .min(1)
            .max(50)
            .describe("hr.expense ids to transition; all-or-nothing, validated against live state first"),
          context: zRequiredWriteContext
        },
        outputSchema: {
          ok: z.boolean(),
          model: z.string(),
          method: z.string(),
          records: z.array(zLifecycleRecord)
        }
      },
      async ({ record_ids, context }) => {
        logWriteContext(spec.name, model, context);
        const outcome = await runLifecycleAction({
          model,
          method: spec.method,
          ids: record_ids,
          context,
          queue,
          getProps
        });
        if (!outcome.ok) return outcome.response;
        return mcpStructured({ ok: true, model, method: spec.method, records: outcome.records });
      }
    );
  }
}
