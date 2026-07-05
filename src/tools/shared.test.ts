import { describe, expect, test } from "bun:test";
import { resolveFieldPreset, DEFAULT_TASK_FIELDS, DEFAULT_GENERIC_FIELDS } from "./shared";

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
