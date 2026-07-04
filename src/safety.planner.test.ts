import { describe, expect, test } from "bun:test";
import type { LockDates } from "./safety";
import {
  planExternalValue,
  planIssuesToken,
  planLockException,
  planManualReturn,
  planPeriodicityUpdate
} from "./safety";

// French CA12 fixture: prior VAT credit 3442€ − refund 2500€ = net carryover 942€, booked on the
// last day of the return period (2025-09-30) against box_22._applied_carryover_balance (engine external).
const CA12 = {
  line: { id: 22, code: "box_22", name: "Report de crédit de TVA" },
  expression: { id: 220, label: "_applied_carryover_balance", engine: "external" as const },
  date: "2025-09-30",
  value: 942,
  name: "Applied carryover balance",
  period: { date_start: "2025-10-01", date_end: "2026-09-30" }, // return period covering 2025-09-30
  fkField: "target_report_expression_id"
};

function externalInput(overrides: Partial<Parameters<typeof planExternalValue>[0]> = {}) {
  return {
    values: {
      report_line_code: CA12.line.code,
      expression_label: CA12.expression.label,
      date: CA12.date,
      value: CA12.value,
      name: CA12.name
    },
    line: CA12.line,
    expression: CA12.expression,
    fkField: CA12.fkField,
    existingValues: [] as Array<{ id: number; date?: unknown }>,
    lockDates: {} as LockDates,
    period: CA12.period,
    ...overrides
  };
}

describe("planExternalValue", () => {
  test("happy path → safe with a create would_write and a token", () => {
    const plan = planExternalValue(externalInput());
    expect(plan.status).toBe("safe");
    expect(plan.would_write).toEqual({
      model: "account.report.external.value",
      method: "create",
      values: { name: CA12.name, [CA12.fkField]: CA12.expression.id, date: CA12.date, value: CA12.value }
    });
    expect(plan.existing_records).toEqual([]);
    expect(planIssuesToken(plan)).toBe(true);
  });

  test("duplicate → duplicate_found resolving to an update (token issued)", () => {
    const dup = { id: 999, date: "2025-09-30", value: 500 };
    const plan = planExternalValue(externalInput({ existingValues: [dup] }));
    expect(plan.status).toBe("duplicate_found");
    expect(plan.would_write).toEqual({
      model: "account.report.external.value",
      method: "write",
      id: 999,
      values: { value: CA12.value, name: CA12.name }
    });
    expect(plan.existing_records).toEqual([dup]);
    expect(plan.duplicate_as_update).toBe(true);
    expect(planIssuesToken(plan)).toBe(true);
  });

  test("hard lock on the carryover date → blocked, no token", () => {
    const plan = planExternalValue(externalInput({ lockDates: { hard_lock_date: "2025-12-31" } }));
    expect(plan.status).toBe("blocked");
    expect(planIssuesToken(plan)).toBe(false);
    expect(plan.warnings.join(" ")).toContain("hard_lock_date");
  });

  test("soft (tax) lock → needs_lock_exception, no token", () => {
    const plan = planExternalValue(externalInput({ lockDates: { tax_lock_date: "2025-12-31" } }));
    expect(plan.status).toBe("needs_lock_exception");
    expect(planIssuesToken(plan)).toBe(false);
    expect(plan.warnings.join(" ")).toContain("tax_lock_date");
  });

  test("non-external engine → blocked with an engine-mismatch warning", () => {
    const plan = planExternalValue(externalInput({ expression: { id: 220, label: CA12.expression.label, engine: "tax_tags" } }));
    expect(plan.status).toBe("blocked");
    expect(plan.warnings.join(" ")).toContain("engine");
    expect(planIssuesToken(plan)).toBe(false);
  });

  test("unknown line code → blocked", () => {
    const plan = planExternalValue(externalInput({ line: null }));
    expect(plan.status).toBe("blocked");
    expect(plan.resolved_target.model).toBe("account.report.line");
    expect(plan.warnings.join(" ")).toContain(CA12.line.code);
    expect(planIssuesToken(plan)).toBe(false);
  });

  test("unknown expression label → blocked", () => {
    const plan = planExternalValue(externalInput({ expression: null }));
    expect(plan.status).toBe("blocked");
    expect(plan.resolved_target.model).toBe("account.report.expression");
    expect(planIssuesToken(plan)).toBe(false);
  });

  test("out-of-period date is warned but does not block a clean write", () => {
    const plan = planExternalValue(externalInput({ values: { ...externalInput().values, date: "2024-01-15" } }));
    expect(plan.status).toBe("safe");
    expect(plan.warnings.join(" ")).toContain("outside the expected return period");
  });

  test("sign of amount: a negative value is warned (soft) but does not block", () => {
    const plan = planExternalValue(externalInput({ values: { ...externalInput().values, value: -942 } }));
    expect(plan.status).toBe("safe");
    expect(plan.warnings.join(" ")).toContain("negative");
    expect(planIssuesToken(plan)).toBe(true);
  });

  test("sign of amount: a positive carryover balance produces no sign warning", () => {
    const plan = planExternalValue(externalInput());
    expect(plan.warnings.join(" ")).not.toContain("verify the sign");
  });

  test("record state: a finalized duplicate record is flagged before the update", () => {
    const dup = { id: 999, date: "2025-09-30", value: 500, state: "posted" };
    const plan = planExternalValue(externalInput({ existingValues: [dup] }));
    expect(plan.status).toBe("duplicate_found");
    expect(plan.warnings.join(" ")).toContain('state "posted"');
  });
});

describe("planManualReturn", () => {
  const base = {
    companyId: 1,
    values: { return_type_xmlid: "l10n_fr.mod_ca12", date_start: "2025-10-01", date_end: "2026-09-30", name: "CA12 2026" },
    resolvedType: { model: "account.return.type", res_id: 7 },
    returnTypeName: "CA12",
    existingReturns: [] as Array<{ id: number }>,
    lockDates: {} as LockDates,
    dateFields: { from: "date_from", to: "date_to" }
  };

  test("happy path → safe create with a token", () => {
    const plan = planManualReturn(base);
    expect(plan.status).toBe("safe");
    expect(plan.would_write).toEqual({
      model: "account.return",
      method: "create",
      values: { date_from: "2025-10-01", date_to: "2026-09-30", type_id: 7, company_id: 1, name: "CA12 2026" }
    });
    expect(planIssuesToken(plan)).toBe(true);
  });

  test("overlapping existing return → duplicate_found, NOT an update, no token", () => {
    const plan = planManualReturn({ ...base, existingReturns: [{ id: 42 }] });
    expect(plan.status).toBe("duplicate_found");
    expect(plan.duplicate_as_update).toBe(false);
    expect(plan.existing_records).toEqual([{ id: 42 }]);
    expect(planIssuesToken(plan)).toBe(false);
  });

  test("unresolved / wrong-model XML ID → blocked", () => {
    expect(planManualReturn({ ...base, resolvedType: null }).status).toBe("blocked");
    expect(planManualReturn({ ...base, resolvedType: { model: "account.report", res_id: 7 } }).status).toBe("blocked");
  });

  test("period start on/before a soft lock → needs_lock_exception, no token", () => {
    const plan = planManualReturn({ ...base, lockDates: { fiscalyear_lock_date: "2025-12-31" } });
    expect(plan.status).toBe("needs_lock_exception");
    expect(planIssuesToken(plan)).toBe(false);
  });

  test("record state: an overlapping posted return is flagged as finalized", () => {
    const plan = planManualReturn({ ...base, existingReturns: [{ id: 42, state: "posted" }] });
    expect(plan.status).toBe("duplicate_found");
    expect(plan.warnings.join(" ")).toContain('state "posted"');
  });
});

describe("planPeriodicityUpdate", () => {
  const base = {
    values: { return_type_xmlid: "l10n_fr.mod_ca12", field: "deadline_periodicity", new_value: "monthly" },
    resolvedType: { model: "account.return.type", res_id: 7 },
    returnTypeName: "CA12",
    fieldExists: true,
    currentValue: "quarterly"
  };

  test("known field → safe write reporting old_value, with a token", () => {
    const plan = planPeriodicityUpdate(base);
    expect(plan.status).toBe("safe");
    expect(plan.would_write).toEqual({
      model: "account.return.type",
      method: "write",
      id: 7,
      values: { deadline_periodicity: "monthly" },
      old_value: "quarterly"
    });
    expect(plan.resolved_target.deadline_periodicity).toBe("quarterly");
    expect(planIssuesToken(plan)).toBe(true);
  });

  test("unknown field → blocked, no token", () => {
    const plan = planPeriodicityUpdate({ ...base, values: { ...base.values, field: "not_a_field" }, fieldExists: false, currentValue: null });
    expect(plan.status).toBe("blocked");
    expect(plan.warnings.join(" ")).toContain("not_a_field");
    expect(planIssuesToken(plan)).toBe(false);
  });

  test("unresolved XML ID → blocked", () => {
    expect(planPeriodicityUpdate({ ...base, resolvedType: null }).status).toBe("blocked");
  });

  test("record state: a finalized record being updated is flagged", () => {
    const plan = planPeriodicityUpdate({ ...base, currentState: "posted" });
    expect(plan.status).toBe("safe");
    expect(plan.warnings.join(" ")).toContain('state "posted"');
  });
});

describe("planLockException", () => {
  const base = {
    companyId: 1,
    values: { company: "ACME FR", field: "tax_lock_date", exception_date: "2025-09-30", reason: "carryover posting" }
  };

  test("supported model → safe create with a token", () => {
    const plan = planLockException({ ...base, support: { supported: true, model: "account.lock_exception" } });
    expect(plan.status).toBe("safe");
    expect(plan.would_write).toEqual({
      model: "account.lock_exception",
      method: "create",
      values: { company_id: 1, tax_lock_date: "2025-09-30", reason: "carryover posting" }
    });
    expect(planIssuesToken(plan)).toBe(true);
  });

  test("unsupported model (e.g. saas-19.2) → blocked with a warning, no token", () => {
    const plan = planLockException({
      ...base,
      support: { supported: false, model: null, warning: "account.lock_exception unavailable (does not exist)" }
    });
    expect(plan.status).toBe("blocked");
    expect(plan.warnings.join(" ")).toContain("unavailable");
    expect(planIssuesToken(plan)).toBe(false);
  });
});
