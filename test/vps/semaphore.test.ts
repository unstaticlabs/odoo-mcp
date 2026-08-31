import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/runtime/semaphore.js";

describe("target semaphore", () => {
  it("never exceeds the configured concurrency and drains queued work", async () => {
    const semaphore = new Semaphore(3);
    let active = 0;
    let maximum = 0;
    const runs = Array.from({ length: 20 }, async () => semaphore.run(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    }));
    await Promise.all(runs);
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(semaphore.pending).toBe(0);
  });

  it("removes an aborted waiter without consuming capacity", async () => {
    const semaphore = new Semaphore(1);
    let release!: () => void;
    const first = semaphore.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const abort = new AbortController();
    const second = semaphore.run(async () => undefined, abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    release();
    await first;
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });
});
