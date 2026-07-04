import { mock, describe, test, expect } from "bun:test";
import type { OdooQueue } from "./odoo-queue";
import { TtlCache, getFieldsCached, resolveXmlIdCached, cachedSearchRead, TTL_METADATA_MS } from "./cache";

const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };

function fakeQueue(impl: (...args: unknown[]) => unknown) {
  const enqueue = mock(impl);
  return { enqueue } as unknown as OdooQueue;
}

describe("TtlCache", () => {
  test("get/set round-trip and expire exactly at expiresAt via injected clock", () => {
    let now = 0;
    const cache = new TtlCache({ clock: () => now });

    cache.set("k", "v", 100);
    now = 99;
    expect(cache.get("k")).toBe("v");

    now = 100;
    expect(cache.get("k")).toBeUndefined();
  });

  test("hit/miss counters are accurate", () => {
    let now = 0;
    const cache = new TtlCache({ clock: () => now });

    expect(cache.get("missing")).toBeUndefined(); // miss: never set
    cache.set("k", "v", 1000);
    expect(cache.get("k")).toBe("v"); // hit
    expect(cache.get("k")).toBe("v"); // hit
    now = 1000;
    expect(cache.get("k")).toBeUndefined(); // miss: expired

    const metrics = cache.getMetrics();
    expect(metrics).toEqual({ cache_hits: 2, cache_misses: 2 });
  });

  test("evicts the oldest entry (FIFO) once maxEntries is exceeded", () => {
    let now = 0;
    const cache = new TtlCache({ clock: () => now, maxEntries: 3 });

    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.set("c", 3, 1000);
    cache.set("d", 4, 1000); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  test("overwriting an existing key does not trigger eviction", () => {
    let now = 0;
    const cache = new TtlCache({ clock: () => now, maxEntries: 2 });

    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.set("a", 99, 1000); // update, not a new entry

    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBe(2);
  });

  test("getOrCompute calls fn only once per cache miss and reuses the value within TTL", async () => {
    let now = 0;
    const cache = new TtlCache({ clock: () => now });
    const fn = mock(async () => "computed");

    const first = await cache.getOrCompute("k", 100, fn);
    const second = await cache.getOrCompute("k", 100, fn);

    expect(first).toBe("computed");
    expect(second).toBe("computed");
    expect(fn).toHaveBeenCalledTimes(1);

    now = 100;
    const third = await cache.getOrCompute("k", 100, fn);
    expect(third).toBe("computed");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("getOrCompute does not cache a rejected fn call", async () => {
    let now = 0;
    const cache = new TtlCache({ clock: () => now });
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("boom");
    };

    await expect(cache.getOrCompute("k", 1000, fn)).rejects.toThrow("boom");
    await expect(cache.getOrCompute("k", 1000, fn)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});

describe("getFieldsCached", () => {
  test("caches fields_get per model/db and only calls the queue once within TTL", async () => {
    const cache = new TtlCache({ clock: () => 0 });
    const queue = fakeQueue(async () => ({
      name: { type: "char", string: "Name" },
      partner_id: { type: "many2one", string: "Partner", relation: "res.partner" }
    }));

    const first = await getFieldsCached(cache, queue, conn, "project.task");
    const second = await getFieldsCached(cache, queue, conn, "project.task");

    expect(first).toEqual(second);
    expect(first.partner_id.relation).toBe("res.partner");
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  test("uses TTL_METADATA_MS (6h)", () => {
    expect(TTL_METADATA_MS).toBe(6 * 60 * 60 * 1000);
  });

  test("different models get independent cache entries", async () => {
    const cache = new TtlCache({ clock: () => 0 });
    const queue = fakeQueue(async () => ({ name: { type: "char", string: "Name" } }));

    await getFieldsCached(cache, queue, conn, "project.task");
    await getFieldsCached(cache, queue, conn, "res.partner");

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });
});

describe("resolveXmlIdCached", () => {
  test("resolves module.name via a single ir.model.data search_read and caches it", async () => {
    const queue = fakeQueue(async () => [{ model: "project.task", res_id: 42 }]);
    const cache = new TtlCache({ clock: () => 0 });

    const first = await resolveXmlIdCached(cache, queue, conn, "project.task_1");
    const second = await resolveXmlIdCached(cache, queue, conn, "project.task_1");

    expect(first).toEqual({ model: "project.task", res_id: 42 });
    expect(second).toEqual({ model: "project.task", res_id: 42 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);

    const [, model, method, args] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0];
    expect(model).toBe("ir.model.data");
    expect(method).toBe("search_read");
    expect(args).toEqual({
      domain: [
        ["module", "=", "project"],
        ["name", "=", "task_1"]
      ],
      fields: ["model", "res_id"],
      limit: 1
    });
  });

  test("throws and does not cache when no record is found", async () => {
    const queue = fakeQueue(async () => []);
    const cache = new TtlCache({ clock: () => 0 });

    await expect(resolveXmlIdCached(cache, queue, conn, "module.missing")).rejects.toThrow('XML ID "module.missing" not found');
    await expect(resolveXmlIdCached(cache, queue, conn, "module.missing")).rejects.toThrow();
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  test("throws on a malformed XML ID without calling the queue", async () => {
    const queue = fakeQueue(async () => []);
    const cache = new TtlCache({ clock: () => 0 });

    await expect(resolveXmlIdCached(cache, queue, conn, "no-dot-here")).rejects.toThrow('Invalid XML ID "no-dot-here"');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe("cachedSearchRead", () => {
  test("caches under the caller-supplied key and TTL, calling the queue once", async () => {
    const queue = fakeQueue(async () => [{ id: 1, name: "Acme" }]);
    const cache = new TtlCache({ clock: () => 0 });

    const first = await cachedSearchRead(cache, queue, conn, "partners:acme", 1000, "res.partner", [["id", "=", 1]], ["id", "name"]);
    const second = await cachedSearchRead(cache, queue, conn, "partners:acme", 1000, "res.partner", [["id", "=", 1]], ["id", "name"]);

    expect(first).toEqual([{ id: 1, name: "Acme" }]);
    expect(second).toEqual(first);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  test("re-queries once the TTL window elapses", async () => {
    let now = 0;
    const queue = fakeQueue(async () => [{ id: 1 }]);
    const cache = new TtlCache({ clock: () => now });

    await cachedSearchRead(cache, queue, conn, "k", 500, "res.partner", [], ["id"]);
    now = 500;
    await cachedSearchRead(cache, queue, conn, "k", 500, "res.partner", [], ["id"]);

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  test("passes limit through only when provided", async () => {
    const queue = fakeQueue(async () => []);
    const cache = new TtlCache({ clock: () => 0 });

    await cachedSearchRead(cache, queue, conn, "k1", 1000, "res.partner", [], ["id"], 5);
    const [, , , argsWithLimit] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[0];
    expect(argsWithLimit).toEqual({ domain: [], fields: ["id"], limit: 5 });

    await cachedSearchRead(cache, queue, conn, "k2", 1000, "res.partner", [], ["id"]);
    const [, , , argsWithoutLimit] = (queue.enqueue as ReturnType<typeof mock>).mock.calls[1];
    expect(argsWithoutLimit).toEqual({ domain: [], fields: ["id"] });
  });
});
