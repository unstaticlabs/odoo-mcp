/**
 * Narrow inventory master-data graduation (card ODOO2240) — pure helpers.
 *
 * The two graduated models nest through *different* parent fields; getting that wrong turns the
 * duplicate preflight into a silent no-op, so it is asserted per model here.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDuplicateDomain,
  INVENTORY_MASTER_DATA_MODELS,
  inventoryMasterDataParentField,
  isInventoryMasterDataModel,
  normalizeParentValue
} from "./inventory-master-data";

describe("graduated model list", () => {
  test("contains exactly product.category and stock.location", () => {
    expect([...INVENTORY_MASTER_DATA_MODELS].sort()).toEqual(["product.category", "stock.location"]);
  });

  test("sibling product.* / stock.* models are not graduated", () => {
    for (const model of ["product.product", "product.template", "stock.picking", "stock.move", "stock.quant"]) {
      expect(isInventoryMasterDataModel(model)).toBe(false);
      expect(inventoryMasterDataParentField(model)).toBeUndefined();
    }
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
