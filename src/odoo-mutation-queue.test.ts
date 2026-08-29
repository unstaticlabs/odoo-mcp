import { afterEach, describe, expect, mock, test } from "bun:test";
import { MutationExecutionError } from "./mutation";
import { OdooError, type OdooCallOptions, callOdoo } from "./odoo";
import { OdooQueue } from "./odoo-queue";

const conn = { url: "https://odoo.example.com", db: "db", apiKey: "secret" };
const originalFetch = globalThis.fetch;

describe("OdooQueue mutation protocol", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses one key across retries and reports a replay", async () => {
    const keys: string[] = [];
    let mutationAttempts = 0;
    globalThis.fetch = mock(async (request: Request | URL | string, init?: RequestInit) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      if (url.includes("/usl.json2.idempotency/get_capabilities")) {
        return Response.json({
          result: { protocol_version: "1", retention_seconds: 604800, result_size_limit: 2097152 }
        });
      }
      mutationAttempts++;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "missing");
      if (mutationAttempts === 1) {
        throw new TypeError("lost response");
      }
      return new Response(JSON.stringify({ result: [41] }), {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Status": "replayed",
          "Idempotency-Expires-At": "2030-01-01T00:00:00Z"
        }
      });
    });
    const queue = new OdooQueue(callOdoo);

    const mutation = await queue.runMutation(conn, { idempotencyKey: "same-operation" }, (scope) =>
        scope.call("res.partner", "create", { vals_list: [{ name: "A" }] })
      );
    expect(keys).toEqual(["same-operation", "same-operation"]);
    expect(mutation.execution).toMatchObject({
      idempotency_key: "same-operation",
      idempotency_mode: "odoo_atomic",
      replayed: true,
      outcome: "succeeded",
      expires_at: "2030-01-01T00:00:00Z"
    });
  });

  test("unavailable capability makes exactly one keyed attempt and reports ambiguity", async () => {
    let mutations = 0;
    let attemptedKey: string | undefined;
    const caller = (async (_conn, model, method, _args, options) => {
      if (model === "usl.json2.idempotency") throw new Error("missing");
      mutations++;
      attemptedKey = (options as OdooCallOptions).idempotencyKey;
      throw new OdooError({
        message: "timeout",
        code: "timeout",
        httpStatus: null,
        model,
        method,
        details: "timeout",
        mutationOutcome: "unknown"
      });
    }) as typeof callOdoo;
    const queue = new OdooQueue(caller);

    try {
      await queue.runMutation(conn, {}, (scope) => scope.call("res.partner", "create", { vals_list: [{ name: "A" }] }));
      throw new Error("expected mutation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MutationExecutionError);
      const failure = error as MutationExecutionError;
      expect(failure.execution).toMatchObject({ idempotency_mode: "unavailable", outcome: "unknown", replayed: false });
      expect(failure.execution.idempotency_key).toBeString();
    }
    expect(mutations).toBe(1);
    expect(attemptedKey).toBeString();
  });

  test("derives stable child keys for composite steps", async () => {
    const keys: string[] = [];
    const caller = (async (_conn, model, _method, _args, options) => {
      if (model === "usl.json2.idempotency") {
        return { protocol_version: "1", retention_seconds: 604800, result_size_limit: 2097152 };
      }
      const opts = options as OdooCallOptions;
      keys.push(opts.idempotencyKey ?? "missing");
      opts.onResponseMetadata?.({ idempotencyStatus: "created" });
      return true;
    }) as typeof callOdoo;
    const queue = new OdooQueue(caller);

    const run = () =>
      queue.runMutation(conn, { idempotencyKey: "batch-root" }, async (scope) => {
        await scope.call("res.partner", "write", { ids: [1], vals: { name: "A" } }, "batch:0");
        await scope.call("res.partner", "write", { ids: [2], vals: { name: "B" } }, "batch:1");
        return true;
      });
    await run();
    const first = [...keys];
    keys.length = 0;
    await run();
    expect(keys).toEqual(first);
    expect(first[0]).not.toBe(first[1]);
  });

  test("header credentials receive one fixed, briefly cached handshake", async () => {
    const calls: Array<{ model: string; method: string; args: Record<string, unknown> }> = [];
    const caller = (async (_conn, model, method, args) => {
      calls.push({ model, method, args });
      return method === "fields_get" ? { login: { type: "char" } } : [];
    }) as typeof callOdoo;
    const queue = new OdooQueue(caller, { handshakeRequired: true });
    const headerConn = { ...conn, authMode: "header" as const };

    await queue.enqueue(headerConn, "res.partner", "search_read", { domain: [] });
    await queue.enqueue(headerConn, "project.task", "search_read", { domain: [] });

    expect(calls[0]).toEqual({
      model: "res.users",
      method: "fields_get",
      args: { attributes: ["type"] }
    });
    expect(calls.filter((call) => call.model === "res.users" && call.method === "fields_get")).toHaveLength(1);
  });

  test("handshake failures expose only the fixed redacted diagnostic", async () => {
    const secret = "odoo_super_secret_key";
    const caller = (async (_conn, model, method) => {
      throw new OdooError({
        message: `Bearer ${secret}`,
        code: "unauthorized",
        httpStatus: 401,
        model,
        method,
        details: `internal host replied with Bearer ${secret}`,
        mutationOutcome: "not_applied"
      });
    }) as typeof callOdoo;
    const queue = new OdooQueue(caller, { handshakeRequired: true });

    try {
      await queue.enqueue({ ...conn, authMode: "header" }, "res.partner", "search_read", { domain: [] });
      throw new Error("expected handshake failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OdooError);
      const failure = error as OdooError;
      expect(failure.details).toBe("Odoo credential handshake failed; verify the configured origin, database, and API key.");
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
  });
});
