/**
 * Unit tests for the reversible-lifecycle allowlist matrix (no Odoo I/O).
 *
 * Vocab evidence (upstream odoo/odoo addons/hr_expense, checked 2026-07-26):
 * - 17.0 / 18.0: hr.expense.sheet present; sheet states draft/submit/approve/post/done/cancel;
 *   expense line states include reported ("To Submit").
 * - 19.0: sheet removed; hr.expense states draft/submitted/approved/posted/in_payment/paid/refused;
 *   action_reset/_submit/_approve on the expense line; no reported in selection.
 */
import { describe, expect, test } from "bun:test";
import {
  annotateSensitiveModelActionExecutability,
  getHighRiskMethodRule,
  getReversibleLifecycleRule,
  isCompatibleLifecycleState,
  isCompatibleMoveType,
  isHighRiskMethod,
  isReversibleLifecycleMethod,
  isSensitiveModelCrudMethod,
  REVERSIBLE_LIFECYCLE_ALLOWLIST
} from "./lifecycle-allowlist";
import { annotateActionExecutability } from "./write-safety";

describe("REVERSIBLE_LIFECYCLE_ALLOWLIST matrix", () => {
  test("includes expense line reset/submit/approve", () => {
    expect(isReversibleLifecycleMethod("hr.expense", "action_reset")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense", "action_submit")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense", "action_approve")).toBe(true);
  });

  test("includes expense sheet curated methods (pre-19)", () => {
    expect(isReversibleLifecycleMethod("hr.expense.sheet", "action_reset_expense_sheets")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense.sheet", "action_submit_sheet")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense.sheet", "action_approve_expense_sheets")).toBe(true);
    for (const method of [
      "action_reset_expense_sheets",
      "action_submit_sheet",
      "action_approve_expense_sheets"
    ]) {
      expect(getReversibleLifecycleRule("hr.expense.sheet", method)?.version_note).toMatch(/Odoo 19/);
    }
  });

  test("includes account.move button_draft only (not action_post)", () => {
    expect(isReversibleLifecycleMethod("account.move", "button_draft")).toBe(true);
    expect(isReversibleLifecycleMethod("account.move", "action_post")).toBe(false);
    expect(isHighRiskMethod("account.move", "action_post")).toBe(true);
  });

  test("never allowlists CRUD", () => {
    for (const model of ["hr.expense", "account.move", "hr.expense.sheet"]) {
      for (const method of ["create", "write", "unlink"]) {
        expect(isReversibleLifecycleMethod(model, method)).toBe(false);
        expect(isSensitiveModelCrudMethod(method)).toBe(true);
      }
    }
  });

  test("expense reset from_states: submitted/approved/refused + legacy reported", () => {
    const reset = getReversibleLifecycleRule("hr.expense", "action_reset")!;
    expect(reset.from_states).toEqual(["submitted", "approved", "refused", "reported"]);
    expect(isCompatibleLifecycleState(reset, "approved")).toBe(true);
    expect(isCompatibleLifecycleState(reset, "refused")).toBe(true);
    expect(isCompatibleLifecycleState(reset, "reported")).toBe(true);
    expect(isCompatibleLifecycleState(reset, "draft")).toBe(false);
    expect(isCompatibleLifecycleState(reset, "posted")).toBe(false);
  });

  test("from_states and move_type constraints are coherent", () => {
    const submit = getReversibleLifecycleRule("hr.expense", "action_submit")!;
    expect(isCompatibleLifecycleState(submit, "draft")).toBe(true);
    expect(isCompatibleLifecycleState(submit, "submitted")).toBe(false);

    const draft = getReversibleLifecycleRule("account.move", "button_draft")!;
    expect(isCompatibleLifecycleState(draft, "posted")).toBe(true);
    expect(isCompatibleMoveType(draft, "in_invoice")).toBe(true);
    expect(isCompatibleMoveType(draft, "out_invoice")).toBe(false);
  });

  test("every allowlist entry has reversible_lifecycle risk_class", () => {
    for (const rule of REVERSIBLE_LIFECYCLE_ALLOWLIST) {
      expect(rule.risk_class).toBe("reversible_lifecycle");
      expect(rule.policy_rule).toBe("lifecycle_allowlist");
      expect(rule.from_states.length).toBeGreaterThan(0);
    }
  });
});

describe("high-risk denylist", () => {
  test("action_post on account.move routes to human/UI — not plan_safe_write", () => {
    const rule = getHighRiskMethodRule("account.move", "action_post");
    expect(rule?.risk_class).toBe("irreversible_posting");
    expect(rule?.policy_rule).toBe("high_risk_method");
    expect(rule?.alternative).toBe("human / Odoo UI");
    expect(rule?.next_step).toMatch(/Odoo UI/i);
    expect(rule?.next_step).toMatch(/cannot post/i);
    expect(rule?.alternative).not.toContain("plan_safe_write");
  });

  test("pattern-matched posting does not suggest plan_safe_write; lock does", () => {
    const post = getHighRiskMethodRule("account.bank.statement", "action_post");
    expect(post?.alternative).toBe("human / Odoo UI");
    expect(post?.alternative).not.toContain("plan_safe_write");

    const lock = getHighRiskMethodRule("account.move", "button_set_lock");
    expect(lock?.risk_class).toBe("lock_sensitive");
    expect(lock?.alternative).toBe("bookkeeping.plan_safe_write");
  });

  test("payment post/cancel stay high-risk", () => {
    expect(isHighRiskMethod("account.payment", "action_post")).toBe(true);
    expect(isHighRiskMethod("account.payment", "action_cancel")).toBe(true);
  });
});

describe("annotateActionExecutability (write-gate aligned)", () => {
  test("allowlisted lifecycle is executable", () => {
    expect(annotateActionExecutability("hr.expense", "action_reset")).toMatchObject({
      executable: true,
      risk_class: "reversible_lifecycle"
    });
  });

  test("action_post is non-executable with human/UI alternative", () => {
    const ann = annotateActionExecutability("account.move", "action_post");
    expect(ann.executable).toBe(false);
    expect(ann.deny_reason).toBeTruthy();
    expect(ann.alternative).toBe("human / Odoo UI");
    expect(ann.alternative).not.toContain("plan_safe_write");
    expect(ann.risk_class).toBe("irreversible_posting");
  });

  test("unknown sensitive method fails closed", () => {
    const ann = annotateActionExecutability("account.move", "button_something_custom");
    expect(ann.executable).toBe(false);
    expect(ann.deny_reason).toContain("allowlist");
    expect(ann.policy_rule).toBe("sensitive_model_method_denied");
  });

  test("non-sensitive sale.order is not annotated with sensitive_model_method_denied", () => {
    const ann = annotateActionExecutability("sale.order", "action_confirm");
    expect(ann.executable).toBe(false);
    expect(ann.policy_rule).toBeUndefined();
    expect(ann.deny_reason).toBeTruthy();
    expect(ann.deny_reason).not.toMatch(/reversible-lifecycle allowlist/i);
    expect(ann.alternative ?? "").not.toMatch(/billing\./);
  });

  test("sensitive annotator helper matches high-risk metadata", () => {
    expect(annotateSensitiveModelActionExecutability("account.move", "action_post").alternative).toBe(
      "human / Odoo UI"
    );
  });
});
