import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_MOVE_PATHS,
  MODEL_ACTION_PATHS,
  annotateRecordUrl,
  annotateRecordUrls,
  buildRecordUrl,
  odooOrigin,
  recordRoutePath,
  toRecordId
} from "./record-urls";

/** Production origin the documented examples use. */
const ORIGIN = "https://odoo.unstaticlabs.com";

describe("odooOrigin", () => {
  test("strips trailing slashes so routes never double up", () => {
    expect(odooOrigin("https://odoo.unstaticlabs.com/")).toBe(ORIGIN);
    expect(odooOrigin("https://odoo.unstaticlabs.com///")).toBe(ORIGIN);
    expect(odooOrigin(ORIGIN)).toBe(ORIGIN);
  });
});

describe("toRecordId", () => {
  test("reads ids out of bare numbers and many2one pairs, rejecting unset relations", () => {
    expect(toRecordId(42)).toBe(42);
    expect(toRecordId([17, "Odoo MCP"])).toBe(17);
    expect(toRecordId(false)).toBeNull();
    expect(toRecordId(null)).toBeNull();
    expect(toRecordId(0)).toBeNull();
    expect(toRecordId(-3)).toBeNull();
    expect(toRecordId("12")).toBeNull();
  });
});

describe("project.task routing", () => {
  test("nests under the owning project when project_id is known", () => {
    expect(buildRecordUrl(ORIGIN, "project.task", 2266, { project_id: [17, "odoo-mcp"] })).toBe(
      `${ORIGIN}/odoo/project/17/tasks/2266`
    );
    // Writes pass a bare id rather than a many2one pair.
    expect(buildRecordUrl(ORIGIN, "project.task", 2266, { project_id: 17 })).toBe(
      `${ORIGIN}/odoo/project/17/tasks/2266`
    );
  });

  test("a sub-task keeps its own project route, not its parent task's id", () => {
    expect(
      buildRecordUrl(ORIGIN, "project.task", 2270, { project_id: [17, "odoo-mcp"], parent_id: [2266, "Parent"] })
    ).toBe(`${ORIGIN}/odoo/project/17/tasks/2270`);
  });

  test("falls back to All Tasks when the project is unknown or unset", () => {
    expect(buildRecordUrl(ORIGIN, "project.task", 2266)).toBe(`${ORIGIN}/odoo/all-tasks/2266`);
    expect(buildRecordUrl(ORIGIN, "project.task", 2266, { project_id: false })).toBe(
      `${ORIGIN}/odoo/all-tasks/2266`
    );
  });
});

describe("account.move routing", () => {
  test("routes each move_type to its own verified action path", () => {
    expect(buildRecordUrl(ORIGIN, "account.move", 9921, { move_type: "in_invoice" })).toBe(
      `${ORIGIN}/odoo/vendor-bills/9921`
    );
    expect(buildRecordUrl(ORIGIN, "account.move", 9844, { move_type: "entry" })).toBe(
      `${ORIGIN}/odoo/entries/9844`
    );
    expect(buildRecordUrl(ORIGIN, "account.move", 100, { move_type: "out_invoice" })).toBe(
      `${ORIGIN}/odoo/customer-invoices/100`
    );
    expect(buildRecordUrl(ORIGIN, "account.move", 101, { move_type: "out_refund" })).toBe(
      `${ORIGIN}/odoo/credit-notes/101`
    );
    expect(buildRecordUrl(ORIGIN, "account.move", 102, { move_type: "in_refund" })).toBe(
      `${ORIGIN}/odoo/vendor-refunds/102`
    );
  });

  test("degrades to Journal Entries — which holds every move — when move_type was not read", () => {
    expect(buildRecordUrl(ORIGIN, "account.move", 9844)).toBe(`${ORIGIN}/odoo/entries/9844`);
    expect(buildRecordUrl(ORIGIN, "account.move", 9844, { move_type: "not_a_type" })).toBe(
      `${ORIGIN}/odoo/entries/9844`
    );
  });
});

describe("curated and generic model routes", () => {
  test("frequently surfaced models use their verified action path", () => {
    expect(buildRecordUrl(ORIGIN, "res.partner", 512)).toBe(`${ORIGIN}/odoo/contacts/512`);
    expect(buildRecordUrl(ORIGIN, "hr.expense", 394)).toBe(`${ORIGIN}/odoo/expenses/394`);
    expect(buildRecordUrl(ORIGIN, "project.project", 17)).toBe(`${ORIGIN}/odoo/project/17`);
    expect(buildRecordUrl(ORIGIN, "account.move.line", 77)).toBe(`${ORIGIN}/odoo/items/77`);
    expect(buildRecordUrl(ORIGIN, "product.category", 7)).toBe(`${ORIGIN}/odoo/product-categories/7`);
  });

  test("payment and picking pick a route from their direction field", () => {
    expect(buildRecordUrl(ORIGIN, "account.payment", 55, { payment_type: "outbound" })).toBe(
      `${ORIGIN}/odoo/vendor-payments/55`
    );
    expect(buildRecordUrl(ORIGIN, "stock.picking", 60, { picking_type_code: "incoming" })).toBe(
      `${ORIGIN}/odoo/receipts/60`
    );
    // Unknown direction → the generic model route, never a guessed one.
    expect(buildRecordUrl(ORIGIN, "account.payment", 55)).toBe(`${ORIGIN}/odoo/account.payment/55`);
  });

  test("models without a curated path use the dotted model route Odoo's own router accepts", () => {
    expect(buildRecordUrl(ORIGIN, "account.bank.statement.line", 431)).toBe(
      `${ORIGIN}/odoo/account.bank.statement.line/431`
    );
    expect(buildRecordUrl(ORIGIN, "x.custom.model", 9)).toBe(`${ORIGIN}/odoo/x.custom.model/9`);
  });

  test("an undotted model name takes the m- prefix so it is not read as an action path", () => {
    expect(recordRoutePath("board", 3)).toBe("m-board/3");
  });
});

describe("buildRecordUrl guards", () => {
  test("returns null rather than a broken link when it cannot address a record", () => {
    expect(buildRecordUrl("", "project.task", 1)).toBeNull();
    expect(buildRecordUrl(undefined, "project.task", 1)).toBeNull();
    expect(buildRecordUrl(ORIGIN, "", 1)).toBeNull();
    expect(buildRecordUrl(ORIGIN, "   ", 1)).toBeNull();
    expect(buildRecordUrl(ORIGIN, "project.task", 0)).toBeNull();
    expect(buildRecordUrl(ORIGIN, "project.task", "2266")).toBeNull();
  });
});

describe("annotation helpers", () => {
  test("annotateRecordUrl adds _web_url without mutating the source record", () => {
    const record = { id: 2266, name: "VAT refunds", project_id: [17, "odoo-mcp"] };
    const annotated = annotateRecordUrl(ORIGIN, "project.task", record);

    expect(annotated._web_url).toBe(`${ORIGIN}/odoo/project/17/tasks/2266`);
    expect(record).not.toHaveProperty("_web_url");
  });

  test("rows without a usable id pass through untouched", () => {
    const row = { stage_id: [1, "New"], __count: 3 };
    expect(annotateRecordUrl(ORIGIN, "project.task", row)).toEqual(row);
    expect(annotateRecordUrl("", "project.task", { id: 1 })).toEqual({ id: 1 });
  });

  test("annotateRecordUrls annotates every row of a result set", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    expect(annotateRecordUrls(ORIGIN, "res.partner", rows)).toEqual([
      { id: 1, _web_url: `${ORIGIN}/odoo/contacts/1` },
      { id: 2, _web_url: `${ORIGIN}/odoo/contacts/2` }
    ]);
  });
});

describe("route table hygiene", () => {
  test("no curated path is empty, slashed, or duplicated across models", () => {
    const paths = Object.values(MODEL_ACTION_PATHS);
    for (const path of paths) {
      expect(path.length).toBeGreaterThan(0);
      expect(path).not.toContain("/");
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("account.move variants are routed for every Odoo move_type", () => {
    expect(Object.keys(ACCOUNT_MOVE_PATHS).sort()).toEqual([
      "entry",
      "in_invoice",
      "in_refund",
      "out_invoice",
      "out_refund"
    ]);
  });

  test("project.task and account.move are resolved by their own branches, not the curated map", () => {
    expect(MODEL_ACTION_PATHS["project.task"]).toBeUndefined();
    expect(MODEL_ACTION_PATHS["account.move"]).toBeUndefined();
  });
});
