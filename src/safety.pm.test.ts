import { describe, expect, test } from "bun:test";
import {
  classifyPmWriteIntent,
  planIssuesToken,
  PM_MODEL_ALLOWLIST,
  taskValsRequestWaitingState
} from "./safety";

describe("classifyPmWriteIntent — finance-keyword prose must not affect verdict", () => {
  test("project.task write with description mentioning banking, B2C export, month-end close is allowed", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: {
        vals: {
          description:
            "Follow up with Valentin on banking file reconciliation and the B2C export deadline before month-end close."
        }
      }
    });
    expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
  });

  test("project.task write with name containing VAT deadline is allowed", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: { vals: { name: "VAT deadline — banking export prep" } }
    });
    expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
  });

  test("project.task message_post with body referencing tax/bank/deadline is allowed", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "message_post",
      args: {
        ids: [42],
        body: "USL Admin cleanup: banking ops + VAT return prep — deadline Friday."
      }
    });
    expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
  });

  test("mail.activity create on project.task with payroll/banking note is allowed", () => {
    const result = classifyPmWriteIntent({
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
    expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
  });

  test("same verdict when prose body is swapped between benign and finance-heavy text", () => {
    const benign = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: { vals: { description: "Weekly sync notes for the engineering team." } }
    });
    const financeHeavy = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: {
        vals: {
          description:
            "Banking reconciliation, payroll handoff, VAT filing, B2C export, and month-end close deadlines."
        }
      }
    });
    expect(benign).toEqual(financeHeavy);
    expect(benign.verdict).toBe("allowed");
  });
});

describe("classifyPmWriteIntent — structural deny paths", () => {
  test("account.move write is allowed as reversible configuration (no prefix deny)", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { ref: "INV/001" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.intent).toBe("financial_mutation");
    expect(result.risk_class).toBe("reversible_configuration");
  });

  test("hr.expense write is allowed as reversible configuration (no prefix deny)", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "write",
      args: { ids: [394], vals: { date: "2026-07-04" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.intent).toBe("financial_mutation");
    expect(result.risk_class).toBe("reversible_configuration");
  });

  test("hr.employee write is allowed (no longer refused solely by hr.* prefix)", () => {
    const result = classifyPmWriteIntent({
      model: "hr.employee",
      method: "write",
      args: { ids: [3], vals: { name: "Alice" } }
    });
    expect(result).toMatchObject({ verdict: "allowed", intent: "financial_mutation" });
  });

  test("res.partner write with bank_ids is denied as financial field", () => {
    const result = classifyPmWriteIntent({
      model: "res.partner",
      method: "write",
      args: { ids: [5], vals: { bank_ids: [[0, 0, [{ acc_number: "FR123" }]]] } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("financial_mutation");
    expect(result.blocked_fields).toContain("bank_ids");
    expect(result.reason).not.toContain("bookkeeping.plan_safe_write");
    expect(result.next_step).not.toContain("bookkeeping.plan_safe_write");
  });

  test("res.partner create/write with VAT identity fields is allowed", () => {
    const create = classifyPmWriteIntent({
      model: "res.partner",
      method: "create",
      args: {
        vals_list: [
          {
            name: "SARL Fournisseur",
            vat: "FR12345678901",
            siret: "12345678900012",
            company_registry: "123456789",
            country_id: 75
          }
        ]
      }
    });
    expect(create).toMatchObject({
      verdict: "allowed",
      intent: "financial_mutation",
      policy_rule: "reversible_configuration"
    });

    const write = classifyPmWriteIntent({
      model: "res.partner",
      method: "write",
      args: { ids: [5], vals: { vat: "FR12345678901", name: "SARL Fournisseur" } }
    });
    expect(write).toMatchObject({
      verdict: "allowed",
      intent: "financial_mutation",
      policy_rule: "reversible_configuration"
    });
  });

  test("res.partner write with property accounts / credit_limit stays denied", () => {
    const payable = classifyPmWriteIntent({
      model: "res.partner",
      method: "write",
      args: { ids: [5], vals: { property_account_payable_id: 42 } }
    });
    expect(payable.verdict).toBe("denied");
    expect(payable.blocked_fields).toContain("property_account_payable_id");
    expect(payable.reason).not.toContain("bookkeeping.plan_safe_write");

    const limit = classifyPmWriteIntent({
      model: "res.partner",
      method: "write",
      args: { ids: [5], vals: { credit_limit: 1000 } }
    });
    expect(limit.verdict).toBe("denied");
    expect(limit.blocked_fields).toContain("credit_limit");
  });

  test("mail.activity create with res_model account.move is denied", () => {
    const result = classifyPmWriteIntent({
      model: "mail.activity",
      method: "create",
      args: {
        vals_list: [{ res_model: "account.move", res_id: 1, summary: "Review", note: "Check invoice" }]
      }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("financial_mutation");
    expect(result.reason).toContain("project.task");
  });

  test("mail.activity create without res_model is disallowed", () => {
    const result = classifyPmWriteIntent({
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
    expect(result).toMatchObject({ verdict: "denied", intent: "disallowed" });
    expect(result.reason).toContain("res_model");
  });

  test("project.task write with sale_line_id is denied with blocked_fields", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: { ids: [7], vals: { sale_line_id: 99 } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("financial_mutation");
    expect(result.blocked_fields).toContain("sale_line_id");
  });

  test("sale.order write is disallowed", () => {
    const result = classifyPmWriteIntent({
      model: "sale.order",
      method: "write",
      args: { ids: [1], vals: { note: "PM note only" } }
    });
    expect(result).toMatchObject({ verdict: "denied", intent: "disallowed" });
  });

  test("project.task write with unknown non-allowlisted field is denied with blocked_fields", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: { ids: [7], vals: { custom_studio_field: 1 } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("disallowed");
    expect(result.blocked_fields).toContain("custom_studio_field");
    expect(result.reason).toContain("non-PM");
  });

  test("mail.activity create with unknown non-allowlisted field is denied with blocked_fields", () => {
    const result = classifyPmWriteIntent({
      model: "mail.activity",
      method: "create",
      args: {
        vals_list: [
          {
            res_model: "project.task",
            res_id: 42,
            summary: "Follow-up",
            x_custom_priority_flag: true
          }
        ]
      }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("disallowed");
    expect(result.blocked_fields).toContain("x_custom_priority_flag");
    expect(result.reason).toContain("non-PM");
  });
});

describe("classifyPmWriteIntent — reversible lifecycle allowlist", () => {
  test("hr.expense action_reset is allowed as financial_mutation lifecycle", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "action_reset",
      args: { ids: [394] }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.intent).toBe("financial_mutation");
    expect(result.policy_rule).toBe("lifecycle_allowlist");
    expect(result.risk_class).toBe("reversible_lifecycle");
  });

  test("account.move action_post requires confirmation (not flat high-risk deny)", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "action_post",
      args: { ids: [1] }
    });
    expect(result.verdict).toBe("denied");
    expect(result.policy_rule).toBe("irreversible_confirmation_required");
    expect(result.risk_class).toBe("irreversible_posting");
    expect(result.next_step).toMatch(/confirmation/i);
  });

  test("hr.expense write CRUD is allowed as reversible configuration", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "write",
      args: { ids: [394], vals: { date: "2026-07-04" } }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_configuration");
  });

  test("unknown accounting method is allowed under Odoo authority", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "action_something_custom",
      args: { ids: [1] }
    });
    expect(result.verdict).toBe("allowed");
    expect(result.risk_class).toBe("reversible_lifecycle");
  });
});

describe("classifyPmWriteIntent — Waiting is derived, not written", () => {
  test("project.task create with state=04_waiting_normal is denied", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "create",
      args: { vals_list: [{ name: "Blocked work", project_id: 4, state: "04_waiting_normal" }] }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("project_management");
    expect(result.policy_rule).toBe("waiting_state_forbidden");
    expect(result.next_step).toContain("depend_on_ids");
    expect(result.recoverable).toBe(true);
  });

  test("project.task write with state=04_waiting_normal is denied", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: { ids: [42], vals: { state: "04_waiting_normal" } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.policy_rule).toBe("waiting_state_forbidden");
    expect(result.reason).toContain("04_waiting_normal");
  });

  test("one Waiting entry in a vals_list denies the whole batch", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "create",
      args: {
        vals_list: [
          { name: "Fine", project_id: 4 },
          { name: "Wedged", project_id: 4, state: "04_waiting_normal" }
        ]
      }
    });
    expect(result.policy_rule).toBe("waiting_state_forbidden");
  });

  test("taskValsRequestWaitingState only matches the Waiting value", () => {
    expect(taskValsRequestWaitingState([{ state: "04_waiting_normal" }])).toBe(true);
    expect(taskValsRequestWaitingState([{ state: "01_in_progress" }, { state: "1_done" }])).toBe(false);
    expect(taskValsRequestWaitingState([{ name: "no state here" }])).toBe(false);
  });

  test("other states stay writable by the pure classifier", () => {
    for (const state of ["01_in_progress", "1_done", "1_canceled", "03_approved"]) {
      const result = classifyPmWriteIntent({
        model: "project.task",
        method: "write",
        args: { ids: [42], vals: { state } }
      });
      expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
    }
  });

  test("state=01_in_progress without dependencies is allowed (open blockers are a stateful check)", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "create",
      args: { vals_list: [{ name: "Start now", project_id: 4, state: "01_in_progress" }] }
    });
    expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
  });

  test("stage / assignee / date / dependency writes without state are untouched", () => {
    const result = classifyPmWriteIntent({
      model: "project.task",
      method: "write",
      args: {
        ids: [42],
        vals: {
          stage_id: 7,
          user_ids: [[6, 0, [3]]],
          date_deadline: "2026-08-01",
          depend_on_ids: [[4, 99]]
        }
      }
    });
    expect(result).toEqual({ verdict: "allowed", intent: "project_management" });
  });
});

describe("classifyPmWriteIntent — inventory master data (exact-model graduation)", () => {
  for (const model of ["product.category", "stock.location"]) {
    test(`${model} create is allowed as reversible configuration`, () => {
      const result = classifyPmWriteIntent({
        model,
        method: "create",
        args: { vals_list: [{ name: "Consumables" }] }
      });
      expect(result.verdict).toBe("allowed");
      expect(result.intent).toBe("financial_mutation");
      expect(result.risk_class).toBe("reversible_configuration");
      expect(result.policy_rule).toBe("reversible_configuration");
    });

    test(`${model} write is allowed as reversible configuration`, () => {
      const result = classifyPmWriteIntent({
        model,
        method: "write",
        args: { ids: [4], vals: { name: "Renamed" } }
      });
      expect(result.verdict).toBe("allowed");
      expect(result.risk_class).toBe("reversible_configuration");
    });

    test(`${model} unlink still requires confirmation`, () => {
      const result = classifyPmWriteIntent({ model, method: "unlink", args: { ids: [4] } });
      expect(result.verdict).toBe("denied");
      expect(result.policy_rule).toBe("irreversible_confirmation_required");
      expect(result.risk_class).toBe("destructive");
      expect(result.next_step).toMatch(/confirmation/i);
    });
  }

  test("graduation is by exact model name — sibling product.* / stock.* stay default-denied", () => {
    for (const model of ["product.product", "product.template", "stock.picking", "stock.move", "stock.quant"]) {
      const result = classifyPmWriteIntent({
        model,
        method: "create",
        args: { vals_list: [{ name: "Widget" }] }
      });
      expect(result).toMatchObject({ verdict: "denied", intent: "disallowed" });
      expect(result.reason).toContain("not allowlisted");
    }
  });

  test("stock.valuation.layer stays action-classified via its existing prefix entry", () => {
    const result = classifyPmWriteIntent({
      model: "stock.valuation.layer",
      method: "write",
      args: { ids: [1], vals: { description: "adjust" } }
    });
    expect(result.verdict).toBe("allowed");
  });
});

describe("classifyPmWriteIntent — bookkeeping isolation", () => {
  test("PM_MODEL_ALLOWLIST contains only project.task and mail.activity", () => {
    expect([...PM_MODEL_ALLOWLIST].sort()).toEqual(["mail.activity", "project.task"]);
  });

  test("generic CRUD on ir.attachment stays denied — projects.attach_file is the only path", () => {
    for (const method of ["create", "write", "unlink"] as const) {
      const result = classifyPmWriteIntent({
        model: "ir.attachment",
        method,
        args: { ids: [1], vals: { name: "evidence.xlsx", res_model: "project.task", res_id: 42 } }
      });
      expect(result).toMatchObject({ verdict: "denied", intent: "disallowed" });
      expect(result.reason).toContain("are not allowlisted");
      expect(result.reason).toContain("project.task / mail.activity");
    }
  });

  test("bookkeeping.ts does not import classifyPmWriteIntent", async () => {
    const mod = await import("./tools/bookkeeping");
    expect("classifyPmWriteIntent" in mod).toBe(false);
    expect("PM_MODEL_ALLOWLIST" in mod).toBe(false);
  });

  test("planIssuesToken remains bookkeeping-only (no PM models in planner gate)", () => {
    expect(
      planIssuesToken({
        status: "safe",
        resolved_target: { model: "account.report.external.value" },
        existing_records: [],
        lock_dates: {},
        warnings: [],
        would_write: {
          model: "account.report.external.value",
          method: "create",
          values: { value: 1 }
        },
        duplicate_as_update: false
      })
    ).toBe(true);
  });
});
