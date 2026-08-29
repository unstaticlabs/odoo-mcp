import { describe, expect, test } from "bun:test";
import {
  childIdempotencyKey,
  correlationIdForKey,
  mergeOdooMutationContext,
  notAppliedMutationExecution,
  parseIdempotencyCapabilities,
  resolveIdempotencyKey
} from "./mutation";

describe("idempotency identifiers", () => {
  test("generates bounded UUID keys", () => {
    const key = resolveIdempotencyKey();
    expect(key).toMatch(/^[a-f0-9-]{36}$/);
  });

  test("rejects malformed caller keys", () => {
    for (const value of ["", " leading", "contains space", "slash/value", "x".repeat(129)]) {
      expect(() => resolveIdempotencyKey(value)).toThrow();
    }
  });

  test("derives deterministic, domain-separated child keys and correlations", async () => {
    const [a, b, c] = await Promise.all([
      childIdempotencyKey("root-key", "batch:0"),
      childIdempotencyKey("root-key", "batch:0"),
      childIdempotencyKey("root-key", "batch:1")
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(await correlationIdForKey("root-key")).toBe(await correlationIdForKey("root-key"));
  });

  test("accepts exactly the documented ASCII key alphabet across the ASCII domain", () => {
    const allowed = /^[A-Za-z0-9._:-]$/;
    for (let code = 0; code <= 127; code++) {
      const character = String.fromCharCode(code);
      const candidate = `A${character}Z`;
      if (allowed.test(character)) {
        expect(resolveIdempotencyKey(candidate)).toBe(candidate);
      } else {
        expect(() => resolveIdempotencyKey(candidate)).toThrow();
      }
    }
  });

  test("child derivation stays bounded and collision-free for a broad stable-step set", async () => {
    const children = await Promise.all(
      Array.from({ length: 512 }, (_, index) => childIdempotencyKey("r".repeat(128), `batch:${index}`))
    );
    expect(new Set(children).size).toBe(children.length);
    expect(children.every((key) => key.length <= 128)).toBe(true);
  });
});

test("reserved Odoo context is connector-authored", () => {
  expect(
    mergeOdooMutationContext(
      { lang: "fr_FR", usl_agent_origin: "spoofed" },
      { tz: "Europe/Paris", usl_correlation_id: "spoofed" },
      {
        idempotency_key: "key",
        idempotency_mode: "odoo_atomic",
        correlation_id: "mcp-correlation"
      },
      "Reconcile the requested record"
    )
  ).toEqual({
    lang: "fr_FR",
    tz: "Europe/Paris",
    usl_agent_origin: "odoo-mcp",
    usl_correlation_id: "mcp-correlation",
    usl_idempotency_key: "key",
    usl_idempotency_mode: "odoo_atomic",
    usl_agent_reason: "Reconcile the requested record"
  });
});

test("capability parsing fails closed on wrong protocol or bounds", () => {
  expect(parseIdempotencyCapabilities({ protocol_version: "1", retention_seconds: 604800, result_size_limit: 2097152 })).toEqual({
    protocol_version: "1",
    retention_seconds: 604800,
    result_size_limit: 2097152
  });
  expect(parseIdempotencyCapabilities({ protocol_version: "2", retention_seconds: 604800, result_size_limit: 2097152 })).toBeNull();
  expect(parseIdempotencyCapabilities({ protocol_version: "1", retention_seconds: 0, result_size_limit: 2097152 })).toBeNull();
});

test("local mutation refusal metadata preserves a supplied key", async () => {
  expect(await notAppliedMutationExecution("local-refusal-42")).toMatchObject({
    idempotency_key: "local-refusal-42",
    idempotency_mode: "unavailable",
    replayed: false,
    outcome: "not_applied"
  });
});
