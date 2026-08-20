import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { classifyPmWriteIntent } from "../safety";
import { PDFDocument } from "pdf-lib";
import { base64ToBytes, bytesToBase64, countPdfPages } from "../pdf-pages";
import {
  analyticAccountIdsFromDistribution,
  blockedInvoiceLineFields,
  buildExpenseAuditDomain,
  companyBoundFieldIds,
  deriveSourcePdfName,
  expenseMatchesAnalyticAccounts,
  flagExpenseDuplicates,
  incompatibleCompanyBoundFields,
  isDraftRecord,
  normalizeAnalyticDistribution,
  parseExpenseMoveRequest,
  partitionAllowlistedValues,
  registerBillingReadTools,
  registerBillingWriteTools,
  requiresEmployeeReassignment,
  retainedCompanyBoundFields,
  COMPANY_BOUND_EXPENSE_FIELDS,
  DRAFT_EXPENSE_FIELDS,
  DRAFT_VENDOR_BILL_FIELDS,
  EXPENSE_AUDIT_FIELDS,
  EXPENSE_DUPLICATE_HEURISTIC,
  EXPENSE_MOVE_READ_FIELDS,
  EXPENSE_PAYMENT_MODES,
  VENDOR_BILL_REVIEW_STATES,
  invalidPaymentMode,
  invalidReviewState
} from "./billing";
import { registerSafeWritePlannerTools } from "./bookkeeping";
import { OdooError } from "../odoo";
import { validatedToolHandler } from "./structured-test-util";
import { TtlCache } from "../cache";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const callLog: { model: string; method: string; ms: number; ok: boolean }[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const model = a[1] as string;
    const method = a[2] as string;
    const args = a[3] as Record<string, unknown>;
    try {
      const result = responder(model, method, args);
      callLog.push({ model, method, ms: 0, ok: true });
      return result;
    } catch (err) {
      callLog.push({ model, method, ms: 0, ok: false });
      throw err;
    }
  });
  return {
    enqueue,
    snapshot: () => callLog.length,
    delta: (snap: number) => {
      const slice = callLog.slice(snap);
      return {
        odoo_calls: slice.length,
        total_duration_ms: slice.reduce((sum, c) => sum + c.ms, 0),
        calls: [...slice]
      };
    }
  } as unknown as OdooQueue;
}

function buildBillingHandlers(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerBillingReadTools(server, () => props, queue);
  registerBillingWriteTools(server, () => props, queue);
  return {
    server,
    auditExpenses: validatedToolHandler(server, "billing.audit_expenses") as (args: unknown) => Promise<ToolResult>,
    updateExpense: validatedToolHandler(server, "billing.update_draft_expense") as (args: unknown) => Promise<ToolResult>,
    configureBill: validatedToolHandler(server, "billing.configure_draft_vendor_bill") as (
      args: unknown
    ) => Promise<ToolResult>,
    attachSourcePdf: validatedToolHandler(server, "billing.attach_source_pdf") as (
      args: unknown
    ) => Promise<ToolResult>,
    copyOrRelink: validatedToolHandler(server, "billing.copy_or_relink_source_attachment") as (
      args: unknown
    ) => Promise<ToolResult>
  };
}

describe("registerBillingWriteTools", () => {
  test("registers the billing write tools", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingWriteTools(server, () => props, dispatchQueue(() => null));
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(registry["billing.update_draft_expense"]).toBeDefined();
    expect(registry["billing.configure_draft_vendor_bill"]).toBeDefined();
    expect(registry["billing.attach_source_pdf"]).toBeDefined();
    expect(registry["billing.copy_or_relink_source_attachment"]).toBeDefined();
  });

  test("update_draft_expense description and values describe list payment_mode", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingWriteTools(server, () => props, dispatchQueue(() => null));
    const tool = (server as any)._registeredTools["billing.update_draft_expense"];
    expect(String(tool.description)).toContain("payment_mode");
    expect(String(tool.description)).toContain("own_account");
    expect(String(tool.description)).toContain("company_account");
    const valuesDescribe = String(tool.inputSchema.shape.values.description ?? "");
    expect(valuesDescribe).toContain("payment_mode");
  });
});

describe("registerBillingReadTools", () => {
  test("registers billing.audit_expenses with readOnlyHint", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingReadTools(server, () => props, dispatchQueue(() => null));
    const tool = (server as any)._registeredTools["billing.audit_expenses"];
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(String(tool.description).startsWith("Read-only:")).toBe(true);
  });
});

describe("buildExpenseAuditDomain", () => {
  test("empty filters → empty domain", () => {
    expect(buildExpenseAuditDomain({})).toEqual([]);
  });

  test("state single and multi", () => {
    expect(buildExpenseAuditDomain({ state: "approved" })).toEqual([["state", "=", "approved"]]);
    expect(buildExpenseAuditDomain({ state: ["approved", "done"] })).toEqual([
      ["state", "in", ["approved", "done"]]
    ]);
  });

  test("product, dates, company", () => {
    expect(
      buildExpenseAuditDomain({
        product_id: [10, 11],
        date_from: "2026-01-01",
        date_to: "2026-06-30",
        company_id: 1
      })
    ).toEqual([
      ["product_id", "in", [10, 11]],
      ["date", ">=", "2026-01-01"],
      ["date", "<=", "2026-06-30"],
      ["company_id", "=", 1]
    ]);
  });

  test("analytic_account_id is not in the domain", () => {
    expect(buildExpenseAuditDomain({ analytic_account_id: 42, state: "approved" })).toEqual([
      ["state", "=", "approved"]
    ]);
  });
});

describe("analytic post-filter", () => {
  test("keeps rows whose distribution keys intersect requested ids", () => {
    expect(expenseMatchesAnalyticAccounts({ "100": 50, "200": 50 }, [200])).toBe(true);
    expect(expenseMatchesAnalyticAccounts({ "100": 100 }, [200])).toBe(false);
    expect(expenseMatchesAnalyticAccounts(null, [200])).toBe(false);
    expect(expenseMatchesAnalyticAccounts({ "100": 100 }, [])).toBe(true);
  });

  test("normalizeAnalyticDistribution handles false and JSON string", () => {
    expect(normalizeAnalyticDistribution(false)).toBeNull();
    expect(normalizeAnalyticDistribution('{"5":100}')).toEqual({ "5": 100 });
  });
});

describe("flagExpenseDuplicates", () => {
  test("peers flagged; unique rows not flagged; empty employee/product treated consistently", () => {
    const flags = flagExpenseDuplicates([
      { id: 1, employee_id: [10, "A"], date: "2026-07-01", total_amount: 42, product_id: false },
      { id: 2, employee_id: [10, "A"], date: "2026-07-01", total_amount: 42, product_id: false },
      { id: 3, employee_id: false, date: "2026-07-01", total_amount: 10, product_id: false },
      { id: 4, employee_id: false, date: "2026-07-01", total_amount: 10, product_id: false },
      { id: 5, employee_id: [10, "A"], date: "2026-07-01", total_amount: 99, product_id: false }
    ]);
    expect(flags.get(1)).toMatchObject({ is_duplicate: true, peer_ids: [2] });
    expect(flags.get(2)).toMatchObject({ is_duplicate: true, peer_ids: [1] });
    expect(flags.get(3)).toMatchObject({ is_duplicate: true, peer_ids: [4] });
    expect(flags.get(4)).toMatchObject({ is_duplicate: true, peer_ids: [3] });
    expect(flags.get(5)).toEqual({ is_duplicate: false, reason: null, peer_ids: [] });
  });
});

describe("billing.audit_expenses", () => {
  const sampleExpense = {
    id: 394,
    name: "Taxi CA26",
    state: "approved",
    date: "2026-07-04",
    employee_id: [7, "Ada"],
    product_id: [3, "Travel"],
    account_id: [601, "Expenses"],
    analytic_distribution: { "26": 100 },
    tax_ids: [12, 13],
    payment_mode: "own_account",
    currency_id: [1, "EUR"],
    total_amount: 42.5,
    total_amount_currency: 42.5,
    reference: "CA26-1",
    company_id: 1
  };

  test("happy path: search_count + search_read + one attachment search_read", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (model === "hr.expense" && method === "search_count") return 1;
      if (model === "hr.expense" && method === "search_read") return [sampleExpense];
      if (model === "ir.attachment" && method === "search_read") {
        return [{ id: 99, name: "receipt.pdf", mimetype: "application/pdf", file_size: 1200, res_id: 394 }];
      }
      return null;
    });
    const { auditExpenses, server } = buildBillingHandlers(queue);
    expect((server as any)._registeredTools["billing.audit_expenses"].annotations.readOnlyHint).toBe(true);

    const result = await auditExpenses({
      state: "approved",
      analytic_account_id: 26,
      date_from: "2026-01-01",
      date_to: "2026-12-31",
      limit: 50,
      offset: 0
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      model: "hr.expense",
      method: "search_count",
      args: {
        domain: [
          ["state", "=", "approved"],
          ["date", ">=", "2026-01-01"],
          ["date", "<=", "2026-12-31"]
        ]
      }
    });
    expect(calls[1].model).toBe("hr.expense");
    expect(calls[1].method).toBe("search_read");
    expect(calls[1].args.fields).toEqual([...EXPENSE_AUDIT_FIELDS]);
    expect(calls[2]).toEqual({
      model: "ir.attachment",
      method: "search_read",
      args: {
        domain: [
          ["res_model", "=", "hr.expense"],
          ["res_id", "in", [394]],
          ["res_field", "=", false]
        ],
        fields: ["id", "name", "mimetype", "file_size", "res_id"]
      }
    });

    const body = result.structuredContent as any;
    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0]).toMatchObject({
      id: 394,
      name: "Taxi CA26",
      state: "approved",
      employee: { id: 7, name: "Ada" },
      product: { id: 3, name: "Travel" },
      account: { id: 601, name: "Expenses" },
      taxes: [{ id: 12 }, { id: 13 }],
      payment_mode: "own_account",
      total_amount: 42.5,
      attachments: [{ id: 99, name: "receipt.pdf", mimetype: "application/pdf", file_size: 1200 }],
      duplicate: { is_duplicate: false, reason: null, peer_ids: [] }
    });
    expect(body.totals).toEqual({
      count: 1,
      matched_count: 1,
      sum_total_amount: 42.5,
      duplicate_count: 0
    });
    expect(body.page).toEqual({ limit: 50, offset: 0, has_more: false, next_offset: null });
    expect(body.duplicate_heuristic).toBe(EXPENSE_DUPLICATE_HEURISTIC);
    expect(body.metadata.odoo_calls).toBe(3);
    expect(body.warnings.some((w: string) => w.includes("analytic_account_id"))).toBe(true);
  });

  test("analytic post-filter drops non-intersecting rows", async () => {
    const queue = dispatchQueue((model, method) => {
      if (method === "search_count") return 2;
      if (model === "hr.expense" && method === "search_read") {
        return [
          { ...sampleExpense, id: 1, analytic_distribution: { "26": 100 } },
          { ...sampleExpense, id: 2, analytic_distribution: { "99": 100 } }
        ];
      }
      if (model === "ir.attachment") return [];
      return null;
    });
    const { auditExpenses } = buildBillingHandlers(queue);
    const result = await auditExpenses({ analytic_account_id: 26 });
    const body = result.structuredContent as any;
    expect(body.expenses.map((e: any) => e.id)).toEqual([1]);
    expect(body.totals.matched_count).toBe(2);
    expect(body.totals.count).toBe(1);
  });

  test("empty set skips attachment call", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "search_count") return 0;
      if (method === "search_read") return [];
      return null;
    });
    const { auditExpenses } = buildBillingHandlers(queue);
    const result = await auditExpenses({});
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["hr.expense.search_count", "hr.expense.search_read"]);
    expect((result.structuredContent as any).expenses).toEqual([]);
    expect((result.structuredContent as any).metadata.odoo_calls).toBe(2);
  });

  test("inverted dates → error with zero Odoo calls", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      return null;
    });
    const { auditExpenses } = buildBillingHandlers(queue);
    const result = await auditExpenses({ date_from: "2026-12-31", date_to: "2026-01-01" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Inverted date range");
    expect(calls).toEqual([]);
  });

  test("multi-currency warning when summing", async () => {
    const queue = dispatchQueue((model, method) => {
      if (method === "search_count") return 2;
      if (model === "hr.expense" && method === "search_read") {
        return [
          { ...sampleExpense, id: 1, currency_id: [1, "EUR"], total_amount: 10 },
          { ...sampleExpense, id: 2, currency_id: [2, "USD"], total_amount: 20, analytic_distribution: false }
        ];
      }
      if (model === "ir.attachment") return [];
      return null;
    });
    const { auditExpenses } = buildBillingHandlers(queue);
    const result = await auditExpenses({});
    const body = result.structuredContent as any;
    expect(body.totals.sum_total_amount).toBe(30);
    expect(body.warnings.some((w: string) => w.includes("multiple currencies") && w.includes("1") && w.includes("2"))).toBe(
      true
    );
  });

  test("duplicate peers flagged in totals", async () => {
    const queue = dispatchQueue((model, method) => {
      if (method === "search_count") return 2;
      if (model === "hr.expense" && method === "search_read") {
        return [
          { ...sampleExpense, id: 1 },
          { ...sampleExpense, id: 2, name: "Taxi CA26 copy" }
        ];
      }
      if (model === "ir.attachment") return [];
      return null;
    });
    const { auditExpenses } = buildBillingHandlers(queue);
    const result = await auditExpenses({});
    const body = result.structuredContent as any;
    expect(body.totals.duplicate_count).toBe(2);
    expect(body.expenses[0].duplicate.is_duplicate).toBe(true);
    expect(body.expenses[0].duplicate.peer_ids).toEqual([2]);
  });

  test("filter combinations: state array + product + company", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "search_count") return 0;
      if (method === "search_read") return [];
      return null;
    });
    const { auditExpenses } = buildBillingHandlers(queue);
    await auditExpenses({
      state: ["approved", "done"],
      product_id: 3,
      company_id: 1,
      date_from: "2026-01-01"
    });
    expect(calls[0].args.domain).toEqual([
      ["state", "in", ["approved", "done"]],
      ["product_id", "=", 3],
      ["date", ">=", "2026-01-01"],
      ["company_id", "=", 1]
    ]);
  });
});

describe("billing allowlist helpers", () => {
  test("partitionAllowlistedValues keeps date and blocks state", () => {
    const { allowed, blocked } = partitionAllowlistedValues(
      { date: "2026-07-04", state: "posted" },
      DRAFT_EXPENSE_FIELDS
    );
    expect(allowed).toEqual({ date: "2026-07-04" });
    expect(blocked).toContain("state");
  });

  test("payment_reference is allowlisted on vendor bills despite payment_ prefix", () => {
    const { allowed, blocked } = partitionAllowlistedValues(
      { payment_reference: "RF123", payment_state: "paid" },
      DRAFT_VENDOR_BILL_FIELDS
    );
    expect(allowed).toEqual({ payment_reference: "RF123" });
    expect(blocked).toContain("payment_state");
  });

  test("currency_id is allowlisted on vendor bills", () => {
    const { allowed, blocked } = partitionAllowlistedValues(
      { currency_id: 125, payment_state: "paid" },
      DRAFT_VENDOR_BILL_FIELDS
    );
    expect(allowed).toEqual({ currency_id: 125 });
    expect(blocked).toContain("payment_state");
  });

  test("review_state is allowlisted on vendor bills while state stays blocked", () => {
    const { allowed, blocked } = partitionAllowlistedValues(
      { review_state: "todo", state: "posted" },
      DRAFT_VENDOR_BILL_FIELDS
    );
    expect(allowed).toEqual({ review_state: "todo" });
    expect(blocked).toContain("state");
  });

  test("invalidReviewState accepts todo/reviewed and rejects others", () => {
    expect(invalidReviewState({ review_state: "reviewed" })).toBeNull();
    expect(invalidReviewState({ review_state: "bogus" })).toBe("bogus");
    expect(invalidReviewState({ ref: "X" })).toBeNull();
    expect(VENDOR_BILL_REVIEW_STATES.has("todo")).toBe(true);
    expect(VENDOR_BILL_REVIEW_STATES.has("reviewed")).toBe(true);
  });

  test("payment_mode is allowlisted on expenses while state and payment_state stay blocked", () => {
    const { allowed, blocked } = partitionAllowlistedValues(
      { payment_mode: "company_account", state: "posted", payment_state: "paid" },
      DRAFT_EXPENSE_FIELDS
    );
    expect(allowed).toEqual({ payment_mode: "company_account" });
    expect(blocked).toContain("state");
    expect(blocked).toContain("payment_state");
  });

  test("payment_mode is not allowlisted on vendor bills", () => {
    const { allowed, blocked } = partitionAllowlistedValues(
      { payment_mode: "company_account", ref: "X" },
      DRAFT_VENDOR_BILL_FIELDS
    );
    expect(allowed).toEqual({ ref: "X" });
    expect(blocked).toContain("payment_mode");
  });

  test("invalidPaymentMode accepts own_account/company_account and rejects others", () => {
    expect(invalidPaymentMode({ payment_mode: "own_account" })).toBeNull();
    expect(invalidPaymentMode({ payment_mode: "company_account" })).toBeNull();
    expect(invalidPaymentMode({ payment_mode: "bogus" })).toBe("bogus");
    expect(invalidPaymentMode({ date: "2026-07-04" })).toBeNull();
    expect(invalidPaymentMode({ payment_mode: 1 })).toBe("1");
    expect(EXPENSE_PAYMENT_MODES.has("own_account")).toBe(true);
    expect(EXPENSE_PAYMENT_MODES.has("company_account")).toBe(true);
  });

  test("blockedInvoiceLineFields flags nested payment_mode", () => {
    expect(blockedInvoiceLineFields([[0, 0, { name: "Fee", payment_mode: "company_account" }]])).toContain(
      "invoice_line_ids.payment_mode"
    );
  });

  test("isDraftRecord uses state and derived workflow status", () => {
    expect(isDraftRecord({ state: "draft" })).toBe(true);
    expect(isDraftRecord({ state: "approved" })).toBe(false);
    expect(isDraftRecord({ state: "reported" })).toBe(false);
  });

  test("blockedInvoiceLineFields flags nested state", () => {
    expect(blockedInvoiceLineFields([[0, 0, { name: "Fee", state: "posted" }]])).toContain(
      "invoice_line_ids.state"
    );
  });
});

describe("billing.update_draft_expense", () => {
  test("draft expense date update succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 394, state: "draft" }];
      if (method === "write") return true;
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 394, values: { date: "2026-07-04" } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 394,
      state: "draft",
      web_url: "http://example.com/odoo/expenses/394"
    });
    expect(calls).toEqual([
      { model: "hr.expense", method: "read", args: { ids: [394], fields: [...EXPENSE_MOVE_READ_FIELDS] } },
      { model: "hr.expense", method: "write", args: { ids: [394], vals: { date: "2026-07-04" } } },
      {
        model: "hr.expense",
        method: "read",
        args: { ids: [394], fields: ["id", "state", "company_id", "employee_id"] }
      }
    ]);
  });

  test("non-draft expense is refused with no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 394, state: "approved" }];
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 394, values: { date: "2026-07-04" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("draft_required");
    expect(calls).toEqual(["hr.expense.read"]);
  });

  test("non-allowlisted field is refused with blocked_fields", async () => {
    const queue = dispatchQueue((model, method) => {
      if (method === "read") return [{ id: 1, state: "draft" }];
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 1, values: { state: "posted" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(envelope.blocked_fields).toContain("state");
  });

  test("total_amount_currency is refused with allowlist guidance and no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 42, state: "draft" }];
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({
      record_id: 42,
      values: { total_amount_currency: 28.61 }
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(envelope.blocked_fields).toContain("total_amount_currency");
    expect(String(envelope.details)).toContain("total_amount_currency");
    expect(String(envelope.details)).toContain("Allowed:");
    expect(String(envelope.details)).toContain("total_amount");
    expect(calls).toEqual(["hr.expense.read"]);
  });

  test("total_amount write on draft expense succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 42, state: "draft" }];
      if (method === "write") return true;
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 42, values: { total_amount: 28.61 } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 42,
      state: "draft",
      web_url: "http://example.com/odoo/expenses/42"
    });
    expect(calls).toEqual([
      { model: "hr.expense", method: "read", args: { ids: [42], fields: [...EXPENSE_MOVE_READ_FIELDS] } },
      { model: "hr.expense", method: "write", args: { ids: [42], vals: { total_amount: 28.61 } } },
      {
        model: "hr.expense",
        method: "read",
        args: { ids: [42], fields: ["id", "state", "company_id", "employee_id"] }
      }
    ]);
  });

  test("payment_mode company_account alone on a draft expense succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 394, state: "draft" }];
      if (method === "write") return true;
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 394, values: { payment_mode: "company_account" } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.ok).toBe(true);
    expect(calls).toEqual([
      { model: "hr.expense", method: "read", args: { ids: [394], fields: [...EXPENSE_MOVE_READ_FIELDS] } },
      {
        model: "hr.expense",
        method: "write",
        args: { ids: [394], vals: { payment_mode: "company_account" } }
      },
      {
        model: "hr.expense",
        method: "read",
        args: { ids: [394], fields: ["id", "state", "company_id", "employee_id"] }
      }
    ]);
  });

  test("payment_mode own_account alone on a draft expense succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 394, state: "draft" }];
      if (method === "write") return true;
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 394, values: { payment_mode: "own_account" } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.ok).toBe(true);
    expect(calls[1].args.vals).toEqual({ payment_mode: "own_account" });
  });

  test("payment_mode combined with another allowlisted field writes both", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 394, state: "draft" }];
      if (method === "write") return true;
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({
      record_id: 394,
      values: { date: "2026-07-04", payment_mode: "company_account" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls[1].method).toBe("write");
    expect(calls[1].args.vals).toEqual({ date: "2026-07-04", payment_mode: "company_account" });
  });

  test("invalid payment_mode fails closed with no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 394, state: "draft" }];
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 394, values: { payment_mode: "bogus" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("invalid_payment_mode");
    expect(envelope.recoverable).toBe(true);
    expect(calls).toEqual(["hr.expense.read"]);
  });

  test("payment_mode alongside a blocked lifecycle key still reports write_blocked", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 394, state: "draft" }];
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({
      record_id: 394,
      values: { payment_mode: "company_account", state: "approved" }
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(envelope.blocked_fields).toContain("state");
    expect(calls).toEqual(["hr.expense.read"]);
  });

  test("lifecycle and payment keys remain write_blocked on their own", async () => {
    const cases: Array<[string, unknown]> = [
      ["payment_state", "paid"],
      ["sheet_id", 5],
      ["account_move_id", 9],
      ["approval_state", "approved"],
      ["move_type", "in_invoice"],
      ["journal_id", 1]
    ];
    for (const [key, value] of cases) {
      const calls: string[] = [];
      const queue = dispatchQueue((model, method) => {
        calls.push(`${model}.${method}`);
        if (method === "read") return [{ id: 394, state: "draft" }];
        return null;
      });
      const { updateExpense } = buildBillingHandlers(queue);
      const result = await updateExpense({ record_id: 394, values: { [key]: value } });

      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe("write_blocked");
      expect(envelope.blocked_fields).toContain(key);
      expect(calls).toEqual(["hr.expense.read"]);
    }
  });

  test("non-draft expense with only payment_mode is refused with no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 394, state: "approved" }];
      return null;
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 394, values: { payment_mode: "company_account" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("draft_required");
    expect(calls).toEqual(["hr.expense.read"]);
  });
});

describe("billing.update_draft_expense cross-company reassignment", () => {
  /** Draft expense #443, sitting in company 1 on employee 1, with no company-bound references. */
  const bareDraft = {
    id: 443,
    state: "draft",
    company_id: [1, "Unstatic Labs"],
    employee_id: [1, "Valentin Viennot"],
    product_id: false,
    account_id: false,
    tax_ids: [],
    analytic_distribution: false,
    currency_id: [1, "EUR"]
  };

  const movedDraft = {
    id: 443,
    state: "draft",
    company_id: [8, "USL MEDIA"],
    employee_id: [4, "Valentin Viennot"]
  };

  /**
   * Odoo double for the move: `overrides` replaces the response of any `model.method` (and the
   * initial `hr.expense.read`, keyed as `hr.expense.read`; the post-write re-read is `confirm`).
   */
  function moveQueue(overrides: Record<string, unknown> = {}) {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const pick = (key: string, fallback: unknown) => (key in overrides ? overrides[key] : fallback);
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      const key = `${model}.${method}`;
      if (key === "hr.expense.read") {
        // The preflight read asks for the full move field list; the confirmation re-read does not.
        const isConfirm = !(args.fields as string[]).includes("currency_id");
        const row = isConfirm ? pick("confirm", movedDraft) : pick(key, bareDraft);
        if (typeof row === "function") return (row as () => unknown)();
        if (row === null) return [];
        return [row];
      }
      if (key === "hr.expense.write") return true;
      if (key === "res.company.search_read") {
        return pick(key, [{ id: 8, name: "USL MEDIA", currency_id: [1, "EUR"] }]);
      }
      if (key === "hr.employee.search_read") {
        return pick(key, [{ id: 4, name: "Valentin Viennot", company_id: [8, "USL MEDIA"], user_id: [2, "VV"] }]);
      }
      if (key === "hr.employee.read") {
        return pick(key, [{ id: 1, name: "Valentin Viennot", user_id: [2, "VV"] }]);
      }
      if (key in overrides) {
        const value = overrides[key];
        if (typeof value === "function") return (value as (args: Record<string, unknown>) => unknown)(args);
        return value;
      }
      return [];
    });
    return { queue, calls };
  }

  const methodsOf = (calls: { model: string; method: string }[]) => calls.map((c) => `${c.model}.${c.method}`);

  test("moves a clean draft in one write and reports the re-read company/employee", async () => {
    const { queue, calls } = moveQueue();
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({
      record_id: 443,
      values: { company_id: 8, employee_id: 4 },
      context: "fix mis-routed OCR expense"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 443,
      state: "draft",
      company: { id: 8, name: "USL MEDIA" },
      employee: { id: 4, name: "Valentin Viennot" },
      web_url: "http://example.com/odoo/expenses/443"
    });

    const writes = calls.filter((c) => c.method === "write");
    expect(writes).toHaveLength(1);
    expect(writes[0].model).toBe("hr.expense");
    expect(writes[0].args.vals).toEqual({ company_id: 8, employee_id: 4 });
    expect(writes[0].args.context).toEqual({ allowed_company_ids: [1, 8], company_id: 8 });
    expect(methodsOf(calls)).toEqual([
      "hr.expense.read",
      "res.company.search_read",
      "hr.employee.search_read",
      "hr.employee.read",
      "hr.expense.write",
      "hr.expense.read"
    ]);
  });

  test("employee outside the target company is refused with no write", async () => {
    const { queue, calls } = moveQueue({
      "hr.employee.search_read": [{ id: 4, name: "Other", company_id: [1, "Unstatic Labs"], user_id: [2, "VV"] }]
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("employee_company_mismatch");
    expect(envelope.recoverable).toBe(true);
    expect(String(envelope.details)).toContain("company 1");
    expect(methodsOf(calls)).not.toContain("hr.expense.write");
  });

  test("target company the caller cannot see is refused before any employee probe", async () => {
    const { queue, calls } = moveQueue({ "res.company.search_read": [] });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("company_access_denied");
    expect(envelope.recoverable).toBe(false);
    expect(methodsOf(calls)).toEqual(["hr.expense.read", "res.company.search_read"]);
  });

  test("employees linked to different users are refused rather than guessed", async () => {
    const { queue, calls } = moveQueue({
      "hr.employee.search_read": [{ id: 4, name: "Other Person", company_id: [8, "USL MEDIA"], user_id: [9, "Other"] }]
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("employee_user_ambiguous");
    expect(String(envelope.details)).toContain("Other");
    expect(methodsOf(calls)).not.toContain("hr.expense.write");
  });

  test("a target employee with no linked user warns but still moves", async () => {
    const { queue, calls } = moveQueue({
      "hr.employee.search_read": [{ id: 4, name: "Valentin Viennot", company_id: [8, "USL MEDIA"], user_id: false }]
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBeUndefined();
    const warnings = (result.structuredContent as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => w.includes("no linked Odoo user"))).toBe(true);
    expect(methodsOf(calls)).toContain("hr.expense.write");
  });

  test("company-bound references missing from the target company are refused by name", async () => {
    const { queue, calls } = moveQueue({
      "hr.expense.read": {
        ...bareDraft,
        product_id: [5, "Taxi"],
        tax_ids: [3],
        analytic_distribution: { "7": 100 }
      },
      "product.product.search_read": [],
      "account.tax.search_read": [{ id: 3, company_id: [1, "Unstatic Labs"] }],
      "account.analytic.account.search_read": [{ id: 7, company_id: [1, "Unstatic Labs"] }]
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("company_field_conflict");
    expect(envelope.recoverable).toBe(true);
    expect([...envelope.blocked_fields].sort()).toEqual(["analytic_distribution", "product_id", "tax_ids"]);
    for (const field of ["product_id", "tax_ids", "analytic_distribution"]) {
      expect(String(envelope.details)).toContain(field);
    }
    expect(methodsOf(calls)).not.toContain("hr.expense.write");
  });

  test("explicit replacements and clears are probed and applied in the same single write", async () => {
    const { queue, calls } = moveQueue({
      "hr.expense.read": {
        ...bareDraft,
        product_id: [5, "Taxi"],
        tax_ids: [3],
        analytic_distribution: { "7": 100 }
      },
      "product.product.search_read": [{ id: 77, company_id: [8, "USL MEDIA"] }],
      "account.tax.search_read": [{ id: 12, company_id: false }]
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const values = {
      company_id: 8,
      employee_id: 4,
      product_id: 77,
      tax_ids: [[6, 0, [12]]],
      analytic_distribution: {}
    };
    const result = await updateExpense({ record_id: 443, values });

    expect(result.isError).toBeUndefined();
    const writes = calls.filter((c) => c.method === "write");
    expect(writes).toHaveLength(1);
    expect(writes[0].args.vals).toEqual(values);
    // The cleared analytic distribution is not probed; the replacements are.
    const probed = calls.filter((c) => c.method === "search_read" && c.model.startsWith("account.analytic"));
    expect(probed).toHaveLength(0);
    const productProbe = calls.find((c) => c.model === "product.product");
    expect(productProbe?.args.domain).toEqual([
      ["id", "in", [77]],
      "|",
      ["company_id", "=", false],
      ["company_id", "=", 8]
    ]);
  });

  test("account.account residency falls back to company_ids when company_id does not exist", async () => {
    let accountReads = 0;
    const { queue, calls } = moveQueue({
      "hr.expense.read": { ...bareDraft, account_id: [601, "Expenses"] },
      "account.account.search_read": (args: Record<string, unknown>) => {
        accountReads += 1;
        if ((args.fields as string[]).includes("company_id")) throw new Error("Invalid field 'company_id'");
        return [{ id: 601, company_ids: [8] }];
      }
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBeUndefined();
    expect(accountReads).toBe(2);
    expect(calls.filter((c) => c.method === "write")).toHaveLength(1);
  });

  test("an unreadable company-bound field fails closed", async () => {
    const { queue, calls } = moveQueue({
      "hr.expense.read": { ...bareDraft, tax_ids: [3] },
      "account.tax.search_read": () => {
        throw new Error("access denied");
      }
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("company_field_conflict");
    expect(envelope.blocked_fields).toEqual(["tax_ids"]);
    expect(methodsOf(calls)).not.toContain("hr.expense.write");
  });

  test("company_id without employee_id is refused before any probe", async () => {
    const { queue, calls } = moveQueue();
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("company_employee_pairing_required");
    expect(envelope.recoverable).toBe(true);
    expect(methodsOf(calls)).toEqual(["hr.expense.read"]);
  });

  test("a non-positive company_id is refused locally", async () => {
    const { queue, calls } = moveQueue();
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: false, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("invalid_company_reassignment");
    expect(methodsOf(calls)).toEqual(["hr.expense.read"]);
  });

  test("a non-draft expense is refused before any company or employee probe", async () => {
    const { queue, calls } = moveQueue({ "hr.expense.read": { ...bareDraft, state: "approved" } });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("draft_required");
    expect(methodsOf(calls)).toEqual(["hr.expense.read"]);
  });

  test("a currency difference warns without blocking", async () => {
    const { queue } = moveQueue({
      "res.company.search_read": [{ id: 8, name: "USL MEDIA", currency_id: [2, "USD"] }]
    });
    const { updateExpense } = buildBillingHandlers(queue);
    const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

    expect(result.isError).toBeUndefined();
    const warnings = (result.structuredContent as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => w.includes("USD"))).toBe(true);
  });

  test("a write that survives but disappears from view reports success with a warning", async () => {
    for (const confirm of [
      null,
      () => {
        throw new Error("access denied on the moved record");
      }
    ]) {
      const { queue } = moveQueue({ confirm });
      const { updateExpense } = buildBillingHandlers(queue);
      const result = await updateExpense({ record_id: 443, values: { company_id: 8, employee_id: 4 } });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as { ok: boolean; warnings?: string[] };
      expect(structured.ok).toBe(true);
      expect((structured.warnings ?? []).some((w) => w.includes("could not be re-read"))).toBe(true);
    }
  });
});

describe("expense reassignment helpers", () => {
  const record = {
    id: 443,
    state: "draft",
    company_id: [1, "Unstatic Labs"],
    employee_id: [1, "VV"],
    product_id: [5, "Taxi"],
    account_id: false,
    tax_ids: [3],
    analytic_distribution: { "7": 100 }
  };

  test("parseExpenseMoveRequest ignores values without company/employee keys", () => {
    expect(parseExpenseMoveRequest({ date: "2026-07-04" }, record)).toEqual({ kind: "none" });
  });

  test("parseExpenseMoveRequest resolves targets against the record", () => {
    expect(parseExpenseMoveRequest({ company_id: 8, employee_id: [4, "VV"] }, record)).toEqual({
      kind: "move",
      targetCompanyId: 8,
      targetEmployeeId: 4,
      currentCompanyId: 1,
      currentEmployeeId: 1,
      companySupplied: true,
      employeeSupplied: true
    });
    // Employee-only edit: the company target falls back to the record's own company.
    expect(parseExpenseMoveRequest({ employee_id: 4 }, record)).toMatchObject({
      kind: "move",
      targetCompanyId: 1,
      targetEmployeeId: 4,
      companySupplied: false
    });
  });

  test("parseExpenseMoveRequest rejects unparsable and non-positive ids", () => {
    expect(parseExpenseMoveRequest({ company_id: false }, record)).toEqual({
      kind: "invalid",
      field: "company_id",
      value: false
    });
    expect(parseExpenseMoveRequest({ company_id: 8, employee_id: 0 }, record)).toMatchObject({
      kind: "invalid",
      field: "employee_id"
    });
  });

  test("requiresEmployeeReassignment is true only for an actual company change", () => {
    const move = parseExpenseMoveRequest({ company_id: 8, employee_id: 4 }, record);
    const sameCompany = parseExpenseMoveRequest({ company_id: 1, employee_id: 4 }, record);
    expect(move.kind === "move" && requiresEmployeeReassignment(move)).toBe(true);
    expect(sameCompany.kind === "move" && requiresEmployeeReassignment(sameCompany)).toBe(false);
  });

  test("retainedCompanyBoundFields keeps record values and replacements, drops explicit clears", () => {
    expect(retainedCompanyBoundFields(record, {})).toEqual(["product_id", "tax_ids", "analytic_distribution"]);
    expect(
      retainedCompanyBoundFields(record, {
        product_id: false,
        tax_ids: [[6, 0, []]],
        analytic_distribution: {}
      })
    ).toEqual([]);
    expect(retainedCompanyBoundFields(record, { product_id: 77 })).toEqual([
      "product_id",
      "tax_ids",
      "analytic_distribution"
    ]);
    expect(companyBoundFieldIds(record, { product_id: 77 }, "product_id")).toEqual([77]);
    expect(companyBoundFieldIds(record, { tax_ids: [[6, 0, [12]], [4, 13]] }, "tax_ids")).toEqual([12, 13]);
    expect(COMPANY_BOUND_EXPENSE_FIELDS).toEqual(["product_id", "account_id", "tax_ids", "analytic_distribution"]);
  });

  test("analyticAccountIdsFromDistribution splits comma-composite keys", () => {
    // Integer-like keys sort first in JS objects, so compare as a set.
    expect(analyticAccountIdsFromDistribution({ "3,7": 100, "7": 50 }).sort()).toEqual([3, 7]);
    expect(analyticAccountIdsFromDistribution('{"12":100}')).toEqual([12]);
    expect(analyticAccountIdsFromDistribution(false)).toEqual([]);
    expect(analyticAccountIdsFromDistribution({})).toEqual([]);
  });

  test("incompatibleCompanyBoundFields accepts shared and target-owned records only", () => {
    expect(
      incompatibleCompanyBoundFields([
        { field: "product_id", ids: [77], targetCompanyId: 8, rows: [{ id: 77, companyIds: [8] }] },
        { field: "tax_ids", ids: [12], targetCompanyId: 8, rows: [{ id: 12, companyIds: [] }] },
        { field: "account_id", ids: [601], targetCompanyId: 8, rows: [{ id: 601, companyIds: [8, 9] }] }
      ])
    ).toEqual([]);
    expect(
      incompatibleCompanyBoundFields([
        { field: "product_id", ids: [5], targetCompanyId: 8, rows: [{ id: 5, companyIds: [1] }] },
        { field: "tax_ids", ids: [3, 4], targetCompanyId: 8, rows: [{ id: 3, companyIds: [8] }] },
        { field: "account_id", ids: [601], targetCompanyId: 8, rows: [{ id: 601, companyIds: null }] },
        { field: "analytic_distribution", ids: [7], targetCompanyId: 8, rows: [], failed: true }
      ])
    ).toEqual(["product_id", "tax_ids", "account_id", "analytic_distribution"]);
  });

  test("company_id/employee_id are allowlisted while lifecycle fields stay blocked", () => {
    expect(DRAFT_EXPENSE_FIELDS.has("company_id")).toBe(true);
    expect(DRAFT_EXPENSE_FIELDS.has("employee_id")).toBe(true);
    const { allowed, blocked } = partitionAllowlistedValues(
      {
        company_id: 8,
        employee_id: 4,
        journal_id: 2,
        state: "draft",
        payment_mode: "own_account",
        payment_state: "paid"
      },
      DRAFT_EXPENSE_FIELDS
    );
    // payment_mode rides along as an ordinary draft-prep field; lifecycle/payment keys stay blocked.
    expect(allowed).toEqual({ company_id: 8, employee_id: 4, payment_mode: "own_account" });
    expect(blocked.sort()).toEqual(["journal_id", "payment_state", "state"]);
  });
});

describe("billing.configure_draft_vendor_bill", () => {
  const billValues = {
    partner_id: 10,
    invoice_date: "2026-07-01",
    date: "2026-07-01",
    ref: "VB-9647",
    fiscal_position_id: 3,
    invoice_line_ids: [
      [
        0,
        0,
        {
          name: "Consulting",
          quantity: 1,
          price_unit: 100,
          tax_ids: [[6, 0, [1]]],
          analytic_distribution: { "1": 100 }
        }
      ]
    ]
  };

  test("draft in_invoice configure succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 9647, state: "draft", move_type: "in_invoice" }];
      if (method === "write") return true;
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 9647, values: billValues });

    expect(result.isError).toBeUndefined();
    // move_type read live → the link lands on Vendor Bills, not Journal Entries (ODOO2272).
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 9647,
      state: "draft",
      move_type: "in_invoice",
      web_url: "http://example.com/odoo/vendor-bills/9647"
    });
    expect(calls[0]).toEqual({
      model: "account.move",
      method: "read",
      args: { ids: [9647], fields: ["id", "state", "move_type"] }
    });
    expect(calls[1].method).toBe("write");
    expect(calls[1].args.vals).toMatchObject({
      partner_id: 10,
      ref: "VB-9647",
      fiscal_position_id: 3
    });
  });

  test("draft in_invoice configure with currency_id succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 9647, state: "draft", move_type: "in_invoice" }];
      if (method === "write") return true;
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({
      record_id: 9647,
      values: { ...billValues, currency_id: 125 }
    });

    expect(result.isError).toBeUndefined();
    // move_type read live → the link lands on Vendor Bills, not Journal Entries (ODOO2272).
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 9647,
      state: "draft",
      move_type: "in_invoice",
      web_url: "http://example.com/odoo/vendor-bills/9647"
    });
    expect(calls[1].args.vals).toMatchObject({
      partner_id: 10,
      ref: "VB-9647",
      currency_id: 125
    });
  });

  test("reproduction #9694-style payload with currency_id succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 9694, state: "draft", move_type: "in_invoice" }];
      if (method === "write") return true;
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({
      record_id: 9694,
      values: {
        partner_id: 72,
        invoice_date: "2026-08-01",
        date: "2026-08-01",
        ref: "FR79467970",
        payment_reference: "FR79467970",
        currency_id: 125,
        invoice_line_ids: [[0, 0, { name: "Service", quantity: 1, price_unit: 50 }]]
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.ok).toBe(true);
    expect(calls[1].args.vals).toMatchObject({
      partner_id: 72,
      invoice_date: "2026-08-01",
      date: "2026-08-01",
      ref: "FR79467970",
      payment_reference: "FR79467970",
      currency_id: 125
    });
  });

  test("posted bill is refused with no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 9647, state: "posted", move_type: "in_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 9647, values: { ref: "x" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("draft_required");
    expect(calls).toEqual(["account.move.read"]);
  });

  test("draft out_invoice is refused", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 1, state: "draft", move_type: "out_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 1, values: { ref: "x" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("vendor_bill_required");
    expect(calls).toEqual(["account.move.read"]);
  });

  test("non-allowlisted field is refused with blocked_fields", async () => {
    const queue = dispatchQueue((model, method) => {
      if (method === "read") return [{ id: 1, state: "draft", move_type: "in_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 1, values: { state: "posted" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.blocked_fields).toContain("state");
  });

  test("review_state alone succeeds on draft in_invoice", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 8695, state: "draft", move_type: "in_invoice" }];
      if (method === "write") return true;
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 8695, values: { review_state: "todo" } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 8695,
      state: "draft",
      move_type: "in_invoice",
      web_url: "http://example.com/odoo/vendor-bills/8695"
    });
    expect(calls[1].method).toBe("write");
    expect(calls[1].args.vals).toEqual({ review_state: "todo" });
  });

  test("review_state combined with other allowlisted fields succeeds", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "read") return [{ id: 8695, state: "draft", move_type: "in_invoice" }];
      if (method === "write") return true;
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({
      record_id: 8695,
      values: { ...billValues, review_state: "reviewed" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls[1].args.vals).toMatchObject({
      partner_id: 10,
      ref: "VB-9647",
      review_state: "reviewed"
    });
  });

  test("invalid review_state fails closed with no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 8695, state: "draft", move_type: "in_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 8695, values: { review_state: "bogus" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("invalid_review_state");
    expect(envelope.recoverable).toBe(true);
    expect(String(envelope.details)).toContain("todo");
    expect(String(envelope.details)).toContain("reviewed");
    expect(calls).toEqual(["account.move.read"]);
  });

  test("review_state with blocked state still reports write_blocked", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 8695, state: "draft", move_type: "in_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({
      record_id: 8695,
      values: { review_state: "todo", state: "posted" }
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(envelope.blocked_fields).toContain("state");
    expect(calls).toEqual(["account.move.read"]);
  });

  test("payment_mode on a draft vendor bill is write_blocked with no write", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 9647, state: "draft", move_type: "in_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 9647, values: { payment_mode: "company_account" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(envelope.blocked_fields).toContain("payment_mode");
    expect(calls).toEqual(["account.move.read"]);
  });

  test("review_state on posted bill is refused with draft_required", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 8695, state: "posted", move_type: "in_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 8695, values: { review_state: "todo" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("draft_required");
    expect(calls).toEqual(["account.move.read"]);
  });

  test("review_state on draft out_invoice is refused with vendor_bill_required", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((model, method) => {
      calls.push(`${model}.${method}`);
      if (method === "read") return [{ id: 8695, state: "draft", move_type: "out_invoice" }];
      return null;
    });
    const { configureBill } = buildBillingHandlers(queue);
    const result = await configureBill({ record_id: 8695, values: { review_state: "todo" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("vendor_bill_required");
    expect(calls).toEqual(["account.move.read"]);
  });
});

describe("billing.attach_source_pdf", () => {
  /** Page n is 200+n wide, so extracted pages can be traced back to their source page. */
  async function makePdf(pageCount: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 1; i <= pageCount; i++) doc.addPage([200 + i, 200]);
    return doc.save();
  }

  let compositePdf: Uint8Array | undefined;
  /** The Amazon-composite stand-in: one 5-page PDF holding several vendors' invoices. */
  async function compositeBase64(): Promise<string> {
    compositePdf ??= await makePdf(5);
    return bytesToBase64(compositePdf);
  }

  type Call = { model: string; method: string; args: Record<string, unknown> };

  /**
   * Stands up the three reads (bill header, attachment meta, attachment content) plus the
   * create that the tool performs, and records every call so tests can assert nothing else
   * — no `write`, no `action_post` — ever reaches Odoo.
   */
  function attachQueue(opts: {
    bill?: Record<string, unknown> | null;
    meta?: Record<string, unknown> | null;
    datas?: unknown;
    createdId?: number;
  }) {
    const calls: Call[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (model === "account.move" && method === "read") {
        return opts.bill === null ? [] : [opts.bill ?? { id: 9647, state: "draft", move_type: "in_invoice" }];
      }
      if (model === "ir.attachment" && method === "read") {
        const fields = (args.fields as string[]) ?? [];
        if (fields.includes("datas")) return [{ id: 555, datas: opts.datas }];
        return opts.meta === null
          ? []
          : [opts.meta ?? { id: 555, name: "amazon-invoices.pdf", mimetype: "application/pdf", file_size: 4096, type: "binary", url: false }];
      }
      if (model === "ir.attachment" && method === "create") return [opts.createdId ?? 7001];
      return null;
    });
    return { queue, calls };
  }

  const baseArgs = {
    bill_id: 9647,
    source_attachment_id: 555,
    context: "user asked to split the Amazon composite PDF onto bill 9647"
  };

  test("registers as a write tool with a Write: description", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingWriteTools(server, () => props, dispatchQueue(() => null));
    const tool = (server as any)._registeredTools["billing.attach_source_pdf"];
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.annotations.openWorldHint).toBe(false);
    expect(String(tool.description).startsWith("Write:")).toBe(true);
  });

  test("context is required and must be non-empty", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingWriteTools(server, () => props, dispatchQueue(() => null));
    const shape = (server as any)._registeredTools["billing.attach_source_pdf"].inputSchema.shape;
    expect(shape.context.safeParse("split composite PDF").success).toBe(true);
    expect(shape.context.safeParse("").success).toBe(false);
    expect(shape.context.safeParse(undefined).success).toBe(false);
    // Page bounds are enforced by the schema too, so out-of-band values never reach the handler.
    expect(shape.page_from.safeParse(0).success).toBe(false);
    expect(shape.page_to.safeParse(1.5).success).toBe(false);
  });

  test("page extract creates a linked ir.attachment carrying only that range", async () => {
    const { queue, calls } = attachQueue({ datas: await compositeBase64(), createdId: 7042 });
    const { attachSourcePdf } = buildBillingHandlers(queue);
    const result = await attachSourcePdf({ ...baseArgs, page_from: 2, page_to: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      attachment_id: 7042,
      bill_id: 9647,
      res_model: "account.move",
      res_id: 9647,
      name: "amazon-invoices-p2-3.pdf",
      mimetype: "application/pdf",
      mode: "page_extract",
      page_from: 2,
      page_to: 3,
      source_attachment_id: 555,
      source_page_count: 5
    });

    const create = calls.find((c) => c.method === "create")!;
    const vals = (create.args.vals_list as Record<string, unknown>[])[0];
    expect(create.model).toBe("ir.attachment");
    expect(vals).toMatchObject({
      name: "amazon-invoices-p2-3.pdf",
      type: "binary",
      mimetype: "application/pdf",
      res_model: "account.move",
      res_id: 9647
    });

    // The stored bytes really are a 2-page PDF holding source pages 2 and 3.
    const created = base64ToBytes(vals.datas as string);
    expect(await countPdfPages(created)).toBe(2);
    const pages = (await PDFDocument.load(created)).getPages().map((p) => Math.round(p.getWidth()) - 200);
    expect(pages).toEqual([2, 3]);
  });

  test("omitting the page range copies the whole PDF byte-for-byte", async () => {
    const base64 = await compositeBase64();
    const { queue, calls } = attachQueue({ datas: base64 });
    const { attachSourcePdf } = buildBillingHandlers(queue);
    const result = await attachSourcePdf(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      attachment_id: 7001,
      mode: "full_copy",
      page_from: null,
      page_to: null,
      name: "amazon-invoices-copy.pdf",
      source_page_count: 5
    });

    const vals = (calls.find((c) => c.method === "create")!.args.vals_list as Record<string, unknown>[])[0];
    expect(base64ToBytes(vals.datas as string)).toEqual(compositePdf!);
  });

  test("an explicit name overrides the derived one", async () => {
    const { queue, calls } = attachQueue({ datas: await compositeBase64() });
    const { attachSourcePdf } = buildBillingHandlers(queue);
    const result = await attachSourcePdf({ ...baseArgs, page_from: 1, page_to: 1, name: "ACME invoice.pdf" });

    expect(result.structuredContent?.name).toBe("ACME invoice.pdf");
    const vals = (calls.find((c) => c.method === "create")!.args.vals_list as Record<string, unknown>[])[0];
    expect(vals.name).toBe("ACME invoice.pdf");
  });

  test("every Odoo call is queued, and the move is only ever read", async () => {
    const { queue, calls } = attachQueue({ datas: await compositeBase64() });
    const { attachSourcePdf } = buildBillingHandlers(queue);
    await attachSourcePdf({ ...baseArgs, page_from: 1, page_to: 2 });

    expect((queue.enqueue as any).mock.calls.length).toBe(calls.length);
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      "account.move.read",
      "ir.attachment.read",
      "ir.attachment.read",
      "ir.attachment.create"
    ]);
    for (const call of calls) {
      if (call.model === "account.move") expect(call.method).toBe("read");
      expect(["read", "create"]).toContain(call.method);
    }
  });

  describe("refusals", () => {
    async function refuse(args: Record<string, unknown>, opts: Parameters<typeof attachQueue>[0]) {
      const { queue, calls } = attachQueue(opts);
      const { attachSourcePdf } = buildBillingHandlers(queue);
      const result = await attachSourcePdf({ ...baseArgs, ...args });
      expect(result.isError).toBe(true);
      return { envelope: JSON.parse(result.content[0].text), calls };
    }

    test("posted bill", async () => {
      const { envelope, calls } = await refuse({}, { bill: { id: 9647, state: "posted", move_type: "in_invoice" } });
      expect(envelope.error).toBe("draft_required");
      expect(envelope.intent).toBe("financial_mutation");
      expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["account.move.read"]);
    });

    test("customer invoice", async () => {
      const { envelope, calls } = await refuse({}, { bill: { id: 9647, state: "draft", move_type: "out_invoice" } });
      expect(envelope.error).toBe("vendor_bill_required");
      expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["account.move.read"]);
    });

    test("missing bill", async () => {
      const { envelope, calls } = await refuse({}, { bill: null });
      expect(envelope.error).toBe("not_found");
      expect(envelope.model).toBe("account.move");
      expect(calls.length).toBe(1);
    });

    test("missing source attachment", async () => {
      const { envelope, calls } = await refuse({}, { meta: null });
      expect(envelope.error).toBe("not_found");
      expect(envelope.model).toBe("ir.attachment");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("url-type source", async () => {
      const { envelope, calls } = await refuse(
        {},
        { meta: { id: 555, name: "remote.pdf", mimetype: "application/pdf", file_size: false, type: "url", url: "https://example.com/x.pdf" } }
      );
      expect(envelope.error).toBe("url_attachment");
      // No content read: a URL attachment has no bytes to fetch.
      expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["account.move.read", "ir.attachment.read"]);
    });

    test("oversize source is refused before the content read", async () => {
      const { envelope, calls } = await refuse(
        { max_bytes: 1024 },
        { meta: { id: 555, name: "big.pdf", mimetype: "application/pdf", file_size: 20971520, type: "binary", url: false } }
      );
      expect(envelope.error).toBe("oversize");
      expect(envelope.details).toContain("1.37x");
      expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["account.move.read", "ir.attachment.read"]);
    });

    test("non-PDF content, however it is labelled", async () => {
      const { envelope, calls } = await refuse(
        {},
        {
          meta: { id: 555, name: "scan.pdf", mimetype: "application/pdf", file_size: 12, type: "binary", url: false },
          datas: bytesToBase64(new TextEncoder().encode("<html>nope</html>"))
        }
      );
      expect(envelope.error).toBe("not_pdf");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("empty stored content", async () => {
      const { envelope, calls } = await refuse({}, { datas: false });
      expect(envelope.error).toBe("pdf_error");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("half-specified page range, before any Odoo call", async () => {
      const { envelope, calls } = await refuse({ page_from: 2 }, {});
      expect(envelope.error).toBe("invalid_page_range");
      expect(envelope.details).toContain("No Odoo call was made");
      expect(calls).toEqual([]);
    });

    test("inverted page range, before any Odoo call", async () => {
      const { envelope, calls } = await refuse({ page_from: 4, page_to: 2 }, {});
      expect(envelope.error).toBe("invalid_page_range");
      expect(calls).toEqual([]);
    });

    test("page range past the end reports the real page count", async () => {
      const { envelope, calls } = await refuse(
        { page_from: 4, page_to: 9 },
        { datas: await compositeBase64() }
      );
      expect(envelope.error).toBe("invalid_page_range");
      expect(envelope.details).toContain("5 page(s)");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("unparseable PDF bytes", async () => {
      const { envelope, calls } = await refuse(
        { page_from: 1, page_to: 1 },
        { datas: bytesToBase64(new TextEncoder().encode("%PDF-1.4 truncated")) }
      );
      expect(envelope.error).toBe("pdf_error");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("source that decodes larger than max_bytes despite an understated file_size", async () => {
      const { envelope, calls } = await refuse(
        { max_bytes: 512 },
        {
          meta: { id: 555, name: "sneaky.pdf", mimetype: "application/pdf", file_size: 10, type: "binary", url: false },
          datas: await compositeBase64()
        }
      );
      expect(envelope.error).toBe("oversize");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });
  });
});

describe("billing.copy_or_relink_source_attachment", () => {
  type Call = { model: string; method: string; args: Record<string, unknown> };

  const SOURCE_BYTES = bytesToBase64(new TextEncoder().encode("scanned vendor invoice"));
  const SOURCE_META = {
    id: 555,
    name: "acme-invoice-jun.pdf",
    mimetype: "application/pdf",
    file_size: 22,
    type: "binary",
    checksum: "abc123",
    // Still filed against the zero-value duplicate the agent is about to delete.
    res_model: "account.move",
    res_id: 9099
  };
  const SOURCE_DOCUMENT = {
    id: 300,
    name: "acme-invoice-jun.pdf",
    folder_id: [2, "Vendor bills"],
    tag_ids: [],
    owner_id: [1, "Mitchell"],
    res_model: "account.move",
    res_id: 9099,
    create_date: "2026-06-30 09:00:00",
    write_date: "2026-06-30 09:00:00",
    mimetype: "application/pdf",
    file_size: 22,
    checksum: "abc123",
    attachment_id: [555, "acme-invoice-jun.pdf"]
  };

  /**
   * Stands up the source (attachment and/or Documents row), the target bill, the create and the
   * read-back, recording every call so "the bill is only ever read" stays assertable.
   */
  function copyQueue(
    opts: {
      bill?: Record<string, unknown> | null;
      meta?: Record<string, unknown> | null;
      document?: Record<string, unknown> | null;
      documentsUnavailable?: boolean;
      datas?: unknown;
      createdId?: number;
      copyRow?: Record<string, unknown> | null;
      relinkedDocument?: Record<string, unknown>;
      failMessagePost?: boolean;
    } = {}
  ) {
    const calls: Call[] = [];
    let documentReads = 0;
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (model === "documents.document") {
        if (opts.documentsUnavailable) {
          throw new OdooError({
            message: "Object documents.document doesn't exist",
            code: "model_or_method_not_found",
            httpStatus: 404,
            model: "documents.document",
            method,
            details: "Object documents.document doesn't exist"
          });
        }
        if (method === "write") return true;
        documentReads += 1;
        if (opts.document === null) return [];
        const base = opts.document ?? SOURCE_DOCUMENT;
        // The second read is the post-write read-back.
        return [documentReads > 1 ? (opts.relinkedDocument ?? { ...base, res_model: "account.move", res_id: 9647 }) : base];
      }
      if (model === "account.move" && method === "read") {
        return opts.bill === null ? [] : [opts.bill ?? { id: 9647, state: "draft", move_type: "in_invoice" }];
      }
      if (model === "account.move" && method === "message_post") {
        if (opts.failMessagePost) throw new Error("odoo message_post boom");
        return 123;
      }
      if (model === "ir.attachment" && method === "read") {
        const fields = (args.fields as string[]) ?? [];
        if (fields.includes("datas")) return [{ id: 555, datas: opts.datas ?? SOURCE_BYTES }];
        const ids = (args.ids as number[]) ?? [];
        if (ids[0] === (opts.createdId ?? 8001)) {
          return opts.copyRow === null
            ? []
            : [
                opts.copyRow ?? {
                  id: opts.createdId ?? 8001,
                  name: "acme-invoice-jun.pdf",
                  mimetype: "application/pdf",
                  file_size: 22,
                  checksum: "abc123"
                }
              ];
        }
        return opts.meta === null ? [] : [opts.meta ?? SOURCE_META];
      }
      if (model === "ir.attachment" && method === "create") return [opts.createdId ?? 8001];
      return null;
    });
    return { queue, calls };
  }

  const baseArgs = {
    source_attachment_id: 555,
    target_id: 9647,
    context: "de-duplicating bill 9099 into canonical draft 9647 before deleting the shell"
  };

  test("registers as a write tool that routes between the four attachment paths", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingWriteTools(server, () => props, dispatchQueue(() => null));
    const tool = (server as any)._registeredTools["billing.copy_or_relink_source_attachment"];

    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(String(tool.description).startsWith("Write:")).toBe(true);
    expect(tool.description).toContain("billing.attach_source_pdf");
    expect(tool.description).toContain("bookkeeping.link_source_document");
    expect(tool.description).toContain("projects.attach_file");

    const shape = tool.inputSchema.shape;
    expect(shape.context.safeParse("").success).toBe(false);
    expect(shape.context.safeParse(undefined).success).toBe(false);
    expect(shape.mode.safeParse("copy").success).toBe(true);
    expect(shape.mode.safeParse("move").success).toBe(false);
    expect(shape.target_model.safeParse("project.task").success).toBe(false);
    expect(shape.mode.parse(undefined)).toBe("copy");
  });

  test("copies an orphaned attachment onto the canonical draft bill, preserving name and checksum", async () => {
    const { queue, calls } = copyQueue();
    const { copyOrRelink } = buildBillingHandlers(queue);

    const result = await copyOrRelink(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      mode: "copy",
      target_id: 9647,
      attachment_id: 8001,
      source_attachment_id: 555,
      name: "acme-invoice-jun.pdf",
      mimetype: "application/pdf",
      file_size: 22,
      checksum: "abc123",
      target_web_url: "http://example.com/odoo/vendor-bills/9647",
      attachment_web_url: "http://example.com/odoo/ir.attachment/8001"
    });

    const create = calls.find((c) => c.method === "create")!;
    const vals = (create.args.vals_list as Record<string, unknown>[])[0];
    expect(create.model).toBe("ir.attachment");
    expect(vals).toEqual({
      name: "acme-invoice-jun.pdf",
      type: "binary",
      mimetype: "application/pdf",
      datas: SOURCE_BYTES,
      res_model: "account.move",
      res_id: 9647
    });

    // The source is only ever read, and the bill is only ever read + stamped.
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      "ir.attachment.read",
      "account.move.read",
      "ir.attachment.read",
      "ir.attachment.create",
      "ir.attachment.read",
      "account.move.message_post"
    ]);
    const body = String(calls.find((c) => c.method === "message_post")!.args.body);
    expect(body).toContain("mode=copy");
    expect(body).toContain("source_attachment=555");
    expect(body).toContain("de-duplicating bill 9099");
  });

  test("warns that the source was still filed against another bill, so the shell is safe to delete", async () => {
    const { queue } = copyQueue();
    const { copyOrRelink } = buildBillingHandlers(queue);

    const result = await copyOrRelink(baseArgs);

    expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("account.move,9099");
  });

  test("a checksum that does not match the source is surfaced, not swallowed", async () => {
    const { queue } = copyQueue({
      copyRow: { id: 8001, name: "acme-invoice-jun.pdf", mimetype: "application/pdf", file_size: 22, checksum: "deadbeef" }
    });
    const { copyOrRelink } = buildBillingHandlers(queue);

    const result = await copyOrRelink(baseArgs);

    expect(result.structuredContent?.checksum).toBe("deadbeef");
    expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("differs from the source's abc123");
  });

  test("a source_document_id resolves the bytes through the Documents row", async () => {
    const { queue, calls } = copyQueue();
    const { copyOrRelink } = buildBillingHandlers(queue);

    const result = await copyOrRelink({
      source_document_id: 300,
      target_id: 9647,
      context: "copy the filed evidence onto the canonical bill"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      mode: "copy",
      source_document_id: 300,
      source_attachment_id: 555,
      attachment_id: 8001
    });
    // No documents.document write in copy mode — the filing is left exactly as it was.
    expect(calls.some((c) => c.model === "documents.document" && c.method === "write")).toBe(false);
  });

  test("an explicit name overrides the preserved source name", async () => {
    const { queue, calls } = copyQueue();
    const { copyOrRelink } = buildBillingHandlers(queue);

    await copyOrRelink({ ...baseArgs, name: "ACME June invoice.pdf" });

    const vals = (calls.find((c) => c.method === "create")!.args.vals_list as Record<string, unknown>[])[0];
    expect(vals.name).toBe("ACME June invoice.pdf");
  });

  test("a chatter failure degrades to provenance_warning rather than hiding the copy", async () => {
    const { queue } = copyQueue({ failMessagePost: true });
    const { copyOrRelink } = buildBillingHandlers(queue);

    const result = await copyOrRelink(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.attachment_id).toBe(8001);
    expect(String(result.structuredContent?.provenance_warning)).toContain("9647");
  });

  describe("relink mode", () => {
    const relinkArgs = {
      source_document_id: 300,
      target_id: 9647,
      mode: "relink" as const,
      context: "move the Documents filing onto the surviving bill"
    };

    test("repoints the Documents row and reports what the link used to be", async () => {
      const { queue, calls } = copyQueue();
      const { copyOrRelink } = buildBillingHandlers(queue);

      const result = await copyOrRelink(relinkArgs);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        ok: true,
        mode: "relink",
        changed: true,
        target_id: 9647,
        source_document_id: 300,
        previous_link: { res_model: "account.move", res_id: 9099 },
        document_web_url: "http://example.com/odoo/documents/300",
        target_web_url: "http://example.com/odoo/vendor-bills/9647"
      });
      expect((result.structuredContent?.document as any).res_id).toBe(9647);

      const write = calls.find((c) => c.method === "write")!;
      expect(write.model).toBe("documents.document");
      expect(write.args).toEqual({ ids: [300], vals: { res_model: "account.move", res_id: 9647 } });
      // No bytes are duplicated in relink mode.
      expect(calls.some((c) => c.model === "ir.attachment")).toBe(false);
      expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("no longer exists");
    });

    test("a document already on the target is left alone", async () => {
      const { queue, calls } = copyQueue({
        document: { ...SOURCE_DOCUMENT, res_id: 9647 },
        relinkedDocument: { ...SOURCE_DOCUMENT, res_id: 9647 }
      });
      const { copyOrRelink } = buildBillingHandlers(queue);

      const result = await copyOrRelink(relinkArgs);

      expect(result.structuredContent?.changed).toBe(false);
      expect(calls.some((c) => c.method === "write")).toBe(false);
      expect((result.structuredContent?.warnings as string[]).join(" ")).toContain("already linked");
    });

    test("relink without a Documents row is refused before any Odoo call, pointing at copy mode", async () => {
      const { queue, calls } = copyQueue();
      const { copyOrRelink } = buildBillingHandlers(queue);

      const result = await copyOrRelink({ ...baseArgs, mode: "relink" });

      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe("relink_requires_document");
      expect(envelope.details).toContain("mode=copy");
      expect(calls).toEqual([]);
    });

    test("a database without the Documents app fails closed", async () => {
      const { queue, calls } = copyQueue({ documentsUnavailable: true });
      const { copyOrRelink } = buildBillingHandlers(queue);

      const result = await copyOrRelink(relinkArgs);

      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe("documents_app_unavailable");
      expect(calls.some((c) => c.method === "write")).toBe(false);
    });
  });

  describe("refusals", () => {
    async function refuse(args: Record<string, unknown>, opts: Parameters<typeof copyQueue>[0] = {}) {
      const { queue, calls } = copyQueue(opts);
      const { copyOrRelink } = buildBillingHandlers(queue);
      const result = await copyOrRelink({ ...baseArgs, ...args });
      expect(result.isError).toBe(true);
      return { envelope: JSON.parse(result.content[0].text), calls };
    }

    test("both sources, or neither, before any Odoo call", async () => {
      const both = await refuse({ source_document_id: 300 });
      expect(both.envelope.error).toBe("invalid_source");
      expect(both.calls).toEqual([]);

      const neither = await refuse({ source_attachment_id: undefined });
      expect(neither.envelope.error).toBe("invalid_source");
      expect(neither.calls).toEqual([]);
    });

    test("a URL-only source has no bytes to copy", async () => {
      const { envelope, calls } = await refuse(
        {},
        { meta: { ...SOURCE_META, type: "url", url: "https://example.com/x.pdf", file_size: false } }
      );
      expect(envelope.error).toBe("url_attachment");
      expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["ir.attachment.read"]);
    });

    test("an oversize source is refused on metadata, before the content read", async () => {
      const { envelope, calls } = await refuse({ max_bytes: 1024 }, { meta: { ...SOURCE_META, file_size: 20971520 } });
      expect(envelope.error).toBe("oversize");
      expect(envelope.details).toContain("1.37x");
      expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["ir.attachment.read"]);
    });

    test("a source that decodes larger than max_bytes despite an understated file_size", async () => {
      const { envelope, calls } = await refuse({ max_bytes: 4 }, { meta: { ...SOURCE_META, file_size: 2 } });
      expect(envelope.error).toBe("oversize");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("a posted target bill", async () => {
      const { envelope, calls } = await refuse({}, { bill: { id: 9647, state: "posted", move_type: "in_invoice" } });
      expect(envelope.error).toBe("draft_required");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("a customer invoice target", async () => {
      const { envelope, calls } = await refuse({}, { bill: { id: 9647, state: "draft", move_type: "out_invoice" } });
      expect(envelope.error).toBe("vendor_bill_required");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("a missing target bill", async () => {
      const { envelope } = await refuse({}, { bill: null });
      expect(envelope.error).toBe("not_found");
      expect(envelope.model).toBe("account.move");
    });

    test("a missing source attachment", async () => {
      const { envelope, calls } = await refuse({}, { meta: null });
      expect(envelope.error).toBe("not_found");
      expect(envelope.model).toBe("ir.attachment");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("a source that stores no content", async () => {
      const { envelope, calls } = await refuse({}, { datas: false });
      expect(envelope.error).toBe("empty_source");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });

    test("a Documents row with no attachment behind it", async () => {
      const { queue, calls } = copyQueue({ document: { ...SOURCE_DOCUMENT, attachment_id: false } });
      const { copyOrRelink } = buildBillingHandlers(queue);

      const result = await copyOrRelink({ source_document_id: 300, target_id: 9647, context: "copy the evidence" });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe("no_source_attachment");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    });
  });
});

describe("deriveSourcePdfName", () => {
  test("strips the source extension and records the page range", () => {
    expect(deriveSourcePdfName("amazon-invoices.PDF", 555, { page_from: 2, page_to: 3 })).toBe(
      "amazon-invoices-p2-3.pdf"
    );
    expect(deriveSourcePdfName("amazon-invoices.pdf", 555, null)).toBe("amazon-invoices-copy.pdf");
  });

  test("falls back to the attachment id when Odoo has no usable name", () => {
    expect(deriveSourcePdfName(false, 555, null)).toBe("attachment-555-copy.pdf");
    expect(deriveSourcePdfName("   ", 555, null)).toBe("attachment-555-copy.pdf");
    expect(deriveSourcePdfName(".pdf", 555, null)).toBe("attachment-555-copy.pdf");
  });

  test("stays inside Odoo's 255-char name column", () => {
    const name = deriveSourcePdfName(`${"x".repeat(400)}.pdf`, 555, { page_from: 10, page_to: 12 });
    expect(name.length).toBe(255);
    expect(name.endsWith("-p10-12.pdf")).toBe(true);
  });
});

describe("classifier routing for billing models", () => {
  test("account.move generic write is allowed (Odoo authority; billing.* remain convenience helpers)", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { ref: "INV/001" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.intent).toBe("financial_mutation");
    expect(result.risk_class).toBe("reversible_configuration");
  });

  test("hr.expense generic write is allowed as reversible configuration", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "write",
      args: { ids: [394], vals: { date: "2026-07-04" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_configuration");
  });

  test("other account.* models are action-classified, not prefix-denied", () => {
    const result = classifyPmWriteIntent({
      model: "account.tax",
      method: "write",
      args: { ids: [1], vals: { name: "x" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_configuration");
  });
});

describe("bookkeeping.plan_safe_write enum unchanged", () => {
  test("input enum is still exactly the four tax/report/return/lock ops", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerSafeWritePlannerTools(
      server,
      () => props,
      dispatchQueue(() => null),
      new TtlCache({ clock: () => 0 }),
      () => "secret"
    );
    const tool = (server as any)._registeredTools["bookkeeping.plan_safe_write"];
    const operation = tool.inputSchema.shape.operation;
    const allowed = [
      "create_or_update_report_external_value",
      "create_manual_tax_return",
      "update_return_type_periodicity",
      "create_lock_exception"
    ];
    for (const op of allowed) {
      expect(operation.safeParse(op).success).toBe(true);
    }
    expect(operation.safeParse("configure_draft_vendor_bill").success).toBe(false);
    expect(operation.safeParse("update_draft_expense").success).toBe(false);
    expect(operation.safeParse("create_invoice").success).toBe(false);
  });
});
