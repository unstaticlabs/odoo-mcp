import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { OdooError } from "../odoo";
import {
  resolveFieldPreset,
  resolveFields,
  resolveNamedPreset,
  resolveNamedFieldPreset,
  resolveBatchReadFields,
  buildBrowsePageMeta,
  applyBrowseSafeguard,
  encodeBrowseCursor,
  decodeBrowseCursor,
  parseBrowseResourceParams,
  buildBrowseResourceUri,
  BROWSE_DEFAULT_LIMIT,
  NAMED_FIELD_PRESET_VALUES,
  FIELD_PRESET_FIELDS_MUTUAL_EXCLUSION_MESSAGE,
  isFieldPresetFieldsCompatible,
  fieldPresetFieldsMutualExclusionRefine,
  fieldPresetFieldsMutualExclusionRefinement,
  type FieldPresetFieldsInput,
  BROWSE_MAX_PAYLOAD_BYTES,
  BROWSE_MIN_LIMIT,
  resolveCompactFields,
  buildPageMetadata,
  buildCompactReadEnvelope,
  computeFieldsReport,
  CORE_MODEL_ALLOWLIST,
  DEFAULT_TASK_FIELDS,
  DEFAULT_GENERIC_FIELDS,
  MODEL_FIELD_PRESETS,
  MODEL_NAMED_FIELD_PRESETS,
  GENERIC_NAMED_FIELD_PRESETS,
  NAMED_FIELD_PRESETS,
  NAMED_MODEL_FIELD_PRESETS,
  ALL_FIELDS_SENTINEL,
  buildBrowsePageMetadata,
  estimateBrowsePayloadBytes,
  isBrowsePayloadOversized,
  capBrowsePage,
  BROWSE_PAYLOAD_BYTE_LIMIT,
  BROWSE_MIN_PAGE_LIMIT,
  BROWSE_DEFAULT_PAGE_LIMIT,
  FIELD_PRESET_NAMES,
  FIELD_PRESET_FALLBACKS,
  FIELD_PRESET_MODEL_OVERRIDES,
  type FieldPresetName,
  mcpAggregationErrorFromException,
  mcpErrorFromException,
  redactDetails
} from "./shared";

describe("resolveFieldPreset", () => {
  test("known model with no fields resolves to its curated preset", () => {
    const { fields, resolution } = resolveFieldPreset("project.task");
    expect(fields).toEqual(DEFAULT_TASK_FIELDS);
    expect(resolution.source).toBe("preset");
    expect(resolution.model).toBe("project.task");

    const partner = resolveFieldPreset("res.partner");
    expect(partner.fields).toEqual(["id", "name", "email", "phone"]);
    expect(partner.resolution.source).toBe("preset");
  });

  test("unknown model with no fields falls back to generic fields", () => {
    const { fields, resolution } = resolveFieldPreset("some.unknown.model");
    expect(fields).toEqual(DEFAULT_GENERIC_FIELDS);
    expect(resolution.source).toBe("fallback");
    expect(resolution.model).toBe("some.unknown.model");
  });

  test("explicit non-empty fields are returned verbatim and win over the preset", () => {
    const { fields, resolution } = resolveFieldPreset("project.task", ["name", "id", "custom_x"]);
    expect(fields).toEqual(["name", "id", "custom_x"]);
    expect(resolution.source).toBe("explicit");
    expect(resolution.model).toBe("project.task");
  });

  test("empty requestedFields array is not 'explicit' — falls through to preset", () => {
    const { resolution } = resolveFieldPreset("project.task", []);
    expect(resolution.source).toBe("preset");
  });
});

describe("resolveFields", () => {
  test("default-preset resolution: known model with no fields -> curated preset, source preset", () => {
    const r = resolveFields("project.task");
    expect(r).toEqual({ fields: DEFAULT_TASK_FIELDS, source: "preset", model: "project.task" });
  });

  test("unknown-model fallback: unknown model with no fields -> generic minimal set, source fallback", () => {
    const r = resolveFields("some.unknown.model");
    expect(r.source).toBe("fallback");
    expect(r.fields).toEqual(DEFAULT_GENERIC_FIELDS); // ["id","display_name"]
  });

  test("explicit fields honored verbatim, order preserved, source explicit", () => {
    const requested = ["name", "id", "priority"];
    const r = resolveFields("project.task", requested);
    expect(r).toEqual({ fields: requested, source: "explicit", model: "project.task" });
  });

  test("empty explicit list falls through to preset/fallback (not treated as explicit)", () => {
    expect(resolveFields("project.task", []).source).toBe("preset");
  });

  test("null requestedFields behaves like omitted -> preset", () => {
    expect(resolveFields("project.task", null).source).toBe("preset");
  });

  test("__all__ sentinel is NOT interpreted here -> returned verbatim as explicit", () => {
    const r = resolveFields("project.task", ["__all__"]);
    expect(r).toEqual({ fields: ["__all__"], source: "explicit", model: "project.task" });
  });

  test("every CORE_MODEL_ALLOWLIST model has a preset entry", () => {
    for (const model of CORE_MODEL_ALLOWLIST) {
      expect(MODEL_FIELD_PRESETS[model]).toBeDefined();
      expect(MODEL_FIELD_PRESETS[model].length).toBeGreaterThan(0);
    }
  });
});

describe("computeFieldsReport", () => {
  test("Explicit-fields honored: report reflects exactly the requested fields split into returned/omitted", () => {
    const resolved = { fields: ["id", "name", "missing_field"], explicit: true };
    const rows = [
      { id: 1, name: "Row 1" },
      { id: 2, name: "Row 2" }
    ];
    const warnings: string[] = [];
    const report = computeFieldsReport(resolved, rows, warnings, "test.model");

    expect(report.returned_fields).toEqual(["id", "name"]);
    expect(report.omitted_fields).toEqual([{ field: "missing_field", reason: "absent-from-rows" }]);
    expect(warnings).toEqual(["test.model: requested field 'missing_field' was omitted (absent-from-rows)"]);
  });

  test("Omitted-field reporting: a requested field absent from all rows -> omitted_fields; present but false/null -> returned_fields", () => {
    const resolved = { fields: ["id", "name", "active", "description"], explicit: true };
    const rows = [
      { id: 1, name: "Row 1", active: false, description: null }
    ];
    const warnings: string[] = [];
    const report = computeFieldsReport(resolved, rows, warnings, "test.model");

    expect(report.returned_fields).toEqual(["id", "name", "active", "description"]);
    expect(report.omitted_fields).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("Warnings emission: explicitly-requested omitted field pushes warning; non-explicit omissions do not warn", () => {
    // Case 1: explicit = true
    const resolvedExplicit = { fields: ["id", "missing"], explicit: true };
    const rows = [{ id: 1 }];
    const warningsExplicit: string[] = [];
    const reportExplicit = computeFieldsReport(resolvedExplicit, rows, warningsExplicit, "test.model");

    expect(reportExplicit.returned_fields).toEqual(["id"]);
    expect(reportExplicit.omitted_fields).toEqual([{ field: "missing", reason: "absent-from-rows" }]);
    expect(warningsExplicit).toEqual(["test.model: requested field 'missing' was omitted (absent-from-rows)"]);

    // Case 2: explicit = false
    const resolvedImplicit = { fields: ["id", "missing"], explicit: false };
    const warningsImplicit: string[] = [];
    const reportImplicit = computeFieldsReport(resolvedImplicit, rows, warningsImplicit, "test.model");

    expect(reportImplicit.returned_fields).toEqual(["id"]);
    expect(reportImplicit.omitted_fields).toEqual([{ field: "missing", reason: "absent-from-rows" }]);
    expect(warningsImplicit).toEqual([]);
  });

  test("Reason labeling: with knownFields supplied, omitted field not in set -> unknown-field; in set -> absent-from-rows", () => {
    const resolved = { fields: ["id", "known_missing", "unknown_missing"], explicit: true };
    const rows = [{ id: 1 }];
    const knownFields = new Set(["id", "known_missing"]);
    const warnings: string[] = [];
    const report = computeFieldsReport(resolved, rows, warnings, "test.model", { knownFields });

    expect(report.returned_fields).toEqual(["id"]);
    expect(report.omitted_fields).toEqual([
      { field: "known_missing", reason: "absent-from-rows" },
      { field: "unknown_missing", reason: "unknown-field" }
    ]);
    expect(warnings).toEqual([
      "test.model: requested field 'known_missing' was omitted (absent-from-rows)",
      "test.model: requested field 'unknown_missing' was omitted (unknown-field)"
    ]);
  });

  test("Empty rows -> all requested fields omitted with absent-from-rows (unless not in knownFields)", () => {
    const resolved = { fields: ["id", "name", "unknown_field"], explicit: true };
    const rows: Record<string, unknown>[] = [];
    const knownFields = new Set(["id", "name"]);
    const warnings: string[] = [];
    const report = computeFieldsReport(resolved, rows, warnings, "test.model", { knownFields });

    expect(report.returned_fields).toEqual([]);
    expect(report.omitted_fields).toEqual([
      { field: "id", reason: "absent-from-rows" },
      { field: "name", reason: "absent-from-rows" },
      { field: "unknown_field", reason: "unknown-field" }
    ]);
    expect(warnings).toEqual([
      "test.model: requested field 'id' was omitted (absent-from-rows)",
      "test.model: requested field 'name' was omitted (absent-from-rows)",
      "test.model: requested field 'unknown_field' was omitted (unknown-field)"
    ]);
  });

  test("ALL_FIELDS_SENTINEL -> empty report, no warnings", () => {
    const resolved = { fields: [ALL_FIELDS_SENTINEL], explicit: true };
    const rows = [{ id: 1 }];
    const warnings: string[] = [];
    const report = computeFieldsReport(resolved, rows, warnings, "test.model");

    expect(report.returned_fields).toEqual([]);
    expect(report.omitted_fields).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("resolveNamedPreset", () => {
  test("minimal on each CORE_MODEL_ALLOWLIST model matches MODEL_FIELD_PRESETS", () => {
    for (const model of CORE_MODEL_ALLOWLIST) {
      const r = resolveNamedPreset(model, "minimal");
      expect(r.fields).toBe(MODEL_FIELD_PRESETS[model]);
      expect(r.source).toBe("preset");
      expect(r.preset).toBe("minimal");
      expect(r.model).toBe(model);
    }
  });

  test("tracking_minimal and financial_minimal on known models are non-empty curated presets", () => {
    for (const model of CORE_MODEL_ALLOWLIST) {
      for (const preset of ["tracking_minimal", "financial_minimal"] as const) {
        const r = resolveNamedPreset(model, preset);
        const expected = MODEL_NAMED_FIELD_PRESETS[model]![preset]!;
        expect(r.fields).toBe(expected);
        expect(r.fields.length).toBeGreaterThan(0);
        expect(r.source).toBe("preset");
        expect(r.preset).toBe(preset);
      }
    }
  });

  test("tracking_minimal is a superset or distinct from minimal on project.task", () => {
    const minimal = resolveNamedPreset("project.task", "minimal").fields;
    const tracking = resolveNamedPreset("project.task", "tracking_minimal").fields;
    expect(tracking.length).toBeGreaterThan(minimal.length);
    for (const field of minimal) {
      expect(tracking).toContain(field);
    }
  });

  test("unknown model uses GENERIC_NAMED_FIELD_PRESETS with source fallback", () => {
    for (const preset of NAMED_FIELD_PRESETS) {
      const r = resolveNamedPreset("some.unknown.model", preset);
      expect(r.fields).toBe(GENERIC_NAMED_FIELD_PRESETS[preset]);
      expect(r.source).toBe("fallback");
      expect(r.preset).toBe(preset);
      expect(r.model).toBe("some.unknown.model");
    }
  });

  test("explicit fields override any preset without preset field", () => {
    const requested = ["name", "id", "custom_x"];
    const r = resolveNamedPreset("project.task", "financial_minimal", requested);
    expect(r).toEqual({ fields: requested, source: "explicit", model: "project.task" });
    expect(r.preset).toBeUndefined();
  });

  test("empty requestedFields falls through to minimal preset", () => {
    const r = resolveNamedPreset("project.task", "financial_minimal", []);
    expect(r.source).toBe("preset");
    expect(r.preset).toBe("financial_minimal");
    expect(r.fields).toBe(MODEL_NAMED_FIELD_PRESETS["project.task"]!.financial_minimal);
  });

  test("omitted preset arg defaults to minimal", () => {
    const r = resolveNamedPreset("project.task");
    expect(r.preset).toBe("minimal");
    expect(r.fields).toBe(MODEL_FIELD_PRESETS["project.task"]);
    expect(r.source).toBe("preset");
  });

  test("__all__ sentinel returned verbatim as explicit", () => {
    const r = resolveNamedPreset("project.task", "minimal", [ALL_FIELDS_SENTINEL]);
    expect(r).toEqual({ fields: [ALL_FIELDS_SENTINEL], source: "explicit", model: "project.task" });
    expect(r.preset).toBeUndefined();
  });

  test("returned preset arrays alias constants — mutating a copy does not affect the constant", () => {
    const r = resolveNamedPreset("project.task", "minimal");
    const copy = [...r.fields];
    copy.push("mutated");
    expect(MODEL_FIELD_PRESETS["project.task"]).toEqual(DEFAULT_TASK_FIELDS);
    expect(copy).not.toEqual(MODEL_FIELD_PRESETS["project.task"]);
  });
});

describe("buildBrowsePageMetadata", () => {
  test("normal page has has_more true", () => {
    expect(buildBrowsePageMetadata({ offset: 0, limit: 50, count: 120, returned: 50 })).toEqual({
      offset: 0,
      limit: 50,
      count: 120,
      returned: 50,
      has_more: true
    });
  });

  test("last page has has_more false", () => {
    expect(buildBrowsePageMetadata({ offset: 100, limit: 50, count: 120, returned: 20 })).toEqual({
      offset: 100,
      limit: 50,
      count: 120,
      returned: 20,
      has_more: false
    });
  });

  test("empty page has has_more false", () => {
    expect(buildBrowsePageMetadata({ offset: 0, limit: 50, count: 0, returned: 0 })).toEqual({
      offset: 0,
      limit: 50,
      count: 0,
      returned: 0,
      has_more: false
    });
  });

  test("single-row tail has has_more false", () => {
    expect(buildBrowsePageMetadata({ offset: 99, limit: 50, count: 100, returned: 1 })).toEqual({
      offset: 99,
      limit: 50,
      count: 100,
      returned: 1,
      has_more: false
    });
  });
});

function makeFatRecordsForFields(
  count: number,
  fields: string[],
  valueLen: number
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      if (field === "id") {
        row[field] = i;
      } else if (field.endsWith("_id") && field !== "display_name") {
        row[field] = [i, "Label"];
      } else {
        row[field] = "x".repeat(valueLen);
      }
    }
    records.push(row);
  }
  return records;
}

describe("payload size / capBrowsePage", () => {
  test("BROWSE_DEFAULT_PAGE_LIMIT is 50", () => {
    expect(BROWSE_DEFAULT_PAGE_LIMIT).toBe(50);
  });

  test("small synthetic records are not adjusted", () => {
    const records = [{ id: 1, name: "A" }];
    const fields = ["id", "name"];
    expect(isBrowsePayloadOversized(records, fields)).toBe(false);
    const result = capBrowsePage({
      model: "project.task",
      preset: "financial_minimal",
      limit: 50,
      records
    });
    expect(result.adjusted).toBe(false);
    expect(result.adjustments).toEqual([]);
  });

  test("oversized with explicit fields shrinks limit only", () => {
    const fields = Array.from({ length: 20 }, (_, i) => `field_${i}`);
    const records = makeFatRecordsForFields(50, fields, 500);
    expect(estimateBrowsePayloadBytes(records, fields)).toBeGreaterThan(BROWSE_PAYLOAD_BYTE_LIMIT);

    const result = capBrowsePage({
      model: "project.task",
      preset: "financial_minimal",
      limit: 50,
      records,
      explicitFields: fields
    });
    expect(result.preset).toBe("financial_minimal");
    expect(result.limit).toBeLessThan(50);
    expect(result.adjusted).toBe(true);
    expect(result.adjustments.some((a) => a.startsWith("limit:"))).toBe(true);
    expect(result.adjustments.some((a) => a.startsWith("preset:"))).toBe(false);
  });

  test("oversized with named preset shrinks limit then downgrades preset", () => {
    const fields = resolveNamedPreset("project.task", "financial_minimal").fields;
    const records = makeFatRecordsForFields(8, fields, 70_000);
    expect(estimateBrowsePayloadBytes(records.slice(0, 1), fields)).toBeGreaterThan(
      BROWSE_PAYLOAD_BYTE_LIMIT
    );

    const result = capBrowsePage({
      model: "project.task",
      preset: "financial_minimal",
      limit: 8,
      records
    });
    expect(result.adjusted).toBe(true);
    expect(result.adjustments.some((a) => a.startsWith("limit:") || a.startsWith("preset:"))).toBe(
      true
    );
  });

  test("at BROWSE_MIN_PAGE_LIMIT and minimal preset still oversized reports best effort", () => {
    const fields = resolveNamedPreset("project.task", "minimal").fields;
    const records = makeFatRecordsForFields(1, fields, 100_000);
    expect(estimateBrowsePayloadBytes(records, fields)).toBeGreaterThan(BROWSE_PAYLOAD_BYTE_LIMIT);

    const result = capBrowsePage({
      model: "project.task",
      preset: "financial_minimal",
      limit: 50,
      records
    });
    expect(result.limit).toBe(BROWSE_MIN_PAGE_LIMIT);
    expect(result.preset).toBe("minimal");
    expect(result.adjusted).toBe(true);
    expect(result.adjustments.length).toBeGreaterThan(0);
    expect(
      isBrowsePayloadOversized(records.slice(0, result.limit), fields)
    ).toBe(true);
  });

  test("estimateBrowsePayloadBytes is monotonic in rows and fields", () => {
    const base = [{ id: 1, name: "A", state: "open" }];
    const moreRows = [...base, { id: 2, name: "B", state: "done" }];
    const baseFields = ["id", "name"];
    const moreFields = ["id", "name", "state"];

    const e1 = estimateBrowsePayloadBytes(base, baseFields);
    const e2 = estimateBrowsePayloadBytes(moreRows, baseFields);
    const e3 = estimateBrowsePayloadBytes(base, moreFields);
    const e4 = estimateBrowsePayloadBytes(moreRows, moreFields);

    expect(e2).toBeGreaterThanOrEqual(e1);
    expect(e3).toBeGreaterThanOrEqual(e1);
    expect(e4).toBeGreaterThanOrEqual(e3);
    expect(e4).toBeGreaterThanOrEqual(e2);
  });
});

describe("resolveNamedFieldPreset", () => {
  test("minimal preset resolves known models from curated lists", () => {
    const task = resolveNamedFieldPreset("project.task", "minimal");
    expect(task.fields).toEqual(DEFAULT_TASK_FIELDS);
    expect(task.preset).toBe("minimal");
    expect(task.source).toBe("preset");

    const move = resolveNamedFieldPreset("account.move", "minimal");
    expect(move.fields).toEqual(NAMED_MODEL_FIELD_PRESETS.minimal["account.move"]);
    expect(move.source).toBe("preset");
  });

  test("tracking_minimal and financial_minimal resolve model-specific fields", () => {
    const tracking = resolveNamedFieldPreset("project.task", "tracking_minimal");
    expect(tracking.fields).toContain("priority");
    expect(tracking.fields).not.toContain("user_ids");
    expect(tracking.preset).toBe("tracking_minimal");

    const financial = resolveNamedFieldPreset("account.move", "financial_minimal");
    expect(financial.fields).toContain("amount_untaxed");
    expect(financial.preset).toBe("financial_minimal");
  });

  test("unknown model falls back per preset", () => {
    const minimal = resolveNamedFieldPreset("x.custom.model", "minimal");
    expect(minimal.fields).toEqual(DEFAULT_GENERIC_FIELDS);
    expect(minimal.source).toBe("fallback");

    const tracking = resolveNamedFieldPreset("x.custom.model", "tracking_minimal");
    expect(tracking.fields).toEqual(["id", "display_name", "state"]);
    expect(tracking.source).toBe("fallback");

    const financial = resolveNamedFieldPreset("x.custom.model", "financial_minimal");
    expect(financial.fields).toEqual(["id", "display_name", "amount_total"]);
    expect(financial.source).toBe("fallback");
  });

  test("explicit fields win with preset null", () => {
    const r = resolveNamedFieldPreset("project.task", "tracking_minimal", ["id", "name"]);
    expect(r.fields).toEqual(["id", "name"]);
    expect(r.preset).toBeNull();
    expect(r.source).toBe("explicit");
  });

  test("empty explicit fields default to minimal preset", () => {
    const r = resolveNamedFieldPreset("project.task", undefined, []);
    expect(r.preset).toBe("minimal");
    expect(r.source).toBe("preset");
  });
});

describe("resolveBatchReadFields", () => {
  test("minimal preset resolves known models from curated lists", () => {
    const task = resolveBatchReadFields("project.task", { field_preset: "minimal" });
    expect(task.fields).toEqual(DEFAULT_TASK_FIELDS);
    expect(task.field_preset).toBe("minimal");
    expect(task.fields_resolution.source).toBe("preset");

    const move = resolveBatchReadFields("account.move", { field_preset: "minimal" });
    expect(move.fields).toEqual(NAMED_MODEL_FIELD_PRESETS.minimal["account.move"]);
    expect(move.fields_resolution.source).toBe("preset");
  });

  test("tracking_minimal and financial_minimal resolve model-specific fields", () => {
    const tracking = resolveBatchReadFields("project.task", { field_preset: "tracking_minimal" });
    expect(tracking.fields).toContain("priority");
    expect(tracking.field_preset).toBe("tracking_minimal");

    const financial = resolveBatchReadFields("account.move", { field_preset: "financial_minimal" });
    expect(financial.fields).toContain("amount_untaxed");
    expect(financial.field_preset).toBe("financial_minimal");
  });

  test("unknown model falls back per preset", () => {
    const minimal = resolveBatchReadFields("x.custom.model", { field_preset: "minimal" });
    expect(minimal.fields).toEqual(DEFAULT_GENERIC_FIELDS);
    expect(minimal.fields_resolution.source).toBe("fallback");

    const tracking = resolveBatchReadFields("x.custom.model", { field_preset: "tracking_minimal" });
    expect(tracking.fields).toEqual(["id", "display_name", "state"]);
    expect(tracking.fields_resolution.source).toBe("fallback");

    const financial = resolveBatchReadFields("x.custom.model", { field_preset: "financial_minimal" });
    expect(financial.fields).toEqual(["id", "display_name", "amount_total"]);
    expect(financial.fields_resolution.source).toBe("fallback");
  });

  test("explicit fields win with field_preset null", () => {
    const r = resolveBatchReadFields("project.task", {
      field_preset: "tracking_minimal",
      fields: ["id", "name"]
    });
    expect(r.fields).toEqual(["id", "name"]);
    expect(r.field_preset).toBeNull();
    expect(r.fields_resolution.source).toBe("explicit");
  });

  test("__all__ sentinel returned verbatim as explicit", () => {
    const r = resolveBatchReadFields("project.task", { fields: ["__all__"] });
    expect(r.fields).toEqual(["__all__"]);
    expect(r.field_preset).toBeNull();
    expect(r.fields_resolution.source).toBe("explicit");
  });

  test("no options delegates to legacy resolveFields with field_preset null", () => {
    const r = resolveBatchReadFields("project.task");
    const legacy = resolveFields("project.task");
    expect(r.fields).toEqual(legacy.fields);
    expect(r.fields_resolution).toEqual({ source: legacy.source, model: legacy.model });
    expect(r.field_preset).toBeNull();
  });

  test("null fields delegates to legacy resolveFields with field_preset null", () => {
    const r = resolveBatchReadFields("project.task", { fields: null });
    const legacy = resolveFields("project.task", null);
    expect(r.fields).toEqual(legacy.fields);
    expect(r.fields_resolution).toEqual({ source: legacy.source, model: legacy.model });
    expect(r.field_preset).toBeNull();
  });

  test("empty fields array uses legacy path not named minimal preset", () => {
    const r = resolveBatchReadFields("project.task", { fields: [] });
    const legacy = resolveFields("project.task", []);
    expect(r.fields).toEqual(legacy.fields);
    expect(r.fields_resolution).toEqual({ source: legacy.source, model: legacy.model });
    expect(r.field_preset).toBeNull();
  });

  test("unknown model with no preset matches legacy resolveFields", () => {
    const r = resolveBatchReadFields("some.unknown.model");
    const legacy = resolveFields("some.unknown.model");
    expect(r.fields).toEqual(legacy.fields);
    expect(r.fields_resolution).toEqual({ source: legacy.source, model: legacy.model });
    expect(r.field_preset).toBeNull();
  });

  test("set field_preset minimal differs from legacy no-preset path", () => {
    const named = resolveBatchReadFields("project.task", { field_preset: "minimal" });
    const legacy = resolveBatchReadFields("project.task");
    expect(named.field_preset).toBe("minimal");
    expect(legacy.field_preset).toBeNull();
    expect(named.fields).toEqual(legacy.fields);
  });
});

describe("isFieldPresetFieldsCompatible / fieldPresetFieldsMutualExclusionRefinement", () => {
  type PredicateCase = FieldPresetFieldsInput & { expected: boolean };

  test.each([
    { fields: null, field_preset: "minimal", expected: true },
    { fields: null, field_preset: "tracking_minimal", expected: true },
    { fields: null, field_preset: "financial_minimal", expected: true },
    { fields: [], field_preset: "tracking_minimal", expected: true },
    { fields: [], field_preset: "financial_minimal", expected: true },
    { fields: ["id"], field_preset: "minimal", expected: true },
    { fields: ["id"], field_preset: undefined, expected: true },
    { fields: ["id"], field_preset: null, expected: true },
    { fields: ["id", "name"], field_preset: undefined, expected: true },
    { fields: ["id"], field_preset: "tracking_minimal", expected: false },
    { fields: ["id"], field_preset: "financial_minimal", expected: false },
    { field_preset: "tracking_minimal", expected: true }
  ] satisfies PredicateCase[])("isFieldPresetFieldsCompatible(%j) → %s", ({ fields, field_preset, expected }: PredicateCase) => {
    expect(isFieldPresetFieldsCompatible({ fields, field_preset })).toBe(expected);
  });

  test("FIELD_PRESET_FIELDS_MUTUAL_EXCLUSION_MESSAGE is exact browse error string", () => {
    expect(FIELD_PRESET_FIELDS_MUTUAL_EXCLUSION_MESSAGE).toBe(
      "cannot set both explicit fields and a non-default field_preset"
    );
  });

  const stubSchema = z
    .object({
      field_preset: z.enum(NAMED_FIELD_PRESET_VALUES).nullable().optional(),
      fields: z.array(z.string()).nullable()
    })
    .refine(fieldPresetFieldsMutualExclusionRefine, fieldPresetFieldsMutualExclusionRefinement);

  test("stub schema rejects non-empty fields with non-default preset", () => {
    expect(() =>
      stubSchema.parse({ fields: ["id"], field_preset: "tracking_minimal" })
    ).toThrow(/cannot set both explicit fields and a non-default field_preset/);
  });

  test.each([
    { fields: ["id"], field_preset: "minimal" },
    { fields: ["id"], field_preset: null },
    { fields: ["id"] },
    { fields: [], field_preset: "tracking_minimal" },
    { fields: null, field_preset: "financial_minimal" }
  ] satisfies FieldPresetFieldsInput[])("stub schema accepts %j", (input: FieldPresetFieldsInput) => {
    expect(() => stubSchema.parse(input)).not.toThrow();
  });
});

describe("buildBrowsePageMeta", () => {
  test("empty result set", () => {
    const page = buildBrowsePageMeta(0, 25, 0, 0);
    expect(page).toEqual({
      offset: 0,
      limit: 25,
      count: 0,
      returned: 0,
      has_more: false,
      next_offset: null
    });
  });

  test("partial page with more results", () => {
    const page = buildBrowsePageMeta(0, 10, 30, 10);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(10);
  });

  test("last page", () => {
    const page = buildBrowsePageMeta(20, 10, 25, 5);
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
  });

  test("empty page when offset beyond count", () => {
    const page = buildBrowsePageMeta(50, 25, 10, 0);
    expect(page.returned).toBe(0);
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
  });
});

describe("applyBrowseSafeguard", () => {
  test("accepts payloads under the byte cap", () => {
    expect(applyBrowseSafeguard(1000, 25, "minimal", false)).toEqual({ action: "accept" });
  });

  test("oversize triggers limit halving on first attempt", () => {
    const plan = applyBrowseSafeguard(BROWSE_MAX_PAYLOAD_BYTES + 1, 50, "minimal", false);
    expect(plan).toEqual({
      action: "retry",
      newLimit: 25,
      newPreset: "minimal",
      safeguardApplied: "limit reduced 50→25 due to payload size"
    });
  });

  test("at min limit with non-minimal preset downgrades preset", () => {
    const plan = applyBrowseSafeguard(BROWSE_MAX_PAYLOAD_BYTES + 1, BROWSE_MIN_LIMIT, "financial_minimal", false);
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") {
      expect(plan.newPreset).toBe("minimal");
      expect(plan.newLimit).toBe(BROWSE_MIN_LIMIT);
    }
  });

  test("reject after retry still oversize", () => {
    const plan = applyBrowseSafeguard(BROWSE_MAX_PAYLOAD_BYTES + 1, BROWSE_MIN_LIMIT, "minimal", true);
    expect(plan.action).toBe("reject");
    if (plan.action === "reject") {
      expect(plan.message).toContain("Result too large");
    }
  });
});

describe("browse resource URI", () => {
  const model = "sale.order";
  const domain = [["state", "=", "sale"]];

  test("happy path — all params set", () => {
    const order = "id asc";
    const cursor = encodeBrowseCursor({ offset: 50, model, domain, order });
    const uri = buildBrowseResourceUri({
      model,
      domain,
      field_preset: "tracking_minimal",
      limit: 50,
      offset: 50,
      order,
      cursor
    });
    const parsed = parseBrowseResourceParams(new URL(uri), model);
    expect(parsed).toEqual({
      model,
      domain,
      field_preset: "tracking_minimal",
      fields: null,
      limit: 50,
      offset: 50,
      order,
      cursor
    });
    expect(buildBrowseResourceUri({
      model: parsed.model,
      domain: parsed.domain,
      field_preset: parsed.field_preset,
      fields: parsed.fields,
      limit: parsed.limit,
      offset: parsed.offset,
      order: parsed.order,
      cursor: parsed.cursor
    })).toBe(uri);
  });

  test("defaults only — odoo://sale.order/browse", () => {
    const parsed = parseBrowseResourceParams(new URL("odoo://sale.order/browse"), model);
    expect(parsed).toEqual({
      model,
      domain: [],
      field_preset: "minimal",
      fields: null,
      limit: BROWSE_DEFAULT_LIMIT,
      offset: 0,
      order: undefined,
      cursor: undefined
    });
    expect(buildBrowseResourceUri({ model })).toBe("odoo://sale.order/browse");
  });

  test("empty domain explicit domain=[] parses; builder omits domain key", () => {
    const parsed = parseBrowseResourceParams(new URL("odoo://sale.order/browse?domain=%5B%5D"), model);
    expect(parsed.domain).toEqual([]);
    expect(buildBrowseResourceUri({ model, domain: parsed.domain })).toBe("odoo://sale.order/browse");
  });

  test("explicit fields override — comma parsing trims; round-trip", () => {
    const messyUri = "odoo://sale.order/browse?fields=+id+%2Cname%2C%2Cpartner_id";
    const parsed = parseBrowseResourceParams(new URL(messyUri), model);
    expect(parsed.fields).toEqual(["id", "name", "partner_id"]);
    expect(parsed.field_preset).toBe("minimal");
    const canonical = buildBrowseResourceUri({
      model: parsed.model,
      domain: parsed.domain,
      field_preset: parsed.field_preset,
      fields: parsed.fields,
      limit: parsed.limit,
      offset: parsed.offset,
      order: parsed.order
    });
    expect(canonical).toBe("odoo://sale.order/browse?fields=id%2Cname%2Cpartner_id");
    expect(parseBrowseResourceParams(new URL(canonical), model).fields).toEqual(["id", "name", "partner_id"]);
  });

  test("explicit fields combined with a non-default field_preset throws Error", () => {
    expect(() =>
      parseBrowseResourceParams(
        new URL("odoo://sale.order/browse?fields=id%2Cname&field_preset=tracking_minimal"),
        model
      )
    ).toThrow(/cannot set both explicit fields and a non-default field_preset/);
  });

  test("each field_preset enum value accepted", () => {
    for (const preset of NAMED_FIELD_PRESET_VALUES) {
      const uri = buildBrowseResourceUri({ model, field_preset: preset });
      const parsed = parseBrowseResourceParams(new URL(uri), model);
      expect(parsed.field_preset).toBe(preset);
    }
  });

  test("invalid field_preset throws Error", () => {
    expect(() =>
      parseBrowseResourceParams(new URL("odoo://sale.order/browse?field_preset=verbose"), model)
    ).toThrow(/Invalid browse resource field_preset/);
  });

  test("invalid limit throws Error", () => {
    for (const bad of ["0", "101", "NaN", "1.5"]) {
      expect(() =>
        parseBrowseResourceParams(new URL(`odoo://sale.order/browse?limit=${bad}`), model)
      ).toThrow(/Invalid browse resource limit/);
    }
  });

  test("invalid offset throws Error", () => {
    for (const bad of ["-1", "NaN", "1.5"]) {
      expect(() =>
        parseBrowseResourceParams(new URL(`odoo://sale.order/browse?offset=${bad}`), model)
      ).toThrow(/Invalid browse resource offset/);
    }
  });

  test("invalid domain JSON throws Error", () => {
    expect(() =>
      parseBrowseResourceParams(new URL("odoo://sale.order/browse?domain=not-json"), model)
    ).toThrow(/domain query param must be valid JSON array/);
  });

  test("invalid / corrupt cursor throws Error", () => {
    expect(() =>
      parseBrowseResourceParams(new URL("odoo://sale.order/browse?cursor=!!!"), model)
    ).toThrow(/Invalid browse resource cursor/);
  });

  test("cursor + offset both present — resolved offset from cursor; raw cursor preserved", () => {
    const cursor = encodeBrowseCursor({ offset: 25, model, domain: [] });
    const parsed = parseBrowseResourceParams(
      new URL(`odoo://sale.order/browse?offset=99&cursor=${encodeURIComponent(cursor)}`),
      model
    );
    expect(parsed.offset).toBe(25);
    expect(parsed.cursor).toBe(cursor);
  });

  test("builder round-trip — build → parse → build stable string equality", () => {
    const input = {
      model,
      domain,
      field_preset: "financial_minimal" as const,
      limit: 40,
      order: "name desc"
    };
    const built = buildBrowseResourceUri(input);
    const parsed = parseBrowseResourceParams(new URL(built), model);
    const rebuilt = buildBrowseResourceUri({
      model: parsed.model,
      domain: parsed.domain,
      field_preset: parsed.field_preset,
      fields: parsed.fields,
      limit: parsed.limit,
      offset: parsed.offset,
      order: parsed.order,
      cursor: parsed.cursor
    });
    expect(rebuilt).toBe(built);
  });

  test("continuation page — cursor + next_offset from page meta", () => {
    const order = "id asc";
    const nextOffset = 25;
    const cursor = encodeBrowseCursor({ offset: nextOffset, model, domain, order });
    const uri = buildBrowseResourceUri({
      model,
      domain,
      limit: 25,
      offset: nextOffset,
      order,
      cursor
    });
    const parsed = parseBrowseResourceParams(new URL(uri), model);
    expect(parsed.offset).toBe(nextOffset);
    expect(parsed.cursor).toBe(cursor);
  });

  test("order with spaces trimmed on parse", () => {
    const parsed = parseBrowseResourceParams(
      new URL("odoo://sale.order/browse?order=%20id%20asc%20"),
      model
    );
    expect(parsed.order).toBe("id asc");
  });
});

describe("browse cursor", () => {
  test("round-trips offset when query matches", () => {
    const cursor = encodeBrowseCursor({
      offset: 25,
      model: "project.task",
      domain: [["active", "=", true]],
      order: "id asc"
    });
    const decoded = decodeBrowseCursor(cursor, {
      model: "project.task",
      domain: [["active", "=", true]],
      order: "id asc"
    });
    expect(decoded).toEqual({ offset: 25 });
  });

  test("rejects stale cursor when domain differs", () => {
    const cursor = encodeBrowseCursor({ offset: 10, model: "project.task", domain: [] });
    const decoded = decodeBrowseCursor(cursor, { model: "project.task", domain: [["id", ">", 0]] });
    expect(decoded).toEqual({ error: "cursor does not match current query" });
  });
});

const EXPECTED_PRESET_FIELDS: Record<FieldPresetName, Record<string, readonly string[]>> = {
  minimal: {
    "project.task": DEFAULT_TASK_FIELDS,
    "project.project": ["id", "name", "partner_id", "user_id", "stage_id"],
    "res.partner": ["id", "name", "email", "phone"],
    "res.users": ["id", "name", "login", "email"]
  },
  tracking_minimal: {
    "project.task": ["id", "name", "stage_id", "project_id", "priority", "user_ids", "date_deadline"],
    "project.project": ["id", "name", "stage_id", "user_id", "date_start", "date"],
    "res.partner": ["id", "name", "email", "phone", "category_id", "active"],
    "res.users": ["id", "name", "login", "email", "active"]
  },
  financial_minimal: {
    "project.task": ["id", "name", "project_id", "planned_hours", "effective_hours"],
    "project.project": ["id", "name", "partner_id", "analytic_account_id"],
    "res.partner": ["id", "name", "credit", "debit", "currency_id"],
    "res.users": ["id", "name", "login", "email"]
  }
};

describe("resolveCompactFields", () => {
  test("known model + field_preset minimal matches resolveFields", () => {
    const compact = resolveCompactFields("project.task", { field_preset: "minimal" });
    const legacy = resolveFields("project.task");
    expect(compact.fields).toEqual(legacy.fields);
    expect(compact.resolution.source).toBe("preset");
    expect(compact.resolution.preset).toBe("minimal");
    expect(compact.resolution.model).toBe("project.task");
  });

  test("each preset × each allowlisted model → override array, source preset", () => {
    for (const preset of FIELD_PRESET_NAMES) {
      for (const model of CORE_MODEL_ALLOWLIST) {
        const { fields, resolution } = resolveCompactFields(model, { field_preset: preset });
        expect(fields).toEqual(EXPECTED_PRESET_FIELDS[preset][model]);
        expect(resolution).toEqual({ source: "preset", model, preset });
      }
    }
  });

  test("unknown model × each preset → fallback", () => {
    for (const preset of FIELD_PRESET_NAMES) {
      const { fields, resolution } = resolveCompactFields("some.unknown.model", { field_preset: preset });
      expect(fields).toEqual(FIELD_PRESET_FALLBACKS[preset]);
      expect(resolution).toEqual({ source: "fallback", model: "some.unknown.model", preset });
    }
  });

  test("explicit fields win over any field_preset", () => {
    const requested = ["name", "id", "custom_x"];
    const { fields, resolution } = resolveCompactFields("project.task", {
      field_preset: "tracking_minimal",
      fields: requested
    });
    expect(fields).toEqual(requested);
    expect(resolution).toEqual({ source: "explicit", model: "project.task", preset: null });
  });

  test("empty fields array falls through to default minimal preset", () => {
    const { resolution } = resolveCompactFields("project.task", { fields: [] });
    expect(resolution.source).toBe("preset");
    expect(resolution.preset).toBe("minimal");
  });

  test("fields null + omitted preset defaults to minimal", () => {
    const { resolution } = resolveCompactFields("project.task", { fields: null });
    expect(resolution.source).toBe("preset");
    expect(resolution.preset).toBe("minimal");
  });

  test("__all__ sentinel returned verbatim as explicit", () => {
    const { fields, resolution } = resolveCompactFields("project.task", { fields: ["__all__"] });
    expect(fields).toEqual(["__all__"]);
    expect(resolution).toEqual({ source: "explicit", model: "project.task", preset: null });
  });

  test("resolveFields equivalence matrix", () => {
    const models = [...CORE_MODEL_ALLOWLIST, "some.unknown.model"];
    const fieldInputs: (string[] | null | undefined)[] = [
      undefined,
      null,
      [],
      ["name", "id"],
      ["__all__"]
    ];
    for (const model of models) {
      for (const fields of fieldInputs) {
        const legacy = resolveFields(model, fields);
        const compact = resolveCompactFields(model, { field_preset: "minimal", fields });
        expect(compact.fields).toEqual(legacy.fields);
        expect(compact.resolution.source).toBe(legacy.source);
      }
    }
  });
});

describe("field-preset registry invariants", () => {
  test("every CORE_MODEL_ALLOWLIST model has non-empty entry under each preset", () => {
    for (const preset of FIELD_PRESET_NAMES) {
      for (const model of CORE_MODEL_ALLOWLIST) {
        const entry = FIELD_PRESET_MODEL_OVERRIDES[preset][model];
        expect(entry).toBeDefined();
        expect(entry.length).toBeGreaterThan(0);
      }
    }
  });

  test("minimal project.task override aliases DEFAULT_TASK_FIELDS", () => {
    expect(FIELD_PRESET_MODEL_OVERRIDES.minimal["project.task"]).toBe(DEFAULT_TASK_FIELDS);
  });

  test("MODEL_FIELD_PRESETS keys unchanged", () => {
    expect(Object.keys(MODEL_FIELD_PRESETS).sort()).toEqual(
      ["project.project", "project.task", "res.partner", "res.users"].sort()
    );
  });
});

describe("buildPageMetadata", () => {
  test("full page has_more true", () => {
    const page = buildPageMetadata({ offset: 0, limit: 10, count: 25, returned: 10 });
    expect(page).toEqual({
      offset: 0,
      limit: 10,
      count: 25,
      returned: 10,
      has_more: true
    });
    expect(page.next_cursor).toBeUndefined();
  });

  test("partial last page has_more false", () => {
    const page = buildPageMetadata({ offset: 20, limit: 10, count: 25, returned: 5 });
    expect(page.has_more).toBe(false);
    expect(page.returned).toBe(5);
  });

  test("empty page has_more false", () => {
    const page = buildPageMetadata({ offset: 0, limit: 10, count: 0, returned: 0 });
    expect(page.has_more).toBe(false);
    expect(page.returned).toBe(0);
  });

  test("next_cursor passed through when supplied", () => {
    const page = buildPageMetadata({
      offset: 0,
      limit: 10,
      count: 25,
      returned: 10,
      next_cursor: "abc123"
    });
    expect(page.next_cursor).toBe("abc123");
  });

  test("clamps negative returned to zero", () => {
    const page = buildPageMetadata({ offset: 0, limit: 10, count: 5, returned: -3 });
    expect(page.returned).toBe(0);
    expect(page.has_more).toBe(true);
  });
});

describe("buildCompactReadEnvelope", () => {
  test("assembles complete envelope with default warnings", () => {
    const resolved = resolveCompactFields("project.task");
    const rows = [{ id: 1, name: "Task A", stage_id: [1, "Todo"], project_id: [2, "Proj"] }];
    const warnings: string[] = [];
    const fieldsReport = computeFieldsReport(
      { fields: resolved.fields, explicit: false },
      rows,
      warnings,
      "project.task"
    );
    const page = buildPageMetadata({ offset: 0, limit: 10, count: 1, returned: 1 });

    const envelope = buildCompactReadEnvelope({
      model: "project.task",
      records: rows,
      resolved,
      fieldsReport,
      page
    });

    expect(envelope.model).toBe("project.task");
    expect(envelope.records).toEqual(rows);
    expect(envelope.fields.resolved_fields).toEqual(resolved.fields);
    expect(envelope.fields.returned_fields).toEqual(fieldsReport.returned_fields);
    expect(envelope.fields.omitted_fields).toEqual(fieldsReport.omitted_fields);
    expect(envelope.fields.resolution).toEqual(resolved.resolution);
    expect(envelope.page).toEqual(page);
    expect(envelope.warnings).toEqual([]);
  });

  test("empty records still success-shaped", () => {
    const resolved = resolveCompactFields("project.task");
    const fieldsReport = computeFieldsReport(
      { fields: resolved.fields, explicit: false },
      [],
      [],
      "project.task"
    );
    const page = buildPageMetadata({ offset: 0, limit: 10, count: 0, returned: 0 });

    const envelope = buildCompactReadEnvelope({
      model: "project.task",
      records: [],
      resolved,
      fieldsReport,
      page,
      warnings: ["note"]
    });

    expect(envelope.records).toEqual([]);
    expect(envelope.warnings).toEqual(["note"]);
    expect(envelope.page.has_more).toBe(false);
  });
});

describe("mcpAggregationErrorFromException", () => {
  function parseEnvelope(result: ReturnType<typeof mcpAggregationErrorFromException>) {
    expect(result.isError).toBe(true);
    return JSON.parse(result.content[0].text);
  }

  test("404 read_group maps to unsupported_model with recoverable:true", () => {
    const err = new OdooError({
      message: "not found",
      code: "model_or_method_not_found",
      httpStatus: 404,
      model: "foo.bar",
      method: "read_group",
      details: "Model foo.bar not found"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "foo.bar" }));
    expect(envelope.diagnosis).toBe("unsupported_model");
    expect(envelope.error).toBe("unsupported_model");
    expect(envelope.operation).toBe("aggregate_records");
    expect(envelope.recoverable).toBe(true);
    expect(envelope.http_status).toBe(404);
  });

  test("401 maps to unauthorized with recoverable:false", () => {
    const err = new OdooError({
      message: "unauthorized",
      code: "unauthorized",
      httpStatus: 401,
      model: "project.task",
      method: "read_group",
      details: "Invalid API key"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "project.task" }));
    expect(envelope.diagnosis).toBe("unauthorized");
    expect(envelope.recoverable).toBe(false);
  });

  test("403 maps to permission_denied with recoverable:false", () => {
    const err = new OdooError({
      message: "forbidden",
      code: "permission_denied",
      httpStatus: 403,
      model: "project.task",
      method: "read_group",
      details: "Access Denied"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "project.task" }));
    expect(envelope.diagnosis).toBe("permission_denied");
    expect(envelope.recoverable).toBe(false);
  });

  test("400 with invalid field maps to invalid_groupby", () => {
    const err = new OdooError({
      message: "bad groupby",
      code: "invalid_request",
      httpStatus: 400,
      model: "project.task",
      method: "read_group",
      details: "Invalid field 'bogus' in groupby"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "project.task" }));
    expect(envelope.diagnosis).toBe("invalid_groupby");
    expect(envelope.recoverable).toBe(false);
  });

  test("400 with invalid aggregator maps to unsupported_aggregate", () => {
    const err = new OdooError({
      message: "bad aggregate",
      code: "invalid_request",
      httpStatus: 400,
      model: "project.task",
      method: "read_group",
      details: "Invalid aggregator for field amount"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "project.task" }));
    expect(envelope.diagnosis).toBe("unsupported_aggregate");
    expect(envelope.recoverable).toBe(false);
  });

  test("opaque 400 maps to connector_bug", () => {
    const err = new OdooError({
      message: "bad request",
      code: "invalid_request",
      httpStatus: 400,
      model: "project.task",
      method: "read_group",
      details: "Something completely unrelated went wrong"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "project.task" }));
    expect(envelope.diagnosis).toBe("connector_bug");
    expect(envelope.recoverable).toBe(false);
  });

  test("non-OdooError maps to connector_bug", () => {
    const envelope = parseEnvelope(
      mcpAggregationErrorFromException(new Error("upstream 502"), { model: "project.task" })
    );
    expect(envelope.diagnosis).toBe("connector_bug");
    expect(envelope.error).toBe("connector_bug");
    expect(envelope.http_status).toBeNull();
    expect(envelope.recoverable).toBe(false);
  });

  test("redacts API keys from details", () => {
    const err = new OdooError({
      message: "leak",
      code: "invalid_request",
      httpStatus: 400,
      model: "project.task",
      method: "read_group",
      details: "Auth failed for key odoo_abc123secret in context"
    });
    const envelope = parseEnvelope(mcpAggregationErrorFromException(err, { model: "project.task" }));
    expect(envelope.details).not.toContain("odoo_abc123secret");
    expect(envelope.details).toContain("[REDACTED]");
  });
});

describe("mcpErrorFromException non-regression", () => {
  test("OdooError envelope is unchanged (no diagnosis field)", () => {
    const err = new OdooError({
      message: "forbidden",
      code: "permission_denied",
      httpStatus: 403,
      model: "account.move",
      method: "write",
      details: "Access Denied by Odoo"
    });
    const result = mcpErrorFromException(err);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope).toEqual({
      error: "permission_denied",
      model: "account.move",
      method: "write",
      http_status: 403,
      details: "Access Denied by Odoo",
      recoverable: false
    });
    expect(envelope.diagnosis).toBeUndefined();
    expect(envelope.operation).toBeUndefined();
  });
});

describe("redactDetails", () => {
  test("redacts odoo API keys and bearer tokens", () => {
    const text = "Bearer odoo_deadbeef and odoo_abc123secret leaked";
    const redacted = redactDetails(text);
    expect(redacted).not.toContain("odoo_abc123secret");
    expect(redacted).not.toContain("odoo_deadbeef");
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("[REDACTED]");
  });
});
