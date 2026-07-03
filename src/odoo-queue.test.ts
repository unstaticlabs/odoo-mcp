import { mock, describe, test, expect, afterEach } from "bun:test";
import { callOdoo } from "./odoo";
import { OdooQueue } from "./odoo-queue";

const originalFetch = globalThis.fetch;
const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };

function jsonResponse(result: unknown) {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("OdooQueue", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("serializes concurrent calls so they never overlap", async () => {
    const events: string[] = [];
    const fetchMock = mock(async () => {
      events.push("start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("end");
      return jsonResponse("ok");
    });
    globalThis.fetch = fetchMock;

    const queue = new OdooQueue(callOdoo, { minDelayMs: 1 });
    await Promise.all([
      queue.enqueue(conn, "test.model", "method_a", {}),
      queue.enqueue(conn, "test.model", "method_b", {}),
      queue.enqueue(conn, "test.model", "method_c", {})
    ]);

    expect(events).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

  test("enforces the minimum delay between call starts", async () => {
    const startTimes: number[] = [];
    const fetchMock = mock(async () => {
      startTimes.push(Date.now());
      return jsonResponse("ok");
    });
    globalThis.fetch = fetchMock;

    const queue = new OdooQueue(callOdoo, { minDelayMs: 20 });
    await Promise.all([
      queue.enqueue(conn, "test.model", "method_a", {}),
      queue.enqueue(conn, "test.model", "method_b", {})
    ]);

    expect(startTimes.length).toBe(2);
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(19);
  });

  test("a rejected call only rejects its own promise; the queue keeps draining", async () => {
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      if (callCount === 2) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 });
      }
      return jsonResponse(`ok-${callCount}`);
    });
    globalThis.fetch = fetchMock;

    const queue = new OdooQueue(callOdoo, { minDelayMs: 1 });
    const p1 = queue.enqueue(conn, "test.model", "method_a", {});
    const p2 = queue.enqueue(conn, "test.model", "method_b", {});
    const p3 = queue.enqueue(conn, "test.model", "method_c", {});

    const results = await Promise.allSettled([p1, p2, p3]);

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok-1" });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: "ok-3" });
    expect(callCount).toBe(3);
  });

  test("getMetrics accumulates odoo_calls, total_duration_ms, and per-call ok/failure records", async () => {
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      if (callCount === 2) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 });
      }
      return jsonResponse("ok");
    });
    globalThis.fetch = fetchMock;

    const queue = new OdooQueue(callOdoo, { minDelayMs: 1 });
    await queue.enqueue(conn, "model.a", "method_1", {});
    await queue.enqueue(conn, "model.b", "method_2", {}).catch(() => undefined);
    await queue.enqueue(conn, "model.c", "method_3", {});

    const metrics = queue.getMetrics();
    expect(metrics.odoo_calls).toBe(3);
    expect(metrics.total_duration_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.calls).toEqual([
      { model: "model.a", method: "method_1", ms: expect.any(Number), ok: true },
      { model: "model.b", method: "method_2", ms: expect.any(Number), ok: false },
      { model: "model.c", method: "method_3", ms: expect.any(Number), ok: true }
    ]);

    // returned object is a fresh copy, not a live reference
    metrics.calls.push({ model: "x", method: "y", ms: 0, ok: true });
    expect(queue.getMetrics().calls.length).toBe(3);
  });

  test("snapshot/delta isolate only the calls made between two points", async () => {
    const fetchMock = mock(async () => jsonResponse("ok"));
    globalThis.fetch = fetchMock;

    const queue = new OdooQueue(callOdoo, { minDelayMs: 1 });
    await queue.enqueue(conn, "model.a", "method_1", {});

    const snap = queue.snapshot();

    await queue.enqueue(conn, "model.b", "method_2", {});
    await queue.enqueue(conn, "model.c", "method_3", {});

    const delta = queue.delta(snap);
    expect(delta.odoo_calls).toBe(2);
    expect(delta.calls.map((c) => c.method)).toEqual(["method_2", "method_3"]);

    const full = queue.getMetrics();
    expect(full.odoo_calls).toBe(3);
  });
});
