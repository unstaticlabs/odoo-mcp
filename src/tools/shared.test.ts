import { describe, expect, test } from "bun:test";
import {
  CORE_MODEL_ALLOWLIST,
  DEFAULT_GENERIC_FIELDS,
  DEFAULT_TASK_FIELDS,
  MODEL_FIELD_PRESETS,
  resolveFields,
  computeFieldsReport,
  ALL_FIELDS_SENTINEL
} from "./shared";

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
