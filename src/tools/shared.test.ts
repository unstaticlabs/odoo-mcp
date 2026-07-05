import { describe, expect, test } from "bun:test";
import {
  CORE_MODEL_ALLOWLIST,
  DEFAULT_GENERIC_FIELDS,
  DEFAULT_TASK_FIELDS,
  MODEL_FIELD_PRESETS,
  resolveFields
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
