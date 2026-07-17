import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { classifyPmWriteIntent } from "../safety";
import {
  blockedInvoiceLineFields,
  isDraftRecord,
  partitionAllowlistedValues,
  registerBillingWriteTools,
  DRAFT_EXPENSE_FIELDS,
  DRAFT_VENDOR_BILL_FIELDS
} from "./billing";
import { registerSafeWritePlannerTools } from "./bookkeeping";
import { validatedToolHandler } from "./structured-test-util";
import { TtlCache } from "../cache";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return { enqueue } as unknown as OdooQueue;
}

function buildBillingHandlers(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerBillingWriteTools(server, () => props, queue);
  return {
    server,
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
  test("account.move generic write still denied and routes to billing.*", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { ref: "INV/001" } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("financial_mutation");
    expect(result.reason).toContain("billing.");
    expect(result.reason).toContain("billing.configure_draft_vendor_bill");
    // Must not imply draft prep lives solely on the tax planner.
    expect(result.reason).not.toMatch(/plan_safe_write only/i);
  });

  test("hr.expense generic write still denied and routes to billing.*", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "write",
      args: { ids: [394], vals: { date: "2026-07-04" } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.reason).toContain("billing.update_draft_expense");
    expect(result.reason).toContain("bookkeeping.plan_safe_write");
  });

  test("other account.* models still point at plan_safe_write without billing draft tools", () => {
    const result = classifyPmWriteIntent({
      model: "account.tax",
      method: "write",
      args: { ids: [1], vals: { name: "x" } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.reason).toContain("bookkeeping.plan_safe_write");
    expect(result.reason).not.toContain("billing.update_draft_expense");
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
