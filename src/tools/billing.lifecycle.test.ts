/**
 * Dedicated expense lifecycle tools + the shared stateful gate they run on.
 *
 * These tools exist so the accounting-only surface (`/accounting/mcp`, which deliberately ships no
 * generic `call_model_method`) can still drive reset -> edit -> submit -> approve. The safety
 * semantics are asserted here once, against the shared gate, for both entry points.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { registerBillingWriteTools, registerExpenseLifecycleTools } from "./billing";
import { validatedToolHandler } from "./structured-test-util";
import { registerWriteTools } from "./write";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };

// Spies here would otherwise leak into other test files in the same bun process.
afterEach(() => {
  mock.restore();
});

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
type Call = { model: string; method: string; args: Record<string, unknown> };

function dispatchQueue(responder: (call: Call) => unknown): { queue: OdooQueue; calls: Call[] } {
  const calls: Call[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const call = { model: a[1] as string, method: a[2] as string, args: a[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call);
  });
  return { queue: { enqueue } as unknown as OdooQueue, calls };
}

/** Mirrors the AccountingAgent registration set for lifecycle purposes (no generic write tools). */
function accountingSurface(queue: OdooQueue) {
  const server = new McpServer({ name: "test-accounting", version: "0.0.0" });
  registerBillingWriteTools(server, () => props, queue);
  registerExpenseLifecycleTools(server, () => props, queue);
  return server;
}

function toolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

function handler(server: McpServer, name: string) {
  return validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
}

/** A queue whose `read` answers with the given rows and whose action call succeeds. */
function expenseQueue(rows: Record<string, unknown>[], after?: Record<string, unknown>[]) {
  let reads = 0;
  return dispatchQueue(({ method }) => {
    if (method === "read") {
      reads += 1;
      return reads === 1 ? rows : (after ?? rows);
    }
    return true;
  });
}

describe("accounting surface exposes the lifecycle path without the escape hatch", () => {
  test("the three expense lifecycle tools are registered, call_model_method is not", () => {
    const { queue } = expenseQueue([]);
    const names = toolNames(accountingSurface(queue));
    expect(names).toContain("billing.reset_expense");
    expect(names).toContain("billing.submit_expense");
    expect(names).toContain("billing.approve_expense");
    expect(names).toContain("billing.update_draft_expense");
    expect(names).not.toContain("call_model_method");
    expect(names).not.toContain("update_record");
  });

  test("every lifecycle tool declares its allowed states in its own description", () => {
    const { queue } = expenseQueue([]);
    const server = accountingSurface(queue);
    const registry = (server as unknown as { _registeredTools: Record<string, { description: string }> })
      ._registeredTools;
    expect(registry["billing.reset_expense"].description).toContain("submitted");
    expect(registry["billing.submit_expense"].description).toContain("draft");
    expect(registry["billing.approve_expense"].description).toContain("submitted");
  });
});

describe("billing.reset_expense", () => {
  test("resets validated records and reports before/after state", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue(
      [
        { id: 306, state: "approved", can_reset: true },
        { id: 270, state: "submitted", can_reset: true }
      ],
      [
        { id: 306, state: "draft" },
        { id: 270, state: "draft" }
      ]
    );
    const result = await handler(accountingSurface(queue), "billing.reset_expense")({
      record_ids: [306, 270],
      context: "re-categorising July expenses onto the right analytic account"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      model: "hr.expense",
      method: "action_reset",
      records: [
        { id: 306, state_before: "approved", state_after: "draft" },
        { id: 270, state_before: "submitted", state_after: "draft" }
      ]
    });
    expect(calls.map((c) => c.method)).toEqual(["read", "action_reset", "read"]);
    expect(calls[0].args.fields).toEqual(["id", "state", "can_reset"]);
    expect(calls[1].args).toEqual({ ids: [306, 270] });
  });

  test("refuses the whole call when any record is in an excluded state, before mutating", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue([
      { id: 306, state: "approved", can_reset: true },
      { id: 270, state: "posted", can_reset: true }
    ]);
    const result = await handler(accountingSurface(queue), "billing.reset_expense")({
      record_ids: [306, 270],
      context: "re-categorising July expenses"
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_state_incompatible");
    expect(envelope.details).toContain("Odoo UI");
    expect(calls.map((c) => c.method)).toEqual(["read"]);
  });

  test("refuses when Odoo withholds the action for this user (can_reset false)", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue([{ id: 306, state: "approved", can_reset: false }]);
    const result = await handler(accountingSurface(queue), "billing.reset_expense")({
      record_ids: [306],
      context: "re-categorising"
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_guard_failed");
    expect(envelope.details).toContain("can_reset");
    expect(calls.map((c) => c.method)).toEqual(["read"]);
  });

  test("refuses ids the pre-read did not return", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue([{ id: 306, state: "approved", can_reset: true }]);
    const result = await handler(accountingSurface(queue), "billing.reset_expense")({
      record_ids: [306, 999],
      context: "re-categorising"
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_ids_invalid");
    expect(envelope.details).toContain("999");
    expect(calls.map((c) => c.method)).toEqual(["read"]);
  });

  test("a failed post-read leaves the action applied and reports state_after as null", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    let reads = 0;
    const { queue, calls } = dispatchQueue(({ method }) => {
      if (method === "read") {
        reads += 1;
        if (reads === 1) return [{ id: 306, state: "approved", can_reset: true }];
        throw new Error("transient read failure");
      }
      return true;
    });
    const result = await handler(accountingSurface(queue), "billing.reset_expense")({
      record_ids: [306],
      context: "re-categorising"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.records).toEqual([{ id: 306, state_before: "approved", state_after: null }]);
    expect(calls.map((c) => c.method)).toEqual(["read", "action_reset", "read"]);
  });
});

describe("submit / approve tools", () => {
  test("submit requires draft and approve requires submitted", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const submitOnApproved = expenseQueue([{ id: 306, state: "approved" }]);
    const submitResult = await handler(accountingSurface(submitOnApproved.queue), "billing.submit_expense")({
      record_ids: [306],
      context: "resubmitting"
    });
    expect(JSON.parse(submitResult.content[0].text).policy_rule).toBe("lifecycle_state_incompatible");

    const approveOnDraft = expenseQueue([{ id: 306, state: "draft", can_approve: true }]);
    const approveResult = await handler(accountingSurface(approveOnDraft.queue), "billing.approve_expense")({
      record_ids: [306],
      context: "approving"
    });
    expect(JSON.parse(approveResult.content[0].text).policy_rule).toBe("lifecycle_state_incompatible");
  });

  test("approve refuses when can_approve is false", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue } = expenseQueue([{ id: 306, state: "submitted", can_approve: false }]);
    const result = await handler(accountingSurface(queue), "billing.approve_expense")({
      record_ids: [306],
      context: "approving"
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_guard_failed");
    expect(envelope.details).toContain("can_approve");
  });

  test("approve succeeds on a submitted expense whose can_approve is true", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue(
      [{ id: 306, state: "submitted", can_approve: true }],
      [{ id: 306, state: "approved" }]
    );
    const result = await handler(accountingSurface(queue), "billing.approve_expense")({
      record_ids: [306],
      context: "approving the corrected expense"
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.records).toEqual([{ id: 306, state_before: "submitted", state_after: "approved" }]);
    expect(calls.map((c) => c.method)).toEqual(["read", "action_approve", "read"]);
  });
});

describe("guard fields are version-tolerant", () => {
  test("a read that rejects the guard field is retried without it and the check is skipped", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const readFields: unknown[] = [];
    const { queue, calls } = dispatchQueue(({ method, args }) => {
      if (method !== "read") return true;
      readFields.push(args.fields);
      const fields = args.fields as string[];
      // Emulate an Odoo version without `can_reset`: the projected read raises.
      if (fields.includes("can_reset")) throw new Error('Invalid field "can_reset" on model "hr.expense"');
      return [{ id: 306, state: "approved" }];
    });

    const result = await handler(accountingSurface(queue), "billing.reset_expense")({
      record_ids: [306],
      context: "re-categorising on an older Odoo"
    });

    expect(result.isError).toBeUndefined();
    expect(readFields[0]).toEqual(["id", "state", "can_reset"]);
    expect(readFields[1]).toEqual(["id", "state"]);
    expect(calls.map((c) => c.method)).toEqual(["read", "read", "action_reset", "read"]);
  });
});

describe("id validation is shared by call_model_method", () => {
  function fullSurface(queue: OdooQueue) {
    const server = new McpServer({ name: "test-full", version: "0.0.0" });
    registerWriteTools(server, () => props, queue);
    registerBillingWriteTools(server, () => props, queue);
    registerExpenseLifecycleTools(server, () => props, queue);
    return server;
  }

  test("non-positive ids are refused, never silently dropped", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue([{ id: 306, state: "approved", can_reset: true }]);
    const result = await handler(fullSurface(queue), "call_model_method")({
      model: "hr.expense",
      method: "action_reset",
      ids: [306, 0],
      context: "resetting"
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("lifecycle_ids_invalid");
    expect(calls).toEqual([]);
  });

  test("duplicate ids collapse to a single validated record", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const { queue, calls } = expenseQueue([{ id: 306, state: "approved", can_reset: true }]);
    const result = await handler(fullSurface(queue), "billing.reset_expense")({
      record_ids: [306, 306],
      context: "resetting"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.records).toHaveLength(1);
    expect(calls[1].args).toEqual({ ids: [306] });
  });
});
