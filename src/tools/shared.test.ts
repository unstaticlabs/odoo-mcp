import { describe, expect, test } from "bun:test";
import {
  resolveFieldPreset,
  resolveFields,
  CORE_MODEL_ALLOWLIST,
  DEFAULT_TASK_FIELDS,
  DEFAULT_GENERIC_FIELDS,
  MODEL_FIELD_PRESETS,
  computeFieldsReport,
  ALL_FIELDS_SENTINEL,
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

describe("resolveNamedFieldPreset", () => {
  test("minimal preset on project.task returns curated minimal fields with preset provenance", async () => {
    const { resolveNamedFieldPreset } = await import("./shared");
    const task = resolveNamedFieldPreset("project.task", "minimal");
    expect(task.fields).toEqual(DEFAULT_TASK_FIELDS);
    expect(task.preset).toBe("minimal");
    expect(task.source).toBe("preset");
    expect(task.model).toBe("project.task");
  });

  test("tracking_minimal on project.task returns tracking-oriented subset", async () => {
    const { resolveNamedFieldPreset, NAMED_MODEL_FIELD_PRESETS } = await import("./shared");
    const tracking = resolveNamedFieldPreset("project.task", "tracking_minimal");
    expect(tracking.fields).toEqual(NAMED_MODEL_FIELD_PRESETS.tracking_minimal["project.task"]);
    expect(tracking.fields).toContain("priority");
    expect(tracking.fields).toContain("stage_id");
    expect(tracking.preset).toBe("tracking_minimal");
    expect(tracking.source).toBe("preset");
  });

  test("financial_minimal on account.move returns finance-oriented subset", async () => {
    const { resolveNamedFieldPreset, NAMED_MODEL_FIELD_PRESETS } = await import("./shared");
    const financial = resolveNamedFieldPreset("account.move", "financial_minimal");
    expect(financial.fields).toEqual(NAMED_MODEL_FIELD_PRESETS.financial_minimal["account.move"]);
    expect(financial.fields).toContain("amount_untaxed");
    expect(financial.fields).toContain("amount_total");
    expect(financial.preset).toBe("financial_minimal");
    expect(financial.source).toBe("preset");
  });

  test("each preset on unknown model falls back to safe generic minimal set", async () => {
    const { resolveNamedFieldPreset } = await import("./shared");
    const minimal = resolveNamedFieldPreset("some.unknown.model", "minimal");
    expect(minimal.fields).toEqual(DEFAULT_GENERIC_FIELDS);
    expect(minimal.source).toBe("fallback");

    const tracking = resolveNamedFieldPreset("some.unknown.model", "tracking_minimal");
    expect(tracking.fields).toEqual(["id", "display_name", "state"]);
    expect(tracking.source).toBe("fallback");

    const financial = resolveNamedFieldPreset("some.unknown.model", "financial_minimal");
    expect(financial.fields).toEqual(["id", "display_name", "amount_total"]);
    expect(financial.source).toBe("fallback");
  });

  test("explicit non-empty fields win over any field_preset", async () => {
    const { resolveNamedFieldPreset } = await import("./shared");
    const r = resolveNamedFieldPreset("project.task", "tracking_minimal", ["id", "name"]);
    expect(r.fields).toEqual(["id", "name"]);
    expect(r.preset).toBeNull();
    expect(r.source).toBe("explicit");
  });

  test("empty fields array with preset applies preset, not explicit", async () => {
    const { resolveNamedFieldPreset, NAMED_MODEL_FIELD_PRESETS } = await import("./shared");
    const r = resolveNamedFieldPreset("project.task", "tracking_minimal", []);
    expect(r.preset).toBe("tracking_minimal");
    expect(r.source).toBe("preset");
    expect(r.fields).toEqual(NAMED_MODEL_FIELD_PRESETS.tracking_minimal["project.task"]);
  });
});

describe("buildBrowsePageMeta", () => {
  test("first page with more rows exposes has_more and next_offset", async () => {
    const { buildBrowsePageMeta } = await import("./shared");
    const page = buildBrowsePageMeta(0, 10, 25, 10);
    expect(page).toEqual({
      offset: 0,
      limit: 10,
      count: 25,
      returned: 10,
      has_more: true,
      next_offset: 10
    });
  });

  test("last partial page has no remainder", async () => {
    const { buildBrowsePageMeta } = await import("./shared");
    const page = buildBrowsePageMeta(20, 10, 25, 5);
    expect(page).toEqual({
      offset: 20,
      limit: 10,
      count: 25,
      returned: 5,
      has_more: false,
      next_offset: null
    });
  });

  test("exact fit page has no has_more", async () => {
    const { buildBrowsePageMeta } = await import("./shared");
    const page = buildBrowsePageMeta(10, 10, 20, 10);
    expect(page).toEqual({
      offset: 10,
      limit: 10,
      count: 20,
      returned: 10,
      has_more: false,
      next_offset: null
    });
  });

  test("empty result set returns zero counts and no has_more", async () => {
    const { buildBrowsePageMeta } = await import("./shared");
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
});

describe("applyBrowseSafeguard", () => {
  test("normal page under byte budget passes through unchanged", async () => {
    const { applyBrowseSafeguard } = await import("./shared");
    expect(applyBrowseSafeguard(1000, 25, "minimal", false)).toEqual({ action: "accept" });
  });

  test("oversized estimated payload recommends reduced limit on first attempt", async () => {
    const { applyBrowseSafeguard, BROWSE_MAX_PAYLOAD_BYTES } = await import("./shared");
    const plan = applyBrowseSafeguard(BROWSE_MAX_PAYLOAD_BYTES + 1, 50, "minimal", false);
    expect(plan).toEqual({
      action: "retry",
      newLimit: 25,
      newPreset: "minimal",
      safeguardApplied: "limit reduced 50→25 due to payload size"
    });
  });

  test("already at minimum limit with non-minimal preset downgrades preset", async () => {
    const { applyBrowseSafeguard, BROWSE_MAX_PAYLOAD_BYTES, BROWSE_MIN_LIMIT } = await import("./shared");
    const plan = applyBrowseSafeguard(BROWSE_MAX_PAYLOAD_BYTES + 1, BROWSE_MIN_LIMIT, "financial_minimal", false);
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") {
      expect(plan.newPreset).toBe("minimal");
      expect(plan.newLimit).toBe(BROWSE_MIN_LIMIT);
    }
  });

  test("still oversized after retry rejects with recoverable structured message", async () => {
    const { applyBrowseSafeguard, BROWSE_MAX_PAYLOAD_BYTES, BROWSE_MIN_LIMIT } = await import("./shared");
    const plan = applyBrowseSafeguard(BROWSE_MAX_PAYLOAD_BYTES + 1, BROWSE_MIN_LIMIT, "minimal", true);
    expect(plan.action).toBe("reject");
    if (plan.action === "reject") {
      expect(plan.message).toContain("Result too large");
    }
  });
});

describe("browse cursor", () => {
  test("encode/decode yields stable next_cursor for same query inputs", async () => {
    const { encodeBrowseCursor, decodeBrowseCursor } = await import("./shared");
    const query = {
      model: "project.task",
      domain: [["active", "=", true]] as unknown[],
      order: "id asc"
    };
    const cursor1 = encodeBrowseCursor({ offset: 10, ...query });
    const cursor2 = encodeBrowseCursor({ offset: 10, ...query });
    expect(cursor1).toBe(cursor2);

    const decoded = decodeBrowseCursor(cursor1, query);
    expect(decoded).toEqual({ offset: 10 });
  });

  test("rejects stale cursor when domain differs", async () => {
    const { encodeBrowseCursor, decodeBrowseCursor } = await import("./shared");
    const cursor = encodeBrowseCursor({ offset: 10, model: "project.task", domain: [] });
    const decoded = decodeBrowseCursor(cursor, { model: "project.task", domain: [["id", ">", 0]] });
    expect(decoded).toEqual({ error: "cursor does not match current query" });
  });
});
