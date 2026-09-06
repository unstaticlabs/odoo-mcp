import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertBoundedDomain,
  assertBoundedJson,
  assertDomainStructure,
  attributedContext,
  decodeCursor,
  decodePageCursor,
  DomainSchema,
  encodeCursor,
  encodePageCursor,
  keysetDirection,
  normalizeWriteValues,
  queryFingerprint,
  resolveCallScope,
  SpecificationSchema
} from "../../src/odoo/schemas.js";

describe("generic substrate bounds", () => {
  it("round-trips every supported cursor offset", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.string({ minLength: 1, maxLength: 64 }),
      (offset, fingerprint) => {
        expect(decodeCursor(encodeCursor(offset, fingerprint), fingerprint)).toBe(offset);
      }
    ));
  });

  it("binds a cursor to its query fingerprint", () => {
    const cursor = encodeCursor(10, queryFingerprint({ model: "res.partner" }));
    expect(() => decodeCursor(cursor, queryFingerprint({ model: "project.task" }))).toThrow(
      "cursor does not match"
    );
  });

  it("preserves caller context except connector-owned attribution", () => {
    const result = attributedContext({
      lang: "en_US",
      allowed_company_ids: [1, 2],
      usl_agent_origin: "forged",
      usl_correlation_id: "forged",
      usl_future_connector_field: "forged"
    }, "correlation-1");
    expect(result).toEqual({
      lang: "en_US",
      allowed_company_ids: [1, 2],
      usl_agent_origin: "odoo-mcp",
      usl_correlation_id: "correlation-1"
    });
  });

  it("accepts bounded JSON values and rejects depth, key, and byte overflow", () => {
    assertBoundedJson({ values: [1, true, null, "ok"] });
    let tooDeep: unknown = 1;
    for (let depth = 0; depth < 9; depth++) tooDeep = { nested: tooDeep };
    expect(() => assertBoundedJson(tooDeep)).toThrow("8 levels");
    expect(() => assertBoundedJson(Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`key_${index}`, index])
    ))).toThrow("200 object keys");
    expect(() => assertBoundedJson("x".repeat(100), 50)).toThrow("50-byte limit");
  });

  it("rejects unbounded Odoo domains", () => {
    assertBoundedDomain([["name", "ilike", "USL"]]);
    expect(() => assertBoundedDomain("name = USL")).toThrow("domain must be an Odoo domain array");
    expect(() => assertBoundedDomain(Array.from({ length: 201 }, () => "|"))).toThrow("200 nodes");
  });
});

describe("typed Odoo domains", () => {
  it("accepts the domain shapes Odoo accepts", () => {
    for (const domain of [
      [],
      [["name", "ilike", "USL"]],
      [["partner_id.country_id.code", "=", "FR"]],
      [["a", "=", 1], ["b", "=", 2]],
      ["|", ["a", "=", 1], ["b", "=", 2]],
      ["!", ["a", "=", 1]],
      ["&", "|", ["a", "=", 1], ["b", "=", 2], ["c", "=", 3]],
      [["order_line", "any", [["price_unit", ">", 10]]]],
      [[1, "=", 1]]
    ]) {
      expect(DomainSchema.safeParse(domain), JSON.stringify(domain)).toMatchObject({ success: true });
    }
  });

  it("rejects a connective left without enough conditions", () => {
    // The classic malformed domain: "|" promises two conditions and gets one.
    expect(() => assertDomainStructure(["|", ["a", "=", 1]])).toThrow("prefix notation");
    expect(() => assertDomainStructure(["&", ["a", "=", 1]])).toThrow("prefix notation");
    expect(() => assertDomainStructure(["!"])).toThrow("prefix notation");
    assertDomainStructure([]);
    assertDomainStructure(["|", ["a", "=", 1], ["b", "=", 2]]);
  });

  it("rejects unknown operators and malformed leaves before Odoo sees them", () => {
    expect(DomainSchema.safeParse([["name", "matches", "USL"]]).success).toBe(false);
    expect(DomainSchema.safeParse([["name", "ilike"]]).success).toBe(false);
    expect(DomainSchema.safeParse(["AND", ["a", "=", 1], ["b", "=", 2]]).success).toBe(false);
    expect(DomainSchema.safeParse([["9bad", "=", 1]]).success).toBe(false);
  });

  it("still enforces the existing size bounds", () => {
    expect(DomainSchema.safeParse(Array.from({ length: 201 }, () => "|")).success).toBe(false);
  });
});

describe("relational write values", () => {
  it("lowers the named command form to Odoo command tuples in a fixed order", () => {
    expect(normalizeWriteValues({
      name: "Untouched",
      tag_ids: { link: [4, 5], unlink: [6] },
      line_ids: { create: [{ name: "Line" }], update: [{ id: 3, values: { qty: 2 } }] },
      child_ids: { set: [1, 2] },
      other_ids: { clear: true }
    })).toEqual({
      name: "Untouched",
      tag_ids: [[3, 6, 0], [4, 4, 0], [4, 5, 0]],
      line_ids: [[1, 3, { qty: 2 }], [0, 0, { name: "Line" }]],
      child_ids: [[6, 0, [1, 2]]],
      other_ids: [[5, 0, 0]]
    });
  });

  it("normalizes two-element command tuples and leaves plain values alone", () => {
    expect(normalizeWriteValues({ tag_ids: [[4, 7], [6, 0, [1]]] }))
      .toEqual({ tag_ids: [[4, 7, 0], [6, 0, [1]]] });
    expect(normalizeWriteValues({ partner_id: 5, active: false, ids: [1, 2, 3] }))
      .toEqual({ partner_id: 5, active: false, ids: [1, 2, 3] });
  });

  it("names the field when a command object is malformed", () => {
    expect(() => normalizeWriteValues({ tag_ids: { link: ["not-an-id"] } }))
      .toThrow("tag_ids looks like a relational command object");
    expect(() => normalizeWriteValues({ tag_ids: { clear: true, set: [1] } }))
      .toThrow("may not combine");
  });
});

describe("named call scope", () => {
  it("maps named parameters onto the Odoo context keys they control", () => {
    const { context, warnings } = resolveCallScope(
      { company_ids: [1, 2], lang: "fr_FR", active_test: false },
      "correlation-1"
    );
    expect(context).toMatchObject({
      allowed_company_ids: [1, 2],
      lang: "fr_FR",
      active_test: false,
      usl_agent_origin: "odoo-mcp",
      usl_correlation_id: "correlation-1"
    });
    expect(warnings).toEqual([]);
  });

  it("reports an override rather than silently discarding a context key", () => {
    const { context, warnings } = resolveCallScope(
      { company_ids: [3], context: { allowed_company_ids: [1], lang: "en_US" } },
      "correlation-1"
    );
    expect(context.allowed_company_ids).toEqual([3]);
    expect(context.lang).toBe("en_US");
    expect(warnings).toEqual([
      "The company_ids parameter overrode context.allowed_company_ids; the named parameter is authoritative."
    ]);
  });

  it("leaves the context untouched when no named scope is supplied", () => {
    const { context, warnings } = resolveCallScope({ context: { lang: "en_US" } }, "correlation-1");
    expect(context).toEqual({
      lang: "en_US",
      usl_agent_origin: "odoo-mcp",
      usl_correlation_id: "correlation-1"
    });
    expect(warnings).toEqual([]);
  });
});

describe("page cursors", () => {
  it("round-trips keyset and offset cursors bound to one fingerprint", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10_000_000 }),
      fc.string({ minLength: 1, maxLength: 64 }),
      (after, fingerprint) => {
        expect(decodePageCursor(encodePageCursor({ kind: "keyset", after }, fingerprint), fingerprint))
          .toEqual({ kind: "keyset", after });
        expect(decodePageCursor(encodePageCursor({ kind: "offset", offset: after }, fingerprint), fingerprint))
          .toEqual({ kind: "offset", offset: after });
      }
    ));
    expect(decodePageCursor(undefined, "any")).toEqual({ kind: "offset", offset: 0 });
  });

  it("refuses a keyset cursor where an offset is required", () => {
    const cursor = encodePageCursor({ kind: "keyset", after: 5 }, "fp");
    expect(() => decodeCursor(cursor, "fp")).toThrow("cursor does not match");
  });

  it("pages by keyset only when the order is id alone", () => {
    expect(keysetDirection("id asc")).toBe("asc");
    expect(keysetDirection("  ID DESC ")).toBe("desc");
    expect(keysetDirection("id")).toBeUndefined();
    expect(keysetDirection("name asc, id asc")).toBeUndefined();
    expect(keysetDirection("create_date desc")).toBeUndefined();
  });
});

describe("read specifications", () => {
  it("accepts nested specifications and bounds their depth", () => {
    expect(SpecificationSchema.safeParse({ name: {}, partner_id: { fields: { display_name: {} } } }).success).toBe(true);
    expect(SpecificationSchema.safeParse({}).success).toBe(false);
    expect(SpecificationSchema.safeParse({ a: { bogus: 1 } }).success).toBe(false);
    let deep: Record<string, unknown> = {};
    for (let level = 0; level < 5; level++) deep = { fields: { [`f${level}`]: deep } };
    expect(SpecificationSchema.safeParse({ root: deep }).success).toBe(false);
  });
});
