/**
 * Regression tests for the confirmation gaps found reviewing PR #91 (card #2199).
 *
 * Each test here corresponds to a way an irreversible operation could reach Odoo in a single
 * unconfirmed call. They are written to FAIL if the gate is ever narrowed back:
 *
 * 1. lock-sensitive writes (`account.lock_exception` CRUD, lock-date fields on any model);
 * 2. posting under an alias (`_post`, `button_validate`) rather than the public button;
 * 3. `create_record` / `update_record` / `batch_update` executing irreversible ops without a token
 *    (they previously called only `gateWrite`, which deliberately lets irreversible through);
 * 4. un-posting via `button_draft` from state `posted` — the reverse of `action_post`;
 * 5. `batch_update` applying earlier updates before refusing a later one.
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getHighRiskMethodRule, requiresConfirmationFromState, getReversibleLifecycleRule } from "./lifecycle-allowlist";
import type { OdooQueue } from "./odoo-queue";
import { classifyOperation, lockSensitiveFields } from "./policy";
import { validatedToolHandler } from "./tools/structured-test-util";
import { registerWriteTools } from "./tools/write";
import { assessWriteOperation } from "./write-safety";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
const SECRET = "test-confirmation-secret";

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

function handlers(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue, () => SECRET);
  const h = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return {
    createRecord: h("create_record"),
    updateRecord: h("update_record"),
    batchUpdate: h("batch_update"),
    callModelMethod: h("call_model_method")
  };
}

/** Parse the confirmation envelope out of a preflight (non-error) response. */
function envelopeOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("lock-sensitive writes require confirmation", () => {
  test("account.lock_exception create/write are irreversible, not reversible configuration", () => {
    for (const method of ["create", "write"]) {
      const c = classifyOperation("account.lock_exception", method);
      expect(c.requires_confirmation).toBe(true);
      expect(c.bucket).toBe("irreversible_ledger");
      expect(c.risk_class).toBe("lock_sensitive");
    }
  });

  test("a write that moves a lock date on any accounting model is irreversible", () => {
    const c = classifyOperation("res.company", "write", {
      ids: [1],
      vals: { fiscalyear_lock_date: "2026-01-01" }
    });
    expect(c.requires_confirmation).toBe(true);
    expect(c.risk_class).toBe("lock_sensitive");
    expect(c.reason).toContain("fiscalyear_lock_date");
  });

  test("lockSensitiveFields reads both vals and vals_list shapes, and ignores ordinary fields", () => {
    expect(lockSensitiveFields({ vals: { tax_lock_date: "2026-01-01" } })).toEqual(["tax_lock_date"]);
    expect(lockSensitiveFields({ vals_list: [{ hard_lock_date: "2026-01-01" }] })).toEqual(["hard_lock_date"]);
    expect(lockSensitiveFields({ vals: { name: "not a lock" } })).toEqual([]);
    expect(lockSensitiveFields(undefined)).toEqual([]);
  });

  test("update_record cannot move a lock date without a token", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const result = await handlers(queue).updateRecord({
      model: "account.move",
      record_id: 1,
      values: { tax_lock_date: "2026-01-01" },
      context: "closing the year"
    });
    const envelope = envelopeOf(result);
    expect(envelope.error).toBe("confirmation_required");
    expect(typeof envelope.confirmation_token).toBe("string");
    // Nothing reached Odoo.
    expect(calls).toEqual([]);
  });
});

describe("gap closed: res.company is admitted, so the lock fence now stands on its own", () => {
  // In Odoo 18/19 `fiscalyear_lock_date` / `tax_lock_date` / `hard_lock_date` are res.company fields.
  // The model used to be default-denied, which meant a lock write was refused generically and the
  // field-level escalation was only load-bearing for account.*. Now that res.company is admitted for
  // its two default-tax fields (card ODOO2297), the lock class is the thing standing between an agent
  // and a company's lock dates — these tests assert the classifier owns that, not the default deny.
  for (const field of ["fiscalyear_lock_date", "tax_lock_date", "hard_lock_date", "purchase_lock_date"]) {
    test(`res.company write of ${field} reaches the lock-sensitive class`, () => {
      const verdict = assessWriteOperation({
        model: "res.company",
        method: "write",
        args: { ids: [1], vals: { [field]: "2026-01-01" } }
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.policy_rule).toBe("irreversible_confirmation_required");
      expect(verdict.risk_class).toBe("lock_sensitive");
      expect(verdict.reason).toContain(field);
    });
  }

  test("a lock date rides along with an allowlisted tax field without downgrading the class", () => {
    const verdict = assessWriteOperation({
      model: "res.company",
      method: "write",
      args: { ids: [1], vals: { account_sale_tax_id: 3, tax_lock_date: "2026-01-01" } }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.policy_rule).toBe("irreversible_confirmation_required");
    expect(verdict.risk_class).toBe("lock_sensitive");
  });

  test("update_record cannot move a res.company lock date without a token", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const result = await handlers(queue).updateRecord({
      model: "res.company",
      record_id: 1,
      values: { fiscalyear_lock_date: "2026-01-01" },
      context: "closing FY2025"
    });
    const envelope = envelopeOf(result);
    expect(envelope.error).toBe("confirmation_required");
    expect(envelope.risk_class).toBe("lock_sensitive");
    expect(typeof envelope.confirmation_token).toBe("string");
    expect(calls).toEqual([]);
  });

  test("create_record cannot set a res.company lock date without a token", async () => {
    const { queue, calls } = dispatchQueue(() => [5]);
    const result = await handlers(queue).createRecord({
      model: "res.company",
      values: { account_sale_tax_id: 3, tax_lock_date: "2026-01-01" },
      context: "new entity setup"
    });
    expect(envelopeOf(result).error).toBe("confirmation_required");
    expect(calls).toEqual([]);
  });

  test("call_model_method cannot move a lock date through the escape hatch either", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const result = await handlers(queue).callModelMethod({
      model: "res.company",
      method: "write",
      ids: [1],
      kwargs: { vals: { hard_lock_date: "2026-01-01" } },
      context: "hard close"
    });
    expect(envelopeOf(result).error).toBe("confirmation_required");
    expect(calls).toEqual([]);
  });

  test("the lock write executes once the issued token is supplied", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const h = handlers(queue);
    const args = {
      model: "res.company",
      record_id: 1,
      values: { fiscalyear_lock_date: "2026-01-01" },
      context: "closing FY2025"
    };
    const token = envelopeOf(await h.updateRecord(args)).confirmation_token as string;
    const executed = await h.updateRecord({ ...args, confirmation_token: token });
    expect(executed.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["write"]);
  });
});

describe("reconcile is high-risk and requires confirmation (#2295)", () => {
  test("account.move.line.reconcile and aliases classify as irreversible ledger", () => {
    for (const method of ["reconcile", "action_reconcile", "js_assign_outstanding_line"] as const) {
      expect(getHighRiskMethodRule("account.move.line", method)).toBeTruthy();
      expect(classifyOperation("account.move.line", method).requires_confirmation).toBe(true);
    }
  });
});

describe("posting cannot be reached under an alias", () => {
  test("_post and button_validate are high-risk like action_post", () => {
    for (const [model, method] of [
      ["account.move", "_post"],
      ["account.bank.statement", "button_validate"],
      ["account.move", "action_post"]
    ] as const) {
      expect(getHighRiskMethodRule(model, method)).toBeDefined();
      expect(classifyOperation(model, method).requires_confirmation).toBe(true);
    }
  });

  test("call_model_method refuses _post without a token and does not call Odoo", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const result = await handlers(queue).callModelMethod({
      model: "account.move",
      method: "_post",
      ids: [7],
      context: "posting"
    });
    expect(envelopeOf(result).error).toBe("confirmation_required");
    expect(calls).toEqual([]);
  });
});

describe("every mutating tool enforces confirmation, not just delete/call", () => {
  test("create_record on a lock-sensitive model preflights instead of creating", async () => {
    const { queue, calls } = dispatchQueue(() => [1]);
    const result = await handlers(queue).createRecord({
      model: "account.lock_exception",
      values: { company_id: 1 },
      context: "unlock for correction"
    });
    expect(envelopeOf(result).error).toBe("confirmation_required");
    expect(calls).toEqual([]);
  });

  test("create_record executes once the issued token is supplied", async () => {
    const { queue, calls } = dispatchQueue(() => [42]);
    const h = handlers(queue);
    const preflight = await h.createRecord({
      model: "account.lock_exception",
      values: { company_id: 1 },
      context: "unlock for correction"
    });
    const token = envelopeOf(preflight).confirmation_token as string;

    const executed = await h.createRecord({
      model: "account.lock_exception",
      values: { company_id: 1 },
      context: "unlock for correction",
      confirmation_token: token
    });
    expect(executed.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["create"]);
  });

  test("batch_update refuses an irreversible entry without a token", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const result = await handlers(queue).batchUpdate({
      model: "account.lock_exception",
      updates: [{ record_id: 1, values: { company_id: 2 } }],
      context: "bulk"
    });
    expect(envelopeOf(result).error).toBe("confirmation_required");
    expect(calls).toEqual([]);
  });

  test("batch_update applies NOTHING when a later entry is refused", async () => {
    // First update is ordinary, second moves a lock date. The whole batch must be rejected before
    // any write lands — a policy refusal must never cause a partial write.
    const { queue, calls } = dispatchQueue(() => true);
    const result = await handlers(queue).batchUpdate({
      model: "account.move",
      updates: [
        { record_id: 1, values: { ref: "Fine" } },
        { record_id: 2, values: { tax_lock_date: "2026-01-01" } }
      ],
      context: "bulk"
    });
    expect(envelopeOf(result).error).toBe("confirmation_required");
    expect(calls).toEqual([]);
  });
});

describe("un-posting is gated in the same class as posting", () => {
  test("the button_draft rule declares posted as confirmation-requiring", () => {
    const rule = getReversibleLifecycleRule("account.move", "button_draft")!;
    expect(rule.from_states).toContain("posted");
    expect(requiresConfirmationFromState(rule, "posted")).toBe(true);
    // A cancelled move carries no live journal entry — that direction stays unconfirmed.
    expect(requiresConfirmationFromState(rule, "cancel")).toBe(false);
  });

  test("call_model_method preflights button_draft on a POSTED move and does not mutate", async () => {
    const { queue, calls } = dispatchQueue(({ method }) => {
      if (method === "read") return [{ id: 9, state: "posted" }];
      return true;
    });
    const result = await handlers(queue).callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "correcting a manual entry"
    });
    const envelope = envelopeOf(result);
    expect(envelope.error).toBe("confirmation_required");
    expect(String(envelope.details)).toContain("un-posts");
    // The live state read happened; the mutation did not.
    expect(calls.map((c) => c.method)).toEqual(["read"]);
  });

  test("button_draft on a CANCELLED move still executes in one call", async () => {
    const { queue, calls } = dispatchQueue(({ method }) => {
      if (method === "read") return [{ id: 9, state: "cancel" }];
      return true;
    });
    const result = await handlers(queue).callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "reopening a cancelled bill"
    });
    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["read", "button_draft"]);
  });

  test("un-posting executes once the token is supplied", async () => {
    const { queue, calls } = dispatchQueue(({ method }) => {
      if (method === "read") return [{ id: 9, state: "posted" }];
      return true;
    });
    const h = handlers(queue);
    const preflight = await h.callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "correcting a manual entry"
    });
    const token = envelopeOf(preflight).confirmation_token as string;
    expect(typeof token).toBe("string");

    const executed = await h.callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "correcting a manual entry",
      confirmation_token: token
    });
    expect(executed.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toContain("button_draft");
  });

  test("un-posting also executes when the token is only under kwargs (lift + strip)", async () => {
    const { queue, calls } = dispatchQueue(({ method }) => {
      if (method === "read") return [{ id: 9, state: "posted" }];
      return true;
    });
    const h = handlers(queue);
    const preflight = await h.callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "correcting a manual entry"
    });
    const token = envelopeOf(preflight).confirmation_token as string;

    const executed = await h.callModelMethod({
      model: "account.move",
      method: "button_draft",
      ids: [9],
      context: "correcting a manual entry",
      kwargs: { confirmation_token: token }
    });
    expect(executed.isError).toBeUndefined();
    const mutate = calls.find((c) => c.method === "button_draft");
    expect(mutate).toBeDefined();
    expect(mutate!.args).not.toHaveProperty("confirmation_token");
  });
});
