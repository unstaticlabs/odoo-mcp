/**
 * Policy v1 regression tests (#2199): action-based risk classifier replaces model-prefix denial.
 *
 * Covers:
 * - authorized-workflow-not-blocked (reconcile.model archive, move.line workflow, move reset/write)
 * - irreversible-requires-confirmation (action_post / unlink cannot single-shot)
 * - Odoo-ACL-denial surfaced verbatim with refusing_layer
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OdooError } from "./odoo";
import type { OdooQueue } from "./odoo-queue";
import { classifyOperation, classifyRefusingLayer, extractRejectedFields } from "./policy";
import { classifyPmWriteIntent, issueConfirmationToken, verifyConfirmationToken } from "./safety";
import { mcpErrorFromException } from "./tools/shared";
import { validatedToolHandler } from "./tools/structured-test-util";
import { buildIrreversibleWritePlan, registerWriteTools } from "./tools/write";
import { annotateActionExecutability, assessWriteOperation } from "./write-safety";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
const SECRET = "test-confirmation-secret";

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return { enqueue } as unknown as OdooQueue;
}

function buildHandlers(queue: OdooQueue, secret: string | undefined = SECRET) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue, () => secret);
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return {
    updateRecord: handler("update_record"),
    deleteRecord: handler("delete_record"),
    callModelMethod: handler("call_model_method")
  };
}

describe("authorized-workflow-not-blocked", () => {
  test("archiving account.reconcile.model is not refused by connector prefix policy (#2206)", () => {
    const result = classifyPmWriteIntent({
      model: "account.reconcile.model",
      method: "write",
      args: { ids: [12], vals: { active: false } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.policy_rule).not.toBe("sensitive_model_crud");
    expect(result.risk_class).toBe("reversible_configuration");

    const verdict = assessWriteOperation({
      model: "account.reconcile.model",
      method: "write",
      args: { ids: [12], vals: { active: false } }
    });
    expect(verdict.allowed).toBe(true);
  });

  test("native Move-to-Account style method on account.move.line is not prefix-denied (#2204)", () => {
    const result = classifyPmWriteIntent({
      model: "account.move.line",
      method: "action_move_to_account",
      args: { ids: [99], account_id: 5 }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_lifecycle");
    expect(result.policy_rule).not.toMatch(/sensitive_model/);
  });

  test("account.move write (correct) is allowed as reversible configuration (#2201)", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { ref: "CORRECTION" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_configuration");
  });

  test("account.move button_draft from posted is allowlisted (Odoo enforces hash/lock) (#2201)", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "button_draft",
      args: { ids: [1] }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_lifecycle");
  });

  test("update_record on account.reconcile.model reaches Odoo (no connector prefix block)", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { updateRecord } = buildHandlers(queue);
    const result = await updateRecord({
      model: "account.reconcile.model",
      record_id: 12,
      values: { active: false },
      context: "archive unused reconcile model"
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["write"]);
  });
});

describe("irreversible-requires-confirmation", () => {
  test("account.move action_post cannot execute in a single unconfirmed call", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { callModelMethod } = buildHandlers(queue);

    const preflight = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      context: "post after correction"
    });
    expect(preflight.isError).toBe(true);
    const envelope = JSON.parse(preflight.content[0].text);
    expect(envelope.error).toBe("confirmation_required");
    expect(envelope.refusing_layer).toBe("connector_policy");
    expect(envelope.confirmation_required).toBe(true);
    expect(typeof envelope.confirmation_token).toBe("string");
    expect(envelope.risk_class).toBe("irreversible_posting");
    expect(calls).toEqual([]);

    const confirmed = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      context: "post after correction",
      confirmation_token: envelope.confirmation_token
    });
    expect(confirmed.isError).toBeUndefined();
    expect(calls[0]).toBe("action_post");
  });

  test("delete_record on account.move requires confirmation token", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { deleteRecord } = buildHandlers(queue);

    const preflight = await deleteRecord({ model: "account.move", record_id: 7, context: "remove draft" });
    expect(preflight.isError).toBe(true);
    const envelope = JSON.parse(preflight.content[0].text);
    expect(envelope.error).toBe("confirmation_required");
    expect(calls).toEqual([]);

    const confirmed = await deleteRecord({
      model: "account.move",
      record_id: 7,
      context: "remove draft",
      confirmation_token: envelope.confirmation_token
    });
    expect(confirmed.isError).toBeUndefined();
    expect(calls).toContain("unlink");
  });

  test("tampered confirmation_token is refused with irreversible_confirmation_invalid", async () => {
    const calls: string[] = [];
    const queue = dispatchQueue((_model, method) => {
      calls.push(method);
      return true;
    });
    const { callModelMethod } = buildHandlers(queue);
    const result = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      confirmation_token: "not-a-real-token"
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("irreversible_confirmation_invalid");
    expect(envelope.refusing_layer).toBe("connector_policy");
    expect(calls).toEqual([]);
  });

  test("classifier marks action_post as confirmation-required, not prefix-denied", () => {
    const op = classifyOperation("account.move", "action_post");
    expect(op.requires_confirmation).toBe(true);
    expect(op.bucket).toBe("irreversible_ledger");

    const ann = annotateActionExecutability("account.move", "action_post");
    expect(ann.executable).toBe(true);
    expect(ann.confirmation_required).toBe(true);
    expect(ann.alternative).toBe("confirmation_token");
  });

  test("buildIrreversibleWritePlan tokens verify round-trip", async () => {
    const plan = buildIrreversibleWritePlan({ model: "account.move", method: "action_post", ids: [3, 1] });
    const token = await issueConfirmationToken(plan, SECRET, 1_000_000);
    expect(await verifyConfirmationToken(token, plan, SECRET, 1_000_000)).toBe("valid");
    // ids are sorted in the signed plan — order must not matter for callers after sort
    const planReordered = buildIrreversibleWritePlan({ model: "account.move", method: "action_post", ids: [1, 3] });
    expect(await verifyConfirmationToken(token, planReordered, SECRET, 1_000_000)).toBe("valid");
  });
});

describe("Odoo-ACL-denial surfaced verbatim", () => {
  test("permission_denied envelope keeps Odoo details and names refusing_layer", () => {
    const odooMessage = "You are not allowed to modify 'Journal Entry' (account.move) records.";
    const err = new OdooError({
      message: odooMessage,
      code: "permission_denied",
      httpStatus: 403,
      model: "account.move",
      method: "write",
      details: odooMessage
    });
    expect(classifyRefusingLayer(err)).toBe("odoo_acl");

    const result = mcpErrorFromException(err, { model: "account.move", method: "write", record_ids: [42] });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("permission_denied");
    expect(envelope.details).toBe(odooMessage);
    expect(envelope.odoo_exception).toBe(odooMessage);
    expect(envelope.refusing_layer).toBe("odoo_acl");
    expect(envelope.next_step).toBeTruthy();
    expect(envelope.record_ids).toEqual([42]);
  });

  test("hash / lock / workflow layers classify from Odoo details", () => {
    expect(
      classifyRefusingLayer(
        new OdooError({
          message: "x",
          code: "invalid_request",
          httpStatus: 400,
          model: "account.move",
          method: "button_draft",
          details: "You cannot modify a hashed entry."
        })
      )
    ).toBe("hash");

    expect(
      classifyRefusingLayer(
        new OdooError({
          message: "x",
          code: "invalid_request",
          httpStatus: 400,
          model: "account.move",
          method: "action_post",
          details: "You cannot create entries prior to and inclusive of the lock date 2026-01-31."
        })
      )
    ).toBe("lock_date");

    expect(
      classifyRefusingLayer(
        new OdooError({
          message: "x",
          code: "invalid_request",
          httpStatus: 400,
          model: "account.move",
          method: "write",
          details: "You cannot modify a posted entry."
        })
      )
    ).toBe("workflow_state");
  });

  test("Odoo ACL denial on update_record is returned verbatim (not connector policy)", async () => {
    const odooMessage = "Access Denied: missing write rights on account.move";
    const queue = dispatchQueue(() => {
      throw new OdooError({
        message: odooMessage,
        code: "permission_denied",
        httpStatus: 403,
        model: "account.move",
        method: "write",
        details: odooMessage
      });
    });
    const { updateRecord } = buildHandlers(queue);
    const result = await updateRecord({
      model: "account.move",
      record_id: 5,
      values: { ref: "X" },
      context: "correct draft"
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.refusing_layer).toBe("odoo_acl");
    expect(envelope.details).toBe(odooMessage);
    expect(envelope.error).toBe("permission_denied");
    expect(envelope.policy_rule).toBeUndefined();
  });
});

describe("refusal envelope always names layer + next_step", () => {
  test("connector confirmation preflight includes refusing_layer and next_step", async () => {
    const queue = dispatchQueue(() => true);
    const { callModelMethod } = buildHandlers(queue);
    const result = await callModelMethod({ model: "hr.expense", method: "action_post", ids: [1] });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.refusing_layer).toBe("connector_policy");
    expect(envelope.next_step).toBeTruthy();
  });
});

describe("extractRejectedFields — refusals name the field Odoo rejected", () => {
  test("extracts the field from Odoo's common schema/validation messages", () => {
    const cases: [string, string[]][] = [
      ["Invalid field 'parent_idd' on model 'product.category'", ["parent_idd"]],
      ["Unknown field \"usage\" in domain", ["usage"]],
      ["ValueError: Wrong value for product.category.property_cost_method: 'nope'", ["property_cost_method"]],
      ['null value in column "name" violates not-null constraint', ["name"]],
      ["Invalid field stock.location.locationn_id in leaf", ["locationn_id"]]
    ];
    for (const [details, expected] of cases) {
      expect(extractRejectedFields(details)).toEqual(expected);
    }
  });

  test("names nothing when the message names no field (never invents one)", () => {
    expect(extractRejectedFields("Access Denied by Odoo")).toEqual([]);
    expect(extractRejectedFields("You cannot modify a posted entry.")).toEqual([]);
    expect(extractRejectedFields("")).toEqual([]);
  });

  test("prose is not mistaken for a field name (unquoted, unqualified words are ignored)", () => {
    expect(extractRejectedFields("Invalid field name in domain")).toEqual([]);
    expect(extractRejectedFields("Unknown field type requested")).toEqual([]);
  });

  test("mcpErrorFromException surfaces the field alongside layer and next_step", () => {
    const details = "Invalid field 'parent_idd' on model 'product.category'";
    const err = new OdooError({
      message: details,
      code: "invalid_request",
      httpStatus: 400,
      model: "product.category",
      method: "create",
      details
    });
    const envelope = JSON.parse(mcpErrorFromException(err, { model: "product.category", method: "create" }).content[0].text);
    expect(envelope.refusing_layer).toBe("schema");
    expect(envelope.next_step).toBeTruthy();
    expect(envelope.blocked_fields).toEqual(["parent_idd"]);
  });
});
