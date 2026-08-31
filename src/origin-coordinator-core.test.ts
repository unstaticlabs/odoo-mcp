import { describe, expect, test } from "bun:test";
import { OriginCoordinatorCore } from "./origin-coordinator-core";

const request = (origin = "https://odoo.example.com") =>
  new Request(`${origin}/json/2/res.partner/search_read`, { method: "POST", body: "{}" });

describe("OriginCoordinatorCore", () => {
  test("never overlaps requests for one origin", async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const core = new OriginCoordinatorCore({
      expectedOrigin: "https://odoo.example.com",
      fetchFn: async () => {
        const index = order.length;
        order.push(index);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return Response.json({ index });
      }
    });

    const responses = await Promise.all(Array.from({ length: 8 }, () => core.handle(request())));
    expect(peak).toBe(1);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("keeps the origin occupied until the physical response body is complete", async () => {
    let closeFirst: (() => void) | undefined;
    let calls = 0;
    const core = new OriginCoordinatorCore({
      fetchFn: async () => {
        calls++;
        if (calls > 1) return new Response("second");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              closeFirst = () => controller.close();
            }
          })
        );
      }
    });

    const first = core.handle(request());
    await Promise.resolve();
    const second = core.handle(request());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);

    closeFirst?.();
    expect(await (await first).text()).toBe("first");
    expect(await (await second).text()).toBe("second");
    expect(calls).toBe(2);
  });

  test("bounds the response while it still owns the physical request", async () => {
    const core = new OriginCoordinatorCore({
      maxResponseBytes: 4,
      fetchFn: async () => new Response("oversized")
    });

    const response = await core.handle(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "coordinator_response_too_large", recoverable: false }
    });
  });

  test("bounds the waiting queue", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = new OriginCoordinatorCore({
      maxWaiting: 1,
      fetchFn: async () => {
        await gate;
        return new Response("ok");
      }
    });

    const first = core.handle(request());
    await Promise.resolve();
    const second = core.handle(request());
    const rejected = await core.handle(request());
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ error: { code: "origin_busy", reason: "queue_full" } });
    release?.();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  test("times out waiting requests without executing them", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const core = new OriginCoordinatorCore({
      maxWaitMs: 10,
      fetchFn: async () => {
        calls++;
        await gate;
        return new Response("ok");
      }
    });

    const first = core.handle(request());
    await Promise.resolve();
    const timedOut = await core.handle(request());
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toMatchObject({ error: { code: "origin_busy", reason: "wait_timeout" } });
    release?.();
    await first;
    expect(calls).toBe(1);
  });

  test("rejects non-JSON-2 and wrong-origin targets", async () => {
    const core = new OriginCoordinatorCore({ expectedOrigin: "https://odoo.example.com" });
    expect((await core.handle(new Request("https://odoo.example.com/web", { method: "POST" }))).status).toBe(405);
    expect((await core.handle(new Request("https://odoo.example.com/json/2/res.partner/../../web", { method: "POST" }))).status).toBe(405);
    expect((await core.handle(new Request("https://odoo.example.com/json/2/res.partner/_private", { method: "POST" }))).status).toBe(405);
    expect((await core.handle(request("https://other.example.com"))).status).toBe(400);
  });

  test("serializes authenticated API-document reads through the same origin", async () => {
    const core = new OriginCoordinatorCore({ fetchFn: async () => Response.json({ models: [] }) });
    const response = await core.handle(new Request("https://odoo.example.com/doc-bearer/index.json"));
    expect(response.status).toBe(200);
  });
});
