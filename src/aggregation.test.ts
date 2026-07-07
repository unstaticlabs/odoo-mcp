import { describe, expect, test } from "bun:test";
import type { CachedFieldMeta } from "./cache";
import {
  parseAggregateToken,
  parseGroupbyToken,
  validateAggregate,
  validateAggregationRequest,
  validateGroupby
} from "./aggregation";

const FIELDS_META: Record<string, CachedFieldMeta> = {
  employee_id: { type: "many2one", string: "Employee", store: true },
  state: { type: "selection", string: "Status", store: true },
  invoice_date: { type: "datetime", string: "Invoice Date", store: true },
  date_field: { type: "date", string: "Date", store: true },
  amount_total: { type: "monetary", string: "Total", store: true },
  amount_untaxed: { type: "float", string: "Untaxed", store: true },
  quantity: { type: "integer", string: "Qty", store: true },
  tag_ids: { type: "one2many", string: "Tags", store: true },
  image: { type: "binary", string: "Image", store: true },
  name: { type: "char", string: "Name", store: true },
  computed_label: { type: "char", string: "Computed", store: false }
};

describe("parseGroupbyToken", () => {
  test("bare field name", () => {
    expect(parseGroupbyToken("employee_id")).toEqual({ ok: true, value: { field: "employee_id" } });
  });

  test("field with date granularity", () => {
    expect(parseGroupbyToken("invoice_date:month")).toEqual({
      ok: true,
      value: { field: "invoice_date", granularity: "month" }
    });
  });

  test("rejects unknown granularity", () => {
    const result = parseGroupbyToken("invoice_date:fortnight");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("invoice_date");
      expect(result.details).toContain("fortnight");
    }
  });

  test("rejects empty field", () => {
    expect(parseGroupbyToken(":month").ok).toBe(false);
    expect(parseGroupbyToken("").ok).toBe(false);
  });

  test("rejects multiple colon segments as invalid granularity", () => {
    const result = parseGroupbyToken("invoice_date:month:extra");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details).toContain("month:extra");
  });
});

describe("parseAggregateToken", () => {
  test("__count", () => {
    expect(parseAggregateToken("__count")).toEqual({ ok: true, value: { kind: "count" } });
  });

  test("field:op", () => {
    expect(parseAggregateToken("amount_total:sum")).toEqual({
      ok: true,
      value: { kind: "aggregate", field: "amount_total", op: "sum" }
    });
  });

  test("lowercases op", () => {
    expect(parseAggregateToken("amount_total:SUM")).toEqual({
      ok: true,
      value: { kind: "aggregate", field: "amount_total", op: "sum" }
    });
  });

  test("rejects missing op", () => {
    expect(parseAggregateToken("amount_total").ok).toBe(false);
    expect(parseAggregateToken("amount_total:").ok).toBe(false);
  });
});

describe("validateGroupby", () => {
  test("accepts many2one, selection, date, datetime", () => {
    expect(validateGroupby("employee_id", undefined, FIELDS_META)).toBeNull();
    expect(validateGroupby("state", undefined, FIELDS_META)).toBeNull();
    expect(validateGroupby("invoice_date", "month", FIELDS_META)).toBeNull();
    expect(validateGroupby("date_field", undefined, FIELDS_META)).toBeNull();
  });

  test("rejects unknown field", () => {
    const issue = validateGroupby("bogus_field", undefined, FIELDS_META);
    expect(issue?.code).toBe("invalid_groupby");
    expect(issue?.field).toBe("bogus_field");
  });

  test("rejects non-groupable types", () => {
    for (const field of ["tag_ids", "image", "name"]) {
      const issue = validateGroupby(field, undefined, FIELDS_META);
      expect(issue?.code).toBe("invalid_groupby");
      expect(issue?.details).toContain(FIELDS_META[field].type);
    }
  });

  test("rejects granularity on many2one", () => {
    const issue = validateGroupby("employee_id", "month", FIELDS_META);
    expect(issue?.code).toBe("invalid_groupby");
    expect(issue?.details).toContain("many2one");
  });

  test("rejects non-stored computed field", () => {
    const issue = validateGroupby("computed_label", undefined, FIELDS_META);
    expect(issue?.code).toBe("invalid_groupby");
    expect(issue?.details).toContain("non-stored");
  });
});

describe("validateAggregate", () => {
  test("accepts __count", () => {
    expect(validateAggregate({ kind: "count" }, FIELDS_META)).toBeNull();
  });

  test("accepts :sum on numeric types", () => {
    for (const field of ["amount_total", "amount_untaxed", "quantity"]) {
      expect(validateAggregate({ kind: "aggregate", field, op: "sum" }, FIELDS_META)).toBeNull();
    }
  });

  test("rejects unsupported op", () => {
    const issue = validateAggregate({ kind: "aggregate", field: "amount_total", op: "avg" }, FIELDS_META);
    expect(issue?.code).toBe("unsupported_aggregate");
    expect(issue?.details).toContain("avg");
  });

  test("rejects :sum on char", () => {
    const issue = validateAggregate({ kind: "aggregate", field: "name", op: "sum" }, FIELDS_META);
    expect(issue?.code).toBe("unsupported_aggregate");
    expect(issue?.details).toContain("char");
  });

  test("rejects unknown field", () => {
    const issue = validateAggregate({ kind: "aggregate", field: "missing_field", op: "sum" }, FIELDS_META);
    expect(issue?.code).toBe("unsupported_aggregate");
  });
});

describe("validateAggregationRequest", () => {
  test("accepts valid groupby and aggregates", () => {
    expect(
      validateAggregationRequest(["employee_id", "invoice_date:month"], ["__count", "amount_total:sum"], FIELDS_META)
    ).toEqual({ ok: true });
  });

  test("fails fast on first groupby issue before checking aggregates", () => {
    const result = validateAggregationRequest(["bogus_field", "name"], ["amount_total:avg"], FIELDS_META);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe("invalid_groupby");
      expect(result.issue.field).toBe("bogus_field");
    }
  });

  test("reports unsupported aggregate after groupby passes", () => {
    const result = validateAggregationRequest(["state"], ["amount_total:avg"], FIELDS_META);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe("unsupported_aggregate");
      expect(result.issue.field).toBe("amount_total");
    }
  });

  test("reports parse failure on malformed aggregate", () => {
    const result = validateAggregationRequest(["state"], ["amount_total"], FIELDS_META);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("unsupported_aggregate");
  });
});
