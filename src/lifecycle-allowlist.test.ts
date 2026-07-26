/**
 * Unit tests for the reversible-lifecycle allowlist matrix (no Odoo I/O).
 */
import { describe, expect, test } from "bun:test";
import {
  annotateActionExecutability,
  getHighRiskMethodRule,
  getReversibleLifecycleRule,
  isCompatibleLifecycleState,
  isCompatibleMoveType,
  isHighRiskMethod,
  isReversibleLifecycleMethod,
  isSensitiveModelCrudMethod,
  REVERSIBLE_LIFECYCLE_ALLOWLIST
} from "./lifecycle-allowlist";

describe("REVERSIBLE_LIFECYCLE_ALLOWLIST matrix", () => {
  test("includes expense line reset/submit/approve", () => {
    expect(isReversibleLifecycleMethod("hr.expense", "action_reset")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense", "action_submit")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense", "action_approve")).toBe(true);
  });

  test("includes expense sheet curated methods", () => {
    expect(isReversibleLifecycleMethod("hr.expense.sheet", "action_reset_expense_sheets")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense.sheet", "action_submit_sheet")).toBe(true);
    expect(isReversibleLifecycleMethod("hr.expense.sheet", "action_approve_expense_sheets")).toBe(true);
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

  test("from_states and move_type constraints are coherent", () => {
    const reset = getReversibleLifecycleRule("hr.expense", "action_reset")!;
    expect(isCompatibleLifecycleState(reset, "approved")).toBe(true);
    expect(isCompatibleLifecycleState(reset, "draft")).toBe(false);

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
  test("action_post on account.move is irreversible_posting", () => {
    const rule = getHighRiskMethodRule("account.move", "action_post");
    expect(rule?.risk_class).toBe("irreversible_posting");
    expect(rule?.policy_rule).toBe("high_risk_method");
    expect(rule?.alternative).toContain("bookkeeping");
  });

  test("payment post/cancel stay high-risk", () => {
    expect(isHighRiskMethod("account.payment", "action_post")).toBe(true);
    expect(isHighRiskMethod("account.payment", "action_cancel")).toBe(true);
  });
});

describe("annotateActionExecutability", () => {
  test("allowlisted lifecycle is executable", () => {
    expect(annotateActionExecutability("hr.expense", "action_reset")).toMatchObject({
      executable: true,
      risk_class: "reversible_lifecycle"
    });
  });

  test("action_post is non-executable with alternative", () => {
    const ann = annotateActionExecutability("account.move", "action_post");
    expect(ann.executable).toBe(false);
    expect(ann.deny_reason).toBeTruthy();
    expect(ann.alternative).toContain("bookkeeping");
    expect(ann.risk_class).toBe("irreversible_posting");
  });

  test("unknown sensitive method fails closed", () => {
    const ann = annotateActionExecutability("account.move", "button_something_custom");
    expect(ann.executable).toBe(false);
    expect(ann.deny_reason).toContain("allowlist");
  });
});
