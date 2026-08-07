/**
 * Narrow inventory master-data graduation (cards ODOO2240, ODOO2255) — pure helpers.
 *
 * The two parent-nested graduated models nest through *different* parent fields; getting that wrong
 * turns the duplicate preflight into a silent no-op, so it is asserted per model here. The third,
 * `product.template`, is flat — graduation must not be derived from "has a parent field".
 */
import { describe, expect, test } from "bun:test";
import {
  buildDuplicateDomain,
  buildInventoryDuplicateChecks,
  INVENTORY_MASTER_DATA_MODELS,
  inventoryMasterDataParentField,
  isInventoryMasterDataModel,
  normalizeParentValue
} from "./inventory-master-data";

describe("graduated model list", () => {
  test("contains exactly product.category, stock.location and product.template", () => {
    expect([...INVENTORY_MASTER_DATA_MODELS].sort()).toEqual([
      "product.category",
      "product.template",
      "stock.location"
    ]);
  });

  test("sibling product.* / stock.* models are not graduated", () => {
    for (const model of ["product.product", "stock.picking", "stock.move", "stock.quant"]) {
      expect(isInventoryMasterDataModel(model)).toBe(false);
      expect(inventoryMasterDataParentField(model)).toBeUndefined();
    }
  });

  test("product.template is graduated even though it has no parent field", () => {
    expect(isInventoryMasterDataModel("product.template")).toBe(true);
    expect(inventoryMasterDataParentField("product.template")).toBeUndefined();
  });
});

describe("parent field per model", () => {
  test("product.category nests via parent_id", () => {
    expect(inventoryMasterDataParentField("product.category")).toBe("parent_id");
  });

  test("stock.location nests via location_id, not parent_id", () => {
    expect(inventoryMasterDataParentField("stock.location")).toBe("location_id");
  });
});

describe("normalizeParentValue", () => {
  test("absent / false / null / zero / empty means no parent (root)", () => {
    for (const raw of [undefined, null, false, 0, ""]) {
      expect(normalizeParentValue(raw)).toBe(false);
    }
  });

  test("plain id and numeric string coerce to the id", () => {
    expect(normalizeParentValue(12)).toBe(12);
    expect(normalizeParentValue("12")).toBe(12);
  });

  test("many2one [id, display_name] pair coerces to the id", () => {
    expect(normalizeParentValue([12, "Saleable"])).toBe(12);
  });

  test("unrecognized shapes return undefined so callers skip rather than guess", () => {
    expect(normalizeParentValue({ id: 12 })).toBeUndefined();
    expect(normalizeParentValue("Saleable")).toBeUndefined();
    expect(normalizeParentValue(-3)).toBeUndefined();
    expect(normalizeParentValue(1.5)).toBeUndefined();
    expect(normalizeParentValue([[6, 0, [1]]])).toBeUndefined();
  });
});

describe("buildDuplicateDomain", () => {
  test("root record matches parent = false", () => {
    expect(buildDuplicateDomain("Consumables", "parent_id", false)).toEqual([
      ["name", "=", "Consumables"],
      ["parent_id", "=", false]
    ]);
  });

  test("nested record matches the parent id (3-tuple equality)", () => {
    expect(buildDuplicateDomain("Shelf 1", "location_id", 8)).toEqual([
      ["name", "=", "Shelf 1"],
      ["location_id", "=", 8]
    ]);
  });
});

describe("buildInventoryDuplicateChecks — parent-nested models", () => {
  test("product.category is one name+parent_id check", () => {
    expect(buildInventoryDuplicateChecks("product.category", { name: " Consumables ", parent_id: 3 })).toEqual([
      {
        domain: [
          ["name", "=", "Consumables"],
          ["parent_id", "=", 3]
        ],
        fields: ["id", "name", "parent_id"],
        blocked_fields: ["name", "parent_id"],
        describes: 'named "Consumables" under parent_id 3',
        retry: "create under a different parent_id, or with a distinct name"
      }
    ]);
  });

  test("stock.location scopes by location_id and reads it back", () => {
    const [check] = buildInventoryDuplicateChecks("stock.location", { name: "Shelf 1", location_id: [8, "WH/Stock"] });
    expect(check.domain).toEqual([
      ["name", "=", "Shelf 1"],
      ["location_id", "=", 8]
    ]);
    expect(check.fields).toEqual(["id", "name", "location_id"]);
  });

  test("a root record is described as such rather than as `parent_id false`", () => {
    const [check] = buildInventoryDuplicateChecks("product.category", { name: "Top Level" });
    expect(check.domain).toEqual([
      ["name", "=", "Top Level"],
      ["parent_id", "=", false]
    ]);
    expect(check.describes).toBe('named "Top Level" under no parent (root)');
  });

  test("no name, or an unreadable parent, yields no checks", () => {
    expect(buildInventoryDuplicateChecks("product.category", { parent_id: 3 })).toEqual([]);
    expect(buildInventoryDuplicateChecks("product.category", { name: "   ", parent_id: 3 })).toEqual([]);
    expect(buildInventoryDuplicateChecks("product.category", { name: "X", parent_id: { id: 3 } })).toEqual([]);
  });

  test("non-graduated models yield no checks at all", () => {
    expect(buildInventoryDuplicateChecks("product.product", { name: "Widget" })).toEqual([]);
  });
});

describe("buildInventoryDuplicateChecks — product.template", () => {
  test("scopes by company_id, not by a parent field", () => {
    expect(buildInventoryDuplicateChecks("product.template", { name: "Blue Mug", company_id: 2 })).toEqual([
      {
        domain: [
          ["name", "=", "Blue Mug"],
          ["company_id", "=", 2]
        ],
        fields: ["id", "name", "company_id"],
        blocked_fields: ["name", "company_id"],
        describes: 'named "Blue Mug" under company_id 2',
        retry: "create under a different company_id, or with a distinct name"
      }
    ]);
  });

  test("an absent company means shared across companies (company_id = false)", () => {
    const [check] = buildInventoryDuplicateChecks("product.template", { name: "Blue Mug" });
    expect(check.domain).toEqual([
      ["name", "=", "Blue Mug"],
      ["company_id", "=", false]
    ]);
    expect(check.describes).toBe('named "Blue Mug" under no company (shared)');
  });

  test("a non-empty default_code adds a second SKU+company check", () => {
    const checks = buildInventoryDuplicateChecks("product.template", {
      name: "Blue Mug",
      company_id: 2,
      default_code: " MUG-BLUE "
    });
    expect(checks).toHaveLength(2);
    expect(checks[1]).toEqual({
      domain: [
        ["default_code", "=", "MUG-BLUE"],
        ["company_id", "=", 2]
      ],
      fields: ["id", "name", "default_code", "company_id"],
      blocked_fields: ["default_code", "company_id"],
      describes: 'with default_code "MUG-BLUE" under company_id 2',
      retry: "create with a distinct default_code"
    });
  });

  test("an empty or non-string default_code skips only that second check", () => {
    for (const default_code of [undefined, "", "   ", false, 42]) {
      expect(buildInventoryDuplicateChecks("product.template", { name: "Blue Mug", default_code })).toHaveLength(1);
    }
  });

  test("no name, or an unreadable company_id, yields no checks", () => {
    expect(buildInventoryDuplicateChecks("product.template", { default_code: "MUG-BLUE" })).toEqual([]);
    expect(buildInventoryDuplicateChecks("product.template", { name: "Blue Mug", company_id: "Acme" })).toEqual([]);
  });
});
