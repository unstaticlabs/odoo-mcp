import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OdooError } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import { withTestMutationScope } from "../test-odoo-queue";
import { registerBillingWriteTools, registerExpenseLifecycleTools } from "./billing";
import { validatedToolHandler } from "./structured-test-util";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
type Call = { model: string; method: string; args: Record<string, unknown> };

function queueFor(responder: (call: Call) => unknown) {
  const calls: Call[] = [];
  const enqueue = mock(async (...args: unknown[]) => {
    const call = { model: args[1] as string, method: args[2] as string, args: args[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call);
  });
  return { queue: withTestMutationScope({ enqueue }), calls };
}

function accountingSurface(queue: OdooQueue) {
  const server = new McpServer({ name: "test-accounting", version: "1.0.0" });
  registerBillingWriteTools(server, () => props, queue);
  registerExpenseLifecycleTools(server, () => props, queue);
  return server;
}

describe("Odoo-authoritative expense lifecycle", () => {
  test("focused accounting surface keeps the three dedicated lifecycle tools", () => {
    const { queue } = queueFor(() => []);
    const names = Object.keys((accountingSurface(queue) as any)._registeredTools);
    expect(names).toContain("billing.reset_expense");
    expect(names).toContain("billing.submit_expense");
    expect(names).toContain("billing.approve_expense");
    expect(names).not.toContain("call_model_method");
  });

  test("calls one public Odoo method for all ids and reports before/after state", async () => {
    let reads = 0;
    const { queue, calls } = queueFor(({ method }) => {
      if (method === "read") {
        reads++;
        return reads === 1
          ? [{ id: 7, state: "reported" }, { id: 8, state: "approved" }]
          : [{ id: 7, state: "draft" }, { id: 8, state: "draft" }];
      }
      if (method === "action_reset") return true;
      throw new Error(`unexpected ${method}`);
    });
    const server = accountingSurface(queue);
    const handler = validatedToolHandler(server, "billing.reset_expense") as (args: unknown) => Promise<any>;
    const result = await handler({ record_ids: [7, 8], reason: "correct imported expenses", idempotency_key: "reset-7-8" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.records).toEqual([
      { id: 7, state_before: "reported", state_after: "draft" },
      { id: 8, state_before: "approved", state_after: "draft" }
    ]);
    expect(result.structuredContent.execution).toEqual(expect.objectContaining({
      idempotency_key: "reset-7-8",
      outcome: "succeeded"
    }));
    expect(calls.filter((call) => call.method === "action_reset")).toEqual([
      { model: "hr.expense", method: "action_reset", args: { ids: [7, 8] } }
    ]);
  });

  test("does not deny a call from connector-inferred state or can_* fields", async () => {
    const { queue, calls } = queueFor(({ method }) => {
      if (method === "read") return [{ id: 9, state: "paid", can_reset: false }];
      if (method === "action_reset") return true;
      return null;
    });
    const handler = validatedToolHandler(accountingSurface(queue), "billing.reset_expense") as (args: unknown) => Promise<any>;
    const result = await handler({ record_ids: [9] });
    expect(result.isError).toBeUndefined();
    expect(calls.some((call) => call.method === "action_reset")).toBe(true);
  });

  test("surfaces Odoo ACL refusal without replacing it with connector policy", async () => {
    const { queue } = queueFor(({ method }) => {
      if (method === "read") return [{ id: 9, state: "reported" }];
      throw new OdooError({
        message: "Access denied by Odoo",
        code: "permission_denied",
        httpStatus: 403,
        model: "hr.expense",
        method,
        details: "Access denied by Odoo",
        denialKind: "acl",
        mutationOutcome: "not_applied"
      });
    });
    const handler = validatedToolHandler(accountingSurface(queue), "billing.reset_expense") as (args: unknown) => Promise<any>;
    const result = await handler({ record_ids: [9] });
    const error = JSON.parse(result.content[0].text);
    expect(error.error).toBe("permission_denied");
    expect(error.denial_kind).toBe("acl");
    expect(error.refusing_layer).toBe("odoo_acl");
    expect(JSON.stringify(error)).not.toContain("connector_policy");
  });
});
