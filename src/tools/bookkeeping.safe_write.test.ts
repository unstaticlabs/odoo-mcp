import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import type { OdooQueue } from "../odoo-queue";
import { toWritePlan, verifyConfirmationToken, type PlanResult } from "../safety";
import { registerSafeWritePlannerTools } from "./bookkeeping";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
const SECRET = "test-hmac-secret";

/** Dispatch canned Odoo reads by `${model}.${method}`; `fields_get` keys on the model. */
function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return { enqueue } as unknown as OdooQueue;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };
type ToolRegistry = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> };

function buildHandler(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerSafeWritePlannerTools(server, () => props, queue, new TtlCache({ clock: () => 0 }), () => SECRET);
  // Reach into the SDK registry for the raw handler (mirrors the existing bookkeeping.test.ts pattern),
  // narrowing through `unknown` to a typed registry shape rather than `any`.
  const registry = (server as unknown as ToolRegistry)._registeredTools;
  return registry["bookkeeping.plan_safe_write"].handler;
}

// A responder for the CA12 external-value fixture, parameterised by the line/dup rows returned.
function ca12Responder(opts: { lineRows?: unknown[]; existingValues?: unknown[] } = {}) {
  const lineRows = opts.lineRows ?? [{ id: 22, code: "box_22", name: "Report de crédit de TVA" }];
  const existingValues = opts.existingValues ?? [];
  return (model: string, method: string): unknown => {
    if (method === "fields_get") {
      switch (model) {
        case "account.report.line":
          return { id: {}, code: {}, report_id: {}, name: {} };
        case "account.report.expression":
          return { id: {}, label: {}, engine: {}, report_line_id: {} };
        case "account.report.external.value":
          return { id: {}, date: {}, value: {}, target_report_expression_id: {}, company_id: {} };
        case "account.return":
          return { id: {}, date_from: {}, date_to: {}, company_id: {}, type_id: {} };
        case "res.company":
          return { id: {}, fiscalyear_lock_date: {}, tax_lock_date: {}, hard_lock_date: {} };
        default:
          return {};
      }
    }
    if (method === "read" && model === "res.company") {
      return [{ id: 1, fiscalyear_lock_date: false, tax_lock_date: false, hard_lock_date: false }];
    }
    if (method === "search_read") {
      switch (model) {
        case "res.company":
          return [{ id: 1, name: "ACME FR" }];
        case "account.report.line":
          return lineRows;
        case "account.report.expression":
          return [{ id: 220, label: "_applied_carryover_balance", engine: "external" }];
        case "account.report.external.value":
          return existingValues;
        case "account.return":
          return [{ date_from: "2025-10-01", date_to: "2026-09-30" }];
        default:
          return [];
      }
    }
    return null;
  };
}

const CA12_VALUES = {
  report_line_code: "box_22",
  expression_label: "_applied_carryover_balance",
  date: "2025-09-30",
  value: 942,
  name: "Applied carryover balance"
};

describe("bookkeeping.plan_safe_write — create_or_update_report_external_value", () => {
  test("happy path issues a token that verifies against the reconstructed plan", async () => {
    const handler = buildHandler(dispatchQueue(ca12Responder()));
    const result = await handler({
      operation: "create_or_update_report_external_value",
      company: "ACME FR",
      values: CA12_VALUES
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("safe");
    expect(parsed.confirmation_required).toBe(true);
    expect(typeof parsed.confirmation_token).toBe("string");
    expect(parsed.would_write.method).toBe("create");

    // The token verifies against a WritePlan rebuilt from the response (operation + company_id known).
    const planResult: PlanResult = {
      status: parsed.status,
      resolved_target: parsed.resolved_target,
      existing_records: parsed.existing_records,
      lock_dates: parsed.lock_dates,
      warnings: parsed.warnings,
      would_write: parsed.would_write,
      duplicate_as_update: false
    };
    const plan = toWritePlan("create_or_update_report_external_value", 1, planResult);
    expect(await verifyConfirmationToken(parsed.confirmation_token, plan, SECRET, 0)).toBe("valid");
  });

  test("existing value on the same date → duplicate_found update with a token", async () => {
    const handler = buildHandler(dispatchQueue(ca12Responder({ existingValues: [{ id: 55, date: "2025-09-30", value: 500 }] })));
    const result = await handler({
      operation: "create_or_update_report_external_value",
      company: "ACME FR",
      values: CA12_VALUES
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("duplicate_found");
    expect(parsed.would_write).toMatchObject({ method: "write", id: 55 });
    expect(typeof parsed.confirmation_token).toBe("string");
  });

  test("unknown line code → blocked with no token", async () => {
    const handler = buildHandler(dispatchQueue(ca12Responder({ lineRows: [] })));
    const result = await handler({
      operation: "create_or_update_report_external_value",
      company: "ACME FR",
      values: CA12_VALUES
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("blocked");
    expect(parsed.confirmation_token).toBeUndefined();
  });

  test("unknown company → tool error", async () => {
    const handler = buildHandler(dispatchQueue((model, method) => (model === "res.company" && method === "search_read" ? [] : null)));
    const result = await handler({
      operation: "create_or_update_report_external_value",
      company: "Nope",
      values: CA12_VALUES
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Company not found");
  });
});

describe("bookkeeping.plan_safe_write — create_lock_exception", () => {
  test("model absent on this Odoo version → blocked, no token", async () => {
    const handler = buildHandler(
      dispatchQueue((model, method) => {
        if (model === "res.company" && method === "search_read") return [{ id: 1, name: "ACME FR" }];
        if (model === "account.lock_exception" && method === "fields_get") return {}; // no fields → unsupported
        return null;
      })
    );
    const result = await handler({
      operation: "create_lock_exception",
      company: "ACME FR",
      values: { company: "ACME FR", field: "tax_lock_date", exception_date: "2025-09-30", reason: "carryover" }
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("blocked");
    expect(parsed.confirmation_token).toBeUndefined();
  });
});
