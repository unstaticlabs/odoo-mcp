import { mock, describe, test, expect } from "bun:test";
import { TtlCache } from "./cache";
import { OdooError } from "./odoo";
import type { OdooQueue } from "./odoo-queue";
import {
  type WritePlan,
  buildAuditEntry,
  canonicalJson,
  checkDateAgainstLocks,
  checkLockExceptionSupport,
  getLockDates,
  issueConfirmationToken,
  verifyConfirmationToken,
  TOKEN_TTL_MS
} from "./safety";

const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };

function fakeQueue(impl: (...args: unknown[]) => unknown) {
  const enqueue = mock(impl);
  return { enqueue } as unknown as OdooQueue;
}

const samplePlan: WritePlan = {
  operation: "write",
  model: "account.move",
  method: "write",
  values: { ref: "INV/001", amount: 100 },
  company_id: 1,
  evidence: ["move 5 balance mismatch"],
  warnings: []
};

describe("checkDateAgainstLocks", () => {
  test("hard-lock violation → blocked", () => {
    const result = checkDateAgainstLocks("2026-01-01", { hard_lock_date: "2026-03-01" });
    expect(result.blocked).toBe(true);
    expect(result.needs_lock_exception).toBe(false);
    expect(result.violated_locks).toContainEqual({ field: "hard_lock_date", lock_date: "2026-03-01" });
  });

  test("fiscalyear/tax locks → needs_lock_exception, not blocked", () => {
    const result = checkDateAgainstLocks("2026-01-01", {
      fiscalyear_lock_date: "2026-03-01",
      tax_lock_date: "2026-02-01"
    });
    expect(result.blocked).toBe(false);
    expect(result.needs_lock_exception).toBe(true);
    expect(result.violated_locks).toHaveLength(2);
  });

  test("hard + soft together → blocked true regardless of soft violations", () => {
    const result = checkDateAgainstLocks("2026-01-01", {
      hard_lock_date: "2026-03-01",
      fiscalyear_lock_date: "2026-03-01"
    });
    expect(result.blocked).toBe(true);
    expect(result.needs_lock_exception).toBe(true);
    expect(result.violated_locks).toHaveLength(2);
  });

  test("sale/purchase locks are soft (exceptable, not blocked)", () => {
    const result = checkDateAgainstLocks("2026-01-01", {
      sale_lock_date: "2026-02-01",
      purchase_lock_date: "2026-02-01"
    });
    expect(result.blocked).toBe(false);
    expect(result.needs_lock_exception).toBe(true);
    expect(result.violated_locks).toHaveLength(2);
  });

  test("date after all locks → clean", () => {
    const result = checkDateAgainstLocks("2027-01-01", {
      hard_lock_date: "2026-03-01",
      fiscalyear_lock_date: "2026-03-01",
      tax_lock_date: "2026-03-01"
    });
    expect(result).toEqual({ blocked: false, needs_lock_exception: false, violated_locks: [] });
  });

  test("null lock dates never violate", () => {
    const result = checkDateAgainstLocks("2020-01-01", {
      hard_lock_date: null,
      fiscalyear_lock_date: null,
      tax_lock_date: null
    });
    expect(result).toEqual({ blocked: false, needs_lock_exception: false, violated_locks: [] });
  });

  test("date equal to lock date is a violation (<=)", () => {
    const result = checkDateAgainstLocks("2026-03-01", { hard_lock_date: "2026-03-01" });
    expect(result.blocked).toBe(true);
  });

  test("normalizes datetime strings to the day before comparing", () => {
    const result = checkDateAgainstLocks("2026-03-01 23:59:59", { hard_lock_date: "2026-03-01" });
    expect(result.blocked).toBe(true);
  });
});

describe("getLockDates", () => {
  test("returns only the lock fields that exist on res.company", async () => {
    const cache = new TtlCache({ clock: () => 0 });
    const queue = fakeQueue(async (...args: unknown[]) => {
      const method = args[2] as string;
      if (method === "fields_get") {
        return {
          id: { type: "integer", string: "ID" },
          fiscalyear_lock_date: { type: "date", string: "Fiscal Year Lock" },
          tax_lock_date: { type: "date", string: "Tax Lock" }
          // sale/purchase/hard lock fields intentionally absent (older version)
        };
      }
      if (method === "read") {
        return [{ id: 1, fiscalyear_lock_date: "2026-01-01", tax_lock_date: false }];
      }
      return null;
    });

    const { lockDates, warnings } = await getLockDates(queue, cache, conn, 1);

    expect(lockDates).toEqual({ fiscalyear_lock_date: "2026-01-01", tax_lock_date: null });
    expect(warnings).toEqual([]);

    // Reads only the discovered fields, via the object-args enqueue signature.
    const readCall = (queue.enqueue as ReturnType<typeof mock>).mock.calls.find((c: unknown[]) => c[2] === "read");
    expect(readCall?.[3]).toEqual({ ids: [1], fields: ["fiscalyear_lock_date", "tax_lock_date"] });
  });

  test("emits a warning (no throw) when no known lock fields exist", async () => {
    const cache = new TtlCache({ clock: () => 0 });
    const queue = fakeQueue(async (...args: unknown[]) => {
      if ((args[2] as string) === "fields_get") return { id: { type: "integer", string: "ID" } };
      return [];
    });

    const { lockDates, warnings } = await getLockDates(queue, cache, conn, 1);

    expect(lockDates).toEqual({});
    expect(warnings).toHaveLength(1);
    // No `read` is issued when there are no fields to fetch.
    expect((queue.enqueue as ReturnType<typeof mock>).mock.calls.some((c: unknown[]) => c[2] === "read")).toBe(false);
  });
});

describe("checkLockExceptionSupport", () => {
  test("reports supported when account.lock_exception exists", async () => {
    const cache = new TtlCache({ clock: () => 0 });
    const queue = fakeQueue(async () => ({
      id: { type: "integer", string: "ID" },
      lock_date: { type: "date", string: "Lock Date" }
    }));

    const result = await checkLockExceptionSupport(queue, cache, conn);

    expect(result.supported).toBe(true);
    expect(result.model).toBe("account.lock_exception");
    expect(result.warning).toBeUndefined();
  });

  test("returns a warning string (no throw) when the model is absent", async () => {
    const cache = new TtlCache({ clock: () => 0 });
    const queue = fakeQueue(async () => {
      throw new OdooError({
        message: "model not found",
        code: "model_or_method_not_found",
        httpStatus: 404,
        model: "account.lock_exception",
        method: "fields_get",
        details: "account.lock_exception does not exist"
      });
    });

    const result = await checkLockExceptionSupport(queue, cache, conn);

    expect(result.supported).toBe(false);
    expect(result.model).toBeNull();
    expect(result.warning).toBeTruthy();
  });
});

describe("canonicalJson", () => {
  test("is stable regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  test("sorts nested object keys but preserves array order", () => {
    expect(canonicalJson({ arr: [3, 1, 2], o: { b: 1, a: 2 } })).toBe('{"arr":[3,1,2],"o":{"a":2,"b":1}}');
  });

  test("sorts object keys inside arrays", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});

describe("confirmation tokens", () => {
  const secret = "hmac-secret";

  test("issue then verify with the same plan/secret/now → valid", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    expect(await verifyConfirmationToken(token, samplePlan, secret, now)).toBe("valid");
  });

  test("is insensitive to key insertion order (canonicalized before signing)", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    const reordered: WritePlan = {
      warnings: [],
      evidence: ["move 5 balance mismatch"],
      company_id: 1,
      values: { amount: 100, ref: "INV/001" },
      method: "write",
      model: "account.move",
      operation: "write"
    };
    expect(await verifyConfirmationToken(token, reordered, secret, now)).toBe("valid");
  });

  test("mutated plan → mismatch", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    const tampered: WritePlan = { ...samplePlan, values: { ref: "INV/999", amount: 100 } };
    expect(await verifyConfirmationToken(token, tampered, secret, now)).toBe("mismatch");
  });

  test("wrong secret → mismatch", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    expect(await verifyConfirmationToken(token, samplePlan, "other-secret", now)).toBe("mismatch");
  });

  test("malformed token → mismatch", async () => {
    expect(await verifyConfirmationToken("not-a-token", samplePlan, secret, 1_000_000)).toBe("mismatch");
  });

  test("verifying past the ~15-min window → expired", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    expect(await verifyConfirmationToken(token, samplePlan, secret, now + TOKEN_TTL_MS + 1)).toBe("expired");
  });

  test("verifying exactly at the expiry boundary is still valid", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    expect(await verifyConfirmationToken(token, samplePlan, secret, now + TOKEN_TTL_MS)).toBe("valid");
  });

  test("a tampered but expired token reads as mismatch (HMAC checked before expiry)", async () => {
    const now = 1_000_000;
    const token = await issueConfirmationToken(samplePlan, secret, now);
    const tampered: WritePlan = { ...samplePlan, values: { ref: "X", amount: 100 } };
    expect(await verifyConfirmationToken(token, tampered, secret, now + TOKEN_TTL_MS + 1)).toBe("mismatch");
  });
});

describe("buildAuditEntry", () => {
  test("assembles a structured record from the plan and write result", () => {
    const entry = buildAuditEntry(samplePlan, {
      ids: [5],
      old_values: { ref: "INV/000" },
      new_values: { ref: "INV/001" },
      reason: "correct posting reference",
      timestamp: "2026-07-04T00:00:00.000Z"
    });

    expect(entry).toEqual({
      operation: "write",
      model: "account.move",
      ids: [5],
      old_values: { ref: "INV/000" },
      new_values: { ref: "INV/001" },
      reason: "correct posting reference",
      evidence: ["move 5 balance mismatch"],
      timestamp: "2026-07-04T00:00:00.000Z"
    });
  });
});
