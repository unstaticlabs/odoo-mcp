import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { classifyPmWriteIntent } from "../safety";
import {
  blockedInvoiceLineFields,
  buildExpenseAuditDomain,
  expenseMatchesAnalyticAccounts,
  flagExpenseDuplicates,
  isDraftRecord,
  normalizeAnalyticDistribution,
  partitionAllowlistedValues,
  registerBillingReadTools,
  registerBillingWriteTools,
  DRAFT_EXPENSE_FIELDS,
  DRAFT_VENDOR_BILL_FIELDS,
  EXPENSE_AUDIT_FIELDS,
  EXPENSE_DUPLICATE_HEURISTIC
} from "./billing";
import { registerSafeWritePlannerTools } from "./bookkeeping";
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
    ) => Promise<ToolResult>
  };
}

describe("registerBillingWriteTools", () => {
  test("registers both billing write tools", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBillingWriteTools(server, () => props, dispatchQueue(() => null));
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(registry["billing.update_draft_expense"]).toBeDefined();
    expect(registry["billing.configure_draft_vendor_bill"]).toBeDefined();
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
    expect(result.structuredContent).toEqual({ ok: true, record_id: 394, state: "draft" });
    expect(calls).toEqual([
      { model: "hr.expense", method: "read", args: { ids: [394], fields: ["id", "state"] } },
      { model: "hr.expense", method: "write", args: { ids: [394], vals: { date: "2026-07-04" } } }
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
    expect(result.structuredContent).toEqual({
      ok: true,
      record_id: 9647,
      state: "draft",
      move_type: "in_invoice"
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
