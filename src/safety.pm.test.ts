import { describe, expect, test } from "bun:test";
import { classifyPmWriteIntent, planIssuesToken, PM_MODEL_ALLOWLIST } from "./safety";

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
  test("account.move write is financial_mutation with billing + bookkeeping guidance", () => {
    const result = classifyPmWriteIntent({
      model: "account.move",
      method: "write",
      args: { ids: [1], vals: { ref: "INV/001" } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("financial_mutation");
    expect(result.reason).toContain("billing.");
    expect(result.reason).toContain("bookkeeping.plan_safe_write");
  });

  test("hr.expense write is financial_mutation with billing guidance", () => {
    const result = classifyPmWriteIntent({
      model: "hr.expense",
      method: "write",
      args: { ids: [394], vals: { date: "2026-07-04" } }
    });
    expect(result.verdict).toBe("denied");
    expect(result.intent).toBe("financial_mutation");
    expect(result.reason).toContain("billing.update_draft_expense");
  });

  test("hr.employee write is financial_mutation (any hr.* prefix)", () => {
    const result = classifyPmWriteIntent({
      model: "hr.employee",
      method: "write",
      args: { ids: [3], vals: { name: "Alice" } }
    });
    expect(result).toMatchObject({ verdict: "denied", intent: "financial_mutation" });
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

describe("classifyPmWriteIntent — bookkeeping isolation", () => {
  test("PM_MODEL_ALLOWLIST contains only project.task and mail.activity", () => {
    expect([...PM_MODEL_ALLOWLIST].sort()).toEqual(["mail.activity", "project.task"]);
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
