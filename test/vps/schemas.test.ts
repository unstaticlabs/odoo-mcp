import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertBoundedDomain,
  assertBoundedJson,
  attributedContext,
  decodeCursor,
  encodeCursor,
  queryFingerprint
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
      usl_idempotency_key: "obsolete"
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
