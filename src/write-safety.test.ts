/**
 * Write-safety TDD contract tests for odoo-mcp (#1517 / #1715).
 *
 * These tests encode the PM write-safety classifier contract only. Production
 * implementation is delivered in sibling subtasks — do not implement here:
 *   - `assessWriteOperation` → `src/write-safety.ts`
 *   - `gateWrite` (pre-enqueue gate) → `src/tools/write.ts`
 *   - `mcpWriteBlockedError` (blocked JSON envelope) → `src/tools/shared.ts`
 *
 * Out of scope for this file: production write routing, `bookkeeping.plan_safe_write`,
 * and read tools. Classification is structural (model + method + field names), never
 * free-text finance-keyword blocking on allowed PM models.
 */
import { describe, test, expect } from "bun:test";
import { assessWriteOperation, isMutatingOdooMethod } from "./write-safety";
import { FINANCE_KEYWORD_PM_TEXT } from "./write-safety.fixtures";

describe("assessWriteOperation — project management text is never keyword-blocked", () => {
  test("project.task description mentioning banking and B2C export deadline is allowed", () => {
    const verdict = assessWriteOperation({
      model: "project.task",
      method: "write",
      args: {
        vals: { description: FINANCE_KEYWORD_PM_TEXT.taskDescription }
      }
    });
    expect(verdict).toEqual({ allowed: true, intent: "project_management" });
  });

  test("mail.activity note with operational banking context is allowed", () => {
    const verdict = assessWriteOperation({
      model: "mail.activity",
      method: "create",
      args: {
        vals_list: [
          {
            res_model: "project.task",
            res_id: 42,
            summary: "CEO follow-up",
            note: "Confirm B2C bank export cutoff and payroll handoff timeline with Valentin.",
            activity_type_id: 4,
            user_id: 7,
            date_deadline: "2026-07-15"
          }
        ]
      }
    });
    expect(verdict).toEqual({ allowed: true, intent: "project_management" });
  });

  test("project.task message_post body with tax and bank references is allowed", () => {
    const verdict = assessWriteOperation({
      model: "project.task",
      method: "message_post",
      args: {
        ids: [42],
        body: "USL Admin cleanup: banking ops + VAT return prep — deadline Friday."
      }
    });
    expect(verdict).toEqual({ allowed: true, intent: "project_management" });
  });

  test("project.project message_post with long operational note is allowed", () => {
    const verdict = assessWriteOperation({
      model: "project.project",
      method: "message_post",
      args: { ids: [3], body: "Legal review of partner contract terms deferred until tax close." }
    });
    expect(verdict).toEqual({ allowed: true, intent: "project_management" });
  });
});

describe("assessWriteOperation — financial mutations are blocked", () => {
  test("account.move write is blocked", () => {
    const verdict = assessWriteOperation({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { ref: "INV/001" } }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("financial_mutation");
    expect(verdict.reason).toContain("bookkeeping.plan_safe_write");
  });

  test("res.partner write is blocked as external-party mutation", () => {
    const verdict = assessWriteOperation({
      model: "res.partner",
      method: "write",
      args: { ids: [5], vals: { name: "Acme" } }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("financial_mutation");
  });

  test("project.task write with sale_line_id is blocked", () => {
    const verdict = assessWriteOperation({
      model: "project.task",
      method: "write",
      args: { ids: [7], vals: { sale_line_id: 99 } }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("financial_mutation");
    expect(verdict.blocked_fields).toContain("sale_line_id");
  });

  test("mail.activity on account.move is blocked", () => {
    const verdict = assessWriteOperation({
      model: "mail.activity",
      method: "create",
      args: {
        vals_list: [{ res_model: "account.move", res_id: 1, summary: "Review", note: "Check invoice" }]
      }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("financial_mutation");
    expect(verdict.reason).toContain("project.task");
  });

  test("payment.order create is blocked", () => {
    const verdict = assessWriteOperation({
      model: "payment.order",
      method: "create",
      args: { vals_list: [{ name: "SEPA batch" }] }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("financial_mutation");
  });
});

describe("assessWriteOperation — PM field allowlist", () => {
  test("project.task create with standard triage fields is allowed", () => {
    const verdict = assessWriteOperation({
      model: "project.task",
      method: "create",
      args: {
        vals_list: [
          {
            name: "Valentin follow-up",
            project_id: 2,
            stage_id: 3,
            user_ids: [[6, 0, [7]]],
            date_deadline: "2026-07-10",
            priority: "1"
          }
        ]
      }
    });
    expect(verdict).toEqual({ allowed: true, intent: "project_management" });
  });

  test("mail.activity action_feedback is allowed", () => {
    const verdict = assessWriteOperation({
      model: "mail.activity",
      method: "action_feedback",
      args: { ids: [12], feedback: "Done — banking export sent." }
    });
    expect(verdict).toEqual({ allowed: true, intent: "project_management" });
  });

  test("non-allowlisted model write is disallowed", () => {
    const verdict = assessWriteOperation({
      model: "sale.order",
      method: "write",
      args: { ids: [1], vals: { note: "PM note only" } }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("disallowed");
  });

  test("mail.activity create without res_model is disallowed", () => {
    const verdict = assessWriteOperation({
      model: "mail.activity",
      method: "create",
      args: {
        vals_list: [
          {
            summary: "CEO follow-up",
            note: "Banking export deadline with Valentin.",
            activity_type_id: 4,
            user_id: 7
          }
        ]
      }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("disallowed");
    expect(verdict.reason).toContain("res_model");
  });

  test("non-allowlisted model message_post is disallowed", () => {
    const verdict = assessWriteOperation({
      model: "sale.order",
      method: "message_post",
      args: { ids: [1], body: "Operational note about banking deadline." }
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.intent).toBe("disallowed");
  });
});

describe("assessWriteOperation — structure over content (negative control)", () => {
  test("identical finance-keyword text is allowed on project.task but blocked on account.move", () => {
    const pmVerdict = assessWriteOperation({
      model: "project.task",
      method: "write",
      args: { ids: [990], vals: { description: FINANCE_KEYWORD_PM_TEXT.chatterBody } }
    });
    expect(pmVerdict).toEqual({ allowed: true, intent: "project_management" });

    const ledgerVerdict = assessWriteOperation({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { narration: FINANCE_KEYWORD_PM_TEXT.chatterBody } }
    });
    expect(ledgerVerdict.allowed).toBe(false);
    expect(ledgerVerdict.intent).toBe("financial_mutation");
  });
});

describe("isMutatingOdooMethod", () => {
  test("read paths are not mutating", () => {
    expect(isMutatingOdooMethod("read")).toBe(false);
    expect(isMutatingOdooMethod("search_read")).toBe(false);
    expect(isMutatingOdooMethod("fields_get")).toBe(false);
  });

  test("write paths are mutating", () => {
    expect(isMutatingOdooMethod("write")).toBe(true);
    expect(isMutatingOdooMethod("action_post")).toBe(true);
    expect(isMutatingOdooMethod("message_post")).toBe(true);
  });
});
