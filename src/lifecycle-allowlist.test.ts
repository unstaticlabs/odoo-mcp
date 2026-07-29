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
  excludedStateHint,
  failedGuardFields,
  getHighRiskMethodRule,
  getReversibleLifecycleRule,
  lifecycleReadFields,
  isCompatibleLifecycleState,
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

  test("from_states allow posted reset on account.move; expense submit stays draft-only", () => {
    const submit = getReversibleLifecycleRule("hr.expense", "action_submit")!;
    expect(isCompatibleLifecycleState(submit, "draft")).toBe(true);
    expect(isCompatibleLifecycleState(submit, "submitted")).toBe(false);

    const draft = getReversibleLifecycleRule("account.move", "button_draft")!;
    // Posted reset is allowlisted — Odoo enforces hash/lock (#2201).
    expect(isCompatibleLifecycleState(draft, "posted")).toBe(true);
    expect(isCompatibleLifecycleState(draft, "cancel")).toBe(true);
    expect(draft.require_move_types).toBeUndefined();
  });

  test("expense lifecycle rules never transition out of posted/paid; button_draft may reset posted moves", () => {
    const LEDGER_STATES = ["posted", "in_payment", "paid", "done"];
    for (const rule of REVERSIBLE_LIFECYCLE_ALLOWLIST) {
      if (rule.model === "account.move" && rule.method === "button_draft") {
        expect(isCompatibleLifecycleState(rule, "posted")).toBe(true);
        continue;
      }
      for (const state of LEDGER_STATES) {
        expect(isCompatibleLifecycleState(rule, state)).toBe(false);
      }
    }
  });

  test("read projection carries state and guard fields for the rule that needs them", () => {
    const reset = getReversibleLifecycleRule("hr.expense", "action_reset")!;
    const draft = getReversibleLifecycleRule("account.move", "button_draft")!;
    const submit = getReversibleLifecycleRule("hr.expense", "action_submit")!;
    expect(lifecycleReadFields(reset)).toEqual(["id", "state", "can_reset"]);
    expect(lifecycleReadFields(draft)).toEqual(["id", "state"]);
    expect(lifecycleReadFields(submit)).toEqual(["id", "state"]);
  });

  test("guard fields fail only when present and falsy — absent means not applicable", () => {
    const reset = getReversibleLifecycleRule("hr.expense", "action_reset")!;
    expect(failedGuardFields(reset, { id: 1, state: "approved", can_reset: true })).toEqual([]);
    expect(failedGuardFields(reset, { id: 1, state: "approved", can_reset: false })).toEqual(["can_reset"]);
    // Older Odoo without the field: skipped, never treated as a refusal.
    expect(failedGuardFields(reset, { id: 1, state: "approved" })).toEqual([]);
  });

  test("posted expense records get an explicit human-only hint instead of a bare state list", () => {
    const rule = REVERSIBLE_LIFECYCLE_ALLOWLIST.find((r) => r.model === "hr.expense" && /reset/.test(r.method))!;
    expect(excludedStateHint(rule, "posted")).toContain("Odoo UI");
  });

  test("every allowlist entry has reversible_lifecycle risk_class", () => {
    for (const rule of REVERSIBLE_LIFECYCLE_ALLOWLIST) {
      expect(rule.risk_class).toBe("reversible_lifecycle");
      expect(rule.policy_rule).toBe("lifecycle_allowlist");
      expect(rule.from_states.length).toBeGreaterThan(0);
    }
  });
});

describe("high-risk confirmation catalog", () => {
  test("action_post on account.move requires confirmation_token — not plan_safe_write", () => {
    const rule = getHighRiskMethodRule("account.move", "action_post");
    expect(rule?.risk_class).toBe("irreversible_posting");
    expect(rule?.policy_rule).toBe("high_risk_method");
    expect(rule?.alternative).toBe("confirmation_token");
    expect(rule?.next_step).toMatch(/confirmation/i);
    expect(rule?.alternative).not.toContain("plan_safe_write");
  });

  test("pattern-matched posting and lock both use confirmation_token", () => {
    const post = getHighRiskMethodRule("account.bank.statement", "action_post");
    expect(post?.alternative).toBe("confirmation_token");
    expect(post?.alternative).not.toContain("plan_safe_write");

    const lock = getHighRiskMethodRule("account.move", "button_set_lock");
    expect(lock?.risk_class).toBe("lock_sensitive");
    expect(lock?.alternative).toBe("confirmation_token");
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

  test("action_post is executable with confirmation_required", () => {
    const ann = annotateActionExecutability("account.move", "action_post");
    expect(ann.executable).toBe(true);
    expect(ann.confirmation_required).toBe(true);
    expect(ann.deny_reason).toBeTruthy();
    expect(ann.alternative).toBe("confirmation_token");
    expect(ann.alternative).not.toContain("plan_safe_write");
    expect(ann.risk_class).toBe("irreversible_posting");
  });

  test("unknown reversible method on accounting model is executable under Odoo authority", () => {
    const ann = annotateActionExecutability("account.move", "button_something_custom");
    expect(ann.executable).toBe(true);
    expect(ann.risk_class).toBe("reversible_lifecycle");
  });

  test("non-sensitive sale.order is not annotated with sensitive_model_method_denied", () => {
    const ann = annotateActionExecutability("sale.order", "action_confirm");
    expect(ann.executable).toBe(false);
    expect(ann.policy_rule).toBeUndefined();
    expect(ann.deny_reason).toBeTruthy();
    expect(ann.deny_reason).not.toMatch(/reversible-lifecycle allowlist/i);
    expect(ann.alternative ?? "").not.toMatch(/billing\./);
  });

  test("sensitive annotator helper marks high-risk as confirmation_required", () => {
    expect(annotateSensitiveModelActionExecutability("account.move", "action_post").alternative).toBe(
      "confirmation_token"
    );
    expect(annotateSensitiveModelActionExecutability("account.move", "action_post").confirmation_required).toBe(true);
  });
});
