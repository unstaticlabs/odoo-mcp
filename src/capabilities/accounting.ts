import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import { attributedContext, OdooContextSchema, PositiveIdSchema } from "../odoo/schemas.js";
import type { RequestContext } from "../runtime/context.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const RecordSchema = z.record(z.string(), z.unknown());
const RecordsSchema = z.array(RecordSchema);
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

function companyContext(requested: Record<string, unknown>, companyId: number, context: RequestContext) {
  return attributedContext({
    ...requested,
    allowed_company_ids: [companyId],
    company_id: companyId
  }, context.correlationId);
}

export function registerAccountingCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "accounting.overview.get",
    name: "accounting_get_overview",
    title: "Get Accounting Overview",
    description:
      "Read the Distribution's company-scoped Accounting cockpit: bank review, draft and incomplete documents, missing evidence, receivables/payables, closing readiness, declarations, hygiene, and review decisions. Use as the first accounting triage call; use generic tools for the underlying records.",
    layer: "semantic",
    toolsets: ["accounting", "expenses", "documents"],
    profiles: ["accounting"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["accounting", "overview", "closing", "declarations", "hygiene", "receivable", "payable", "bank"],
    requiredModules: ["rebuild_account_migration"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 235,
    input: z.object({ company_id: PositiveIdSchema, context: OdooContextSchema }).strict(),
    output: z.object({ overview: RecordSchema }).strict(),
    async handler({ company_id, context: requestedContext }, context, signal) {
      const rows = await client.call<Record<string, unknown>[]>(context, "rebuild.account.overview", "search_read", {
        domain: [["company_id", "=", company_id]],
        fields: [
          "display_name", "company_id", "currency_id", "posted_move_count", "move_line_count", "debit", "credit", "balance",
          "journal_count", "cash_journal_count", "bank_balance", "bank_transaction_count", "unmatched_bank_transaction_count",
          "bank_review_count", "draft_customer_document_count", "draft_vendor_document_count", "draft_expense_count",
          "incomplete_document_count", "missing_vendor_attachment_count", "missing_expense_attachment_count",
          "stale_draft_document_count", "stale_draft_expense_count", "open_receivable_count", "open_receivable_amount",
          "open_payable_count", "open_payable_amount", "latest_closing_period_id", "latest_closing_date_to",
          "latest_closing_state", "latest_closing_readiness", "latest_closing_blocking_count", "latest_closing_warning_count",
          "unusual_balance_count", "unusual_balance_amount", "next_declaration_id", "next_declaration_deadline",
          "next_declaration_status", "overdue_declaration_count", "upcoming_declaration_count", "valentin_action_count",
          "accountant_action_count", "hygiene_attention_count", "hygiene_issue_count", "hygiene_status", "evidence_status",
          "review_decision_count", "pending_review_decision_count", "recorded_review_decision_count",
          "external_report_value_count", "pending_external_report_value_count", "readiness_status"
        ],
        limit: 1,
        context: companyContext(requestedContext, company_id, context)
      }, { signal });
      const overview = rows[0];
      if (!overview) throw new Error(`No readable Accounting overview exists for company ${company_id}`);
      return {
        data: {
          overview: {
            ...overview,
            _ref: {
              model: "rebuild.account.overview",
              id: overview.id,
              display_name: overview.display_name ?? `Accounting overview ${company_id}`,
              url: `${context.principal.publicOrigin}/odoo/rebuild.account.overview/${overview.id}`
            }
          }
        }
      };
    }
  }));

  registry.add(defineCapability({
    id: "accounting.key_accounts.review",
    name: "accounting_review_key_accounts",
    title: "Review Key Accounts",
    description:
      "Read balances and a bounded sample of unreconciled journal items for selected account codes in one company. Use for factual close review; the helper reports missing codes and raw balances without inventing tax or accounting conclusions.",
    layer: "semantic",
    toolsets: ["accounting"],
    profiles: ["accounting"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["account", "balance", "suspense", "reconcile", "open item", "closing"],
    requiredModules: ["account"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 280,
    input: z.object({
      company_id: PositiveIdSchema,
      account_codes: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      open_item_limit: z.number().int().min(1).max(100).default(50),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ accounts: RecordsSchema, balances: RecordsSchema, open_items: RecordsSchema, missing_codes: z.array(z.string()) }).strict(),
    async handler({ company_id, account_codes, date_to, open_item_limit, context: requestedContext }, context, signal) {
      const common = companyContext(requestedContext, company_id, context);
      const codes = [...new Set(account_codes)];
      const accounts = await client.call<Record<string, unknown>[]>(context, "account.account", "search_read", {
        domain: [["company_ids", "in", [company_id]], ["code", "in", codes]],
        fields: ["display_name", "code", "name", "account_type", "reconcile", "currency_id", "company_ids"],
        order: "code asc, id asc",
        limit: 50,
        context: common
      }, { signal });
      const accountIds = accounts.map((account) => account.id).filter((id): id is number => Number.isInteger(id));
      if (accountIds.length === 0) return { data: { accounts: [], balances: [], open_items: [], missing_codes: codes } };
      const [balances, openItems] = await Promise.all([
        client.call<Record<string, unknown>[]>(context, "account.move.line", "formatted_read_group", {
          domain: [["company_id", "=", company_id], ["move_id.state", "=", "posted"], ["date", "<=", date_to], ["account_id", "in", accountIds]],
          groupby: ["account_id"],
          aggregates: ["debit:sum", "credit:sum", "balance:sum"],
          limit: 50,
          context: common
        }, { signal }),
        client.call<Record<string, unknown>[]>(context, "account.move.line", "search_read", {
          domain: [["company_id", "=", company_id], ["move_id.state", "=", "posted"], ["date", "<=", date_to], ["account_id", "in", accountIds], ["reconciled", "=", false]],
          fields: ["date", "move_id", "account_id", "partner_id", "name", "ref", "debit", "credit", "balance", "amount_residual", "currency_id", "amount_currency"],
          order: "date desc, id desc",
          limit: open_item_limit,
          context: common
        }, { signal })
      ]);
      const found = new Set(accounts.map((account) => String(account.code ?? "")));
      return { data: { accounts, balances, open_items: openItems, missing_codes: codes.filter((code) => !found.has(code)) } };
    }
  }));

  registry.add(defineCapability({
    id: "accounting.management_report.get",
    name: "accounting_get_management_report",
    title: "Get Management Report",
    description:
      "Read the Distribution's factual cash-flow or executive-summary lines for one company and period. Use the returned source_formula, drilldown_kind, and counts to explain values; use generic record tools for contributing journal items.",
    layer: "semantic",
    toolsets: ["accounting"],
    profiles: ["accounting"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["management report", "cash flow", "executive summary", "revenue", "spending", "profit"],
    requiredModules: ["rebuild_account_migration"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 290,
    input: z.object({
      company_id: PositiveIdSchema,
      period_key: z.string().trim().min(1).max(200).optional(),
      report_key: z.string().trim().min(1).max(100).optional(),
      limit: z.number().int().min(1).max(200).default(100),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ lines: RecordsSchema }).strict(),
    async handler({ company_id, period_key, report_key, limit, context: requestedContext }, context, signal) {
      const domain: unknown[] = [["company_id", "=", company_id]];
      if (period_key) domain.push(["period_key", "=", period_key]);
      if (report_key) domain.push(["report_key", "=", report_key]);
      const lines = await client.call<Record<string, unknown>[]>(context, "rebuild.account.management.summary.line", "search_read", {
        domain,
        fields: ["company_id", "company_currency_id", "period_key", "report_key", "report_name", "line_sequence", "line_code", "line_name", "metric_type", "source_formula", "drilldown_kind", "move_line_count", "amount", "metric_value"],
        order: "period_key asc, report_key asc, line_sequence asc, id asc",
        limit,
        context: companyContext(requestedContext, company_id, context)
      }, { signal });
      return { data: { lines } };
    }
  }));

  registry.add(defineCapability({
    id: "accounting.tax_report.context",
    name: "accounting_get_tax_report_context",
    title: "Get Tax Report Context",
    description:
      "Read the Distribution's posted tax-report evidence lines for one company and period, optionally narrowed by account code. Use this replacement for legacy Enterprise report-expression inspection; results expose tax tags, accounts, counts, debit, credit, balance, and tax base.",
    layer: "semantic",
    toolsets: ["accounting"],
    profiles: ["accounting"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["tax report", "VAT", "tax tags", "tax base", "journal evidence"],
    requiredModules: ["rebuild_account_migration"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 295,
    input: z.object({
      company_id: PositiveIdSchema,
      period_key: z.string().trim().min(1).max(200),
      account_codes: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      limit: z.number().int().min(1).max(200).default(100),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ lines: RecordsSchema }).strict(),
    async handler({ company_id, period_key, account_codes, limit, context: requestedContext }, context, signal) {
      const domain: unknown[] = [["company_id", "=", company_id], ["period_key", "=", period_key]];
      if (account_codes?.length) domain.push(["account_code", "in", [...new Set(account_codes)]]);
      const lines = await client.call<Record<string, unknown>[]>(context, "rebuild.account.tax.report.line", "search_read", {
        domain,
        fields: ["company_id", "company_currency_id", "period_key", "report_section", "tax_tag_id", "tax_tag_name", "account_id", "account_code", "account_name", "move_line_count", "debit", "credit", "balance", "tax_base_amount"],
        order: "report_section asc, tax_tag_name asc, account_code asc, id asc",
        limit,
        context: companyContext(requestedContext, company_id, context)
      }, { signal });
      return { data: { lines } };
    }
  }));
}
