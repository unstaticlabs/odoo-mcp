import { afterEach, describe, expect, it, vi } from "vitest";
import { OdooClient, OdooError } from "../../src/odoo/client.js";
import {
  AgentAccessSnapshotCache,
  AgentAccessUnavailableError,
  AgentAccessWarmingError,
  type AgentAccessSnapshot,
  type AgentAccessSnapshotStore,
  agentCredentialFingerprint
} from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";
import { requestContext } from "./fixtures.js";

const identity = requestContext().agentIdentity!;

function oauthContext(): RequestContext {
  const context = requestContext();
  return {
    ...context,
    principal: {
      ...context.principal,
      authMode: "oauth",
      enrollmentId: "enrollment-test"
    }
  };
}

function completeSnapshot(refreshedAt = Date.now()): AgentAccessSnapshot {
  return {
    identity,
    refreshedAt,
    surface: {
      etag: '"agent-access-v1"',
      modules: new Set(["base", "api_doc", "contacts"]),
      publicMethods: new Map([["res.partner", new Set(["read", "search_read", "write"])]]),
      modelAccess: new Map([["res.partner", {
        read: true,
        create: true,
        write: true,
        unlink: true
      }]])
    }
  };
}

class MemorySnapshotStore implements AgentAccessSnapshotStore {
  snapshot: AgentAccessSnapshot | null;
  readonly load = vi.fn((_: RequestContext["principal"]) => this.snapshot);
  readonly save = vi.fn((_: RequestContext["principal"], snapshot: AgentAccessSnapshot) => {
    this.snapshot = snapshot;
  });
  readonly remove = vi.fn(() => {
    this.snapshot = null;
  });

  constructor(snapshot: AgentAccessSnapshot | null) {
    this.snapshot = snapshot;
  }
}

function surfaceDocument(write = true) {
  return {
    modules: ["base", "api_doc", "contacts"],
    models: [{
      model: "res.partner",
      access: { read: true, create: write, write, unlink: write },
      methods: ["read", "search_read", ...(write ? ["create", "write", "unlink"] : [])]
    }]
  };
}

function cacheHarness(options: ConstructorParameters<typeof AgentAccessSnapshotCache>[1] = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/json/2/usl.agent/current_identity")) return Response.json(identity);
    if (url.endsWith("/doc-bearer/index.json")) {
      return Response.json(surfaceDocument(), { headers: { ETag: '"agent-access-v1"' } });
    }
    return Response.json({ message: "unexpected test request" }, { status: 404 });
  });
  const client = new OdooClient(8, 1024 * 1024, fetcher);
  return { cache: new AgentAccessSnapshotCache(client, options), calls, fetcher };
}

function counts(calls: readonly string[]) {
  return {
    identity: calls.filter((url) => url.includes("/json/2/usl.agent/current_identity")).length,
    discovery: calls.filter((url) => url.endsWith("/doc-bearer/index.json")).length
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent access snapshot cache", () => {
  it("hydrates a complete OAuth snapshot immediately and revalidates it in the background", async () => {
    const stored = completeSnapshot();
    const store = new MemorySnapshotStore(stored);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      await blocked;
      return Response.json({ error: { message: "temporary outage" } }, { status: 503 });
    });
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher), { store });
    const snapshot = await cache.initialize(oauthContext(), undefined, { requireSurface: true });
    expect(snapshot).toBe(stored);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(cache.get(oauthContext().principal)).toBe(stored);
    release();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(cache.get(oauthContext().principal)).toBe(stored);
    await cache.close();
  });

  it("reports a valid cached snapshot when prepare revalidation fails transiently", async () => {
    const stored = completeSnapshot();
    const store = new MemorySnapshotStore(stored);
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).includes("current_identity")
      ? Response.json(identity)
      : Response.json({ error: { message: "temporary outage" } }, { status: 503 }));
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher), { store });

    await expect(cache.warm(oauthContext())).resolves.toEqual({
      snapshot: stored,
      refreshed: false
    });
    expect(cache.get(oauthContext().principal)).toBe(stored);
    await cache.close();
  });

  it("expires stale OAuth snapshots and returns retryable warming instead of a partial surface", async () => {
    const now = Date.parse("2026-09-03T12:00:00Z");
    const store = new MemorySnapshotStore(completeSnapshot(now - 24 * 60 * 60_000 - 1));
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).includes("current_identity")
      ? Response.json(identity)
      : Response.json({ error: { message: "upstream unavailable" } }, { status: 503 }));
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher), {
      store,
      now: () => now,
      maximumStaleMs: 24 * 60 * 60_000
    });

    await expect(cache.initialize(oauthContext(), undefined, {
      requireSurface: true,
      timeoutMs: 100
    })).rejects.toBeInstanceOf(AgentAccessWarmingError);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(() => cache.get(oauthContext().principal)).toThrow(AgentAccessWarmingError);
    await cache.close();
  });

  it("maps a cold OAuth identity timeout to retryable warming within one attempt", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher), {
      store: new MemorySnapshotStore(null)
    });

    await expect(cache.initialize(oauthContext(), undefined, {
      requireSurface: true,
      timeoutMs: 20
    })).rejects.toBeInstanceOf(AgentAccessWarmingError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it("preserves a fresh snapshot after transient refresh failure but discards it after an authority change", async () => {
    const store = new MemorySnapshotStore(completeSnapshot());
    let changed = false;
    const changedIdentity = {
      ...identity,
      effective_group_ids: [...identity.effective_group_ids, 99]
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("current_identity")) {
        return Response.json(changed ? changedIdentity : identity);
      }
      return Response.json({ error: { message: "temporary outage" } }, { status: 503 });
    });
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher), { store });
    const context = oauthContext();
    const initial = await cache.initialize(context, undefined, { requireSurface: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(cache.get(context.principal)).toBe(initial);

    changed = true;
    cache.noteAccessFailure(context, new OdooError(
      "Access changed", "permission_denied", 403, undefined, undefined, false, "not_applied"
    ));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(() => cache.get(context.principal)).toThrow(AgentAccessWarmingError);
    await cache.close();
  });

  it("invalidates a persisted snapshot when API-document authorization is denied", async () => {
    const store = new MemorySnapshotStore(completeSnapshot());
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).includes("current_identity")
      ? Response.json(identity)
      : Response.json({ error: { message: "documentation access revoked" } }, { status: 403 }));
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher), { store });
    const context = oauthContext();
    await cache.initialize(context, undefined, { requireSurface: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(() => cache.get(context.principal)).toThrow(AgentAccessUnavailableError);
    await cache.close();
  });

  it("loads identity and discovery exactly once, then serves warm consumers without Odoo traffic", async () => {
    const { cache, calls } = cacheHarness({ random: () => 0.5 });
    const context = requestContext();
    const initial = await cache.initialize(context);
    expect(counts(calls)).toEqual({ identity: 1, discovery: 1 });
    expect(initial.surface?.modelAccess.get("res.partner")).toEqual({
      read: true,
      create: true,
      write: true,
      unlink: true
    });

    expect(await cache.initialize(context)).toBe(initial);
    expect(cache.get(context.principal)).toBe(initial);
    cache.touch(context);
    expect(counts(calls)).toEqual({ identity: 1, discovery: 1 });
    await cache.close();
  });

  it("coalesces concurrent first use into one identity request and one API document request", async () => {
    const { cache, calls } = cacheHarness();
    const context = requestContext();
    const snapshots = await Promise.all(Array.from({ length: 20 }, () => cache.initialize(context)));
    expect(new Set(snapshots).size).toBe(1);
    expect(counts(calls)).toEqual({ identity: 1, discovery: 1 });
    await cache.close();
  });

  it("deduplicates denial refreshes and keeps a record-specific 403 snapshot available", async () => {
    const { cache, calls } = cacheHarness();
    const context = requestContext();
    const initial = await cache.initialize(context);
    const denial = new OdooError(
      "Record rule denied this operation",
      "permission_denied",
      403,
      "project.task",
      "write",
      false,
      "not_applied",
      undefined,
      "mutation",
      "request_rejected",
      undefined,
      undefined,
      "agent_read_only_action_denied"
    );

    cache.noteAccessFailure(context, denial);
    cache.noteAccessFailure(context, denial);
    await vi.waitFor(() => expect(counts(calls)).toEqual({ identity: 2, discovery: 2 }));
    expect(cache.get(context.principal).identity).toEqual(initial.identity);
    expect(counts(calls)).toEqual({ identity: 2, discovery: 2 });
    await cache.close();
  });

  it("caches an initial failure only as unavailable status and fails later requests without traffic", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(
      { error: { message: "revoked" } },
      { status: 401 }
    ));
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher));
    const context = requestContext();
    await expect(cache.initialize(context)).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(cache.initialize(context)).rejects.toBeInstanceOf(AgentAccessUnavailableError);
    expect(() => cache.get(context.principal)).toThrow(AgentAccessUnavailableError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it("recovers an unavailable credential through its scheduled refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    let available = false;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (!available) return Response.json({ error: { message: "suspended" } }, { status: 401 });
      return String(input).includes("/current_identity")
        ? Response.json(identity)
        : Response.json(surfaceDocument());
    });
    const cache = new AgentAccessSnapshotCache(
      new OdooClient(8, 1024 * 1024, fetcher),
      { random: () => 0.5 }
    );
    const context = requestContext();
    await expect(cache.initialize(context)).rejects.toMatchObject({ code: "unauthorized" });
    expect(() => cache.get(context.principal)).toThrow(AgentAccessUnavailableError);

    available = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cache.get(context.principal).identity).toEqual(identity);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await cache.close();
  });

  it("uses bounded opaque credential fingerprints and evicts the least recently used entry", async () => {
    const { cache } = cacheHarness({ maximumEntries: 2 });
    const first = requestContext();
    const second = { ...requestContext(), principal: { ...requestContext().principal, apiKey: "second-key" } };
    const third = { ...requestContext(), principal: { ...requestContext().principal, apiKey: "third-key" } };
    const fingerprint = agentCredentialFingerprint(first.principal);
    expect(fingerprint).not.toContain(first.principal.apiKey);
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await cache.initialize(first);
    await cache.initialize(second);
    cache.get(first.principal);
    await cache.initialize(third);
    expect(cache.size).toBe(2);
    expect(() => cache.get(second.principal)).toThrow(AgentAccessUnavailableError);
    expect(cache.get(first.principal).identity.agent.id).toBe(identity.agent.id);
    await cache.close();
  });

  it("follows the exponential schedule, caps at one day, and resets after activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const { cache, calls } = cacheHarness({ random: () => 0.5 });
    const context = requestContext();
    await cache.initialize(context);
    const intervals = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 1_440, 1_440];
    for (let index = 0; index < intervals.length; index++) {
      await vi.advanceTimersByTimeAsync(intervals[index]! * 60_000);
      expect(counts(calls)).toEqual({ identity: index + 2, discovery: index + 2 });
    }

    cache.touch(context);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(counts(calls)).toEqual({ identity: intervals.length + 1, discovery: intervals.length + 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(counts(calls)).toEqual({ identity: intervals.length + 2, discovery: intervals.length + 2 });
    await cache.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps refresh jitter within ten percent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const early = cacheHarness({ random: () => 0 });
    await early.cache.initialize(requestContext());
    await vi.advanceTimersByTimeAsync(53_999);
    expect(counts(early.calls)).toEqual({ identity: 1, discovery: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(counts(early.calls)).toEqual({ identity: 2, discovery: 2 });
    await early.cache.close();

    const late = cacheHarness({ random: () => 1 });
    await late.cache.initialize(requestContext());
    await vi.advanceTimersByTimeAsync(65_999);
    expect(counts(late.calls)).toEqual({ identity: 1, discovery: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(counts(late.calls)).toEqual({ identity: 2, discovery: 2 });
    await late.cache.close();
  });

  it("aborts and awaits an in-flight load during shutdown", async () => {
    let aborted = false;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    const cache = new AgentAccessSnapshotCache(new OdooClient(8, 1024 * 1024, fetcher));
    const pending = cache.initialize(requestContext());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await cache.close();
    await expect(pending).rejects.toMatchObject({ name: "OdooError", code: "cancelled" });
    expect(aborted).toBe(true);
    expect(cache.size).toBe(0);
  });
});
