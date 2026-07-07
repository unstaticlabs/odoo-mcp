import { mock, describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";

mock.module("agents/mcp", () => {
  return {
    McpAgent: class McpAgentBase {
      static serve(_path: string, _opts: unknown) {
        return {
          fetch: mock((_req: Request, _env: unknown, ctx: any) =>
            Promise.resolve(new Response(JSON.stringify({ props: ctx.props }), { status: 200 }))
          )
        };
      }
    }
  };
});
mock.module("agents", () => {
  return {};
});
// workers-oauth-provider imports the workerd-only "cloudflare:workers" module
// solely for the WorkerEntrypoint base class; a stub suffices under bun.
mock.module("cloudflare:workers", () => {
  return { WorkerEntrypoint: class WorkerEntrypoint {} };
});

const {
  callOdoo,
  OdooError,
  OdooQueue,
  pickSmartFields,
  searchRecords,
  escapeHtml,
  countRecords,
  normalizeRecord,
  normalizeRecords,
  parseButtonsFromArch,
  mergeModelActions,
  CURATED_MODEL_ACTIONS,
  deriveWorkflowStatus,
  McpAgent,
  default: handler
} = await import("./index");

const originalFetch = globalThis.fetch;

/** Tests don't want the production 1000ms min-delay between calls. */
function makeQueue() {
  return new OdooQueue(callOdoo, { minDelayMs: 0 });
}

async function buildWriteToolAgent() {
  const AgentCtor = McpAgent as any;
  const agent = new AgentCtor();
  agent.odooQueue = makeQueue();
  agent.props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  await agent.init();
  return agent;
}

const { validatedToolHandler } = await import("./tools/structured-test-util");

/** Direct handler access, wrapped to replay the SDK's outputSchema validation on success results. */
function getToolHandler(agent: any, name: string) {
  return validatedToolHandler(agent.server, name);
}

/** Records every enqueue call and can force a message_post rejection, so tests never touch fetch. */
function makeStubQueue({ createId = 42, failMessagePost = false }: { createId?: number; failMessagePost?: boolean } = {}) {
  const calls: { conn: unknown; model: string; method: string; args: any }[] = [];
  return {
    calls,
    enqueue(conn: unknown, model: string, method: string, args: any) {
      calls.push({ conn, model, method, args });
      if (method === "create") return Promise.resolve([createId]);
      if (method === "message_post") {
        return failMessagePost ? Promise.reject(new Error("odoo message_post boom")) : Promise.resolve(123);
      }
      return Promise.resolve(true);
    }
  };
}

/** Builds a write-tool agent whose queue is the given stub (must be wired before init so the closure captures it). */
async function buildAgentWithQueue(queue: unknown, propsOverride?: unknown) {
  const AgentCtor = McpAgent as any;
  const agent = new AgentCtor();
  agent.odooQueue = queue;
  agent.props = propsOverride ?? { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  await agent.init();
  return agent;
}

describe("callOdoo", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns result on first attempt for 200 status", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: "my-data" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    const res = await callOdoo(conn, "test.model", "test_method", { foo: "bar" });

    expect(res).toBe("my-data");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  const transientStatuses = [429, 502, 503, 504];
  for (const status of transientStatuses) {
    test(`retries on ${status} status and succeeds if status becomes 200 on later attempt`, async () => {
      let callCount = 0;
      const fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve(new Response(`Error ${status}`, { status }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ result: `success-${status}` }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      });
      globalThis.fetch = fetchMock;

      const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
      const res = await callOdoo(conn, "test.model", "test_method", { foo: "bar" });

      expect(res).toBe(`success-${status}`);
      expect(fetchMock.mock.calls.length).toBe(2);
    });
  }

  test("exhausts retries on 503 and throws the final failure error", async () => {
    const fetchMock = mock(() => {
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    });
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };

    let error: Error | undefined;
    try {
      await callOdoo(conn, "test.model", "test_method", { foo: "bar" });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("failed (503)");
    expect(fetchMock.mock.calls.length).toBe(3); // ODOO_MAX_ATTEMPTS = 3
  });

  test("aborts on timeout and throws clean error", async () => {
    const fetchMock = mock((url: any, init: any) => {
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          } else {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        }
      });
    });
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-test-key-12345" };

    let error: Error | undefined;
    try {
      // Use 10ms timeout
      await callOdoo(conn, "test.model", "test_method", { foo: "bar" }, 10);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("timed out");
    expect(error?.message).not.toContain("secret-test-key-12345");
    expect(error?.message).not.toContain("Bearer");
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  test("handles immediate AbortError rejection cleanly and retries", async () => {
    const fetchMock = mock(() => {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-test-key-12345" };

    let error: Error | undefined;
    try {
      await callOdoo(conn, "test.model", "test_method", { foo: "bar" }, 100);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("timed out");
    expect(error?.message).not.toContain("secret-test-key-12345");
    expect(error?.message).not.toContain("Bearer");
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  test("does not leak API key on 500 error", async () => {
    const fetchMock = mock(() => {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500 }));
    });
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-test-key-12345" };

    let error: Error | undefined;
    try {
      await callOdoo(conn, "test.model", "test_method", { foo: "bar" });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("failed (500)");
    expect(error?.message).not.toContain("secret-test-key-12345");
    expect(error?.message).not.toContain("Bearer");
  });

  test("does not leak API key on network error", async () => {
    const fetchMock = mock(() => {
      return Promise.reject(new Error("Failed to fetch due to network issues"));
    });
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-test-key-12345" };

    let error: Error | undefined;
    try {
      await callOdoo(conn, "test.model", "test_method", { foo: "bar" });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("failed: network error");
    expect(error?.message).not.toContain("secret-test-key-12345");
    expect(error?.message).not.toContain("Bearer");
  });

  test("throws immediately on 400 response (non-retryable)", async () => {
    const fetchMock = mock(() => {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "Bad Request" } }), { status: 400 }));
    });
    globalThis.fetch = fetchMock;

    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };

    let error: Error | undefined;
    try {
      await callOdoo(conn, "test.model", "test_method", { foo: "bar" });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("failed (400): Bad Request");
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe("OdooError classification", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-classify-key" };

  const statusCases: Array<{ status: number; code: string; recoverable: boolean }> = [
    { status: 401, code: "unauthorized", recoverable: false },
    { status: 403, code: "permission_denied", recoverable: false },
    { status: 404, code: "model_or_method_not_found", recoverable: false },
    { status: 400, code: "invalid_request", recoverable: false },
    { status: 500, code: "odoo_server_error", recoverable: false }
  ];

  for (const { status, code, recoverable } of statusCases) {
    test(`classifies HTTP ${status} as ${code} (recoverable=${recoverable})`, async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ error: { message: `boom-${status}` } }), { status }))
      );

      let error: any;
      try {
        await callOdoo(conn, "account.move", "write", { ids: [1] });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(OdooError);
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(status);
      expect(error.recoverable).toBe(recoverable);
      expect(error.model).toBe("account.move");
      expect(error.method).toBe("write");
    });
  }

  test("classifies exhausted 429 retries as rate_limited (recoverable)", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("Too Many Requests", { status: 429 })));

    let error: any;
    try {
      await callOdoo(conn, "account.move", "write", { ids: [1] });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(OdooError);
    expect(error.code).toBe("rate_limited");
    expect(error.httpStatus).toBe(429);
    expect(error.recoverable).toBe(true);
  });

  test("classifies a timeout as timeout (recoverable)", async () => {
    globalThis.fetch = mock((_url: any, init: any) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    });

    let error: any;
    try {
      await callOdoo(conn, "account.move", "write", { ids: [1] }, 10);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(OdooError);
    expect(error.code).toBe("timeout");
    expect(error.httpStatus).toBeNull();
    expect(error.recoverable).toBe(true);
  });

  test("classifies a network error (fetch rejects, non-Abort) as network_error (recoverable)", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Failed to fetch due to network issues")));

    let error: any;
    try {
      await callOdoo(conn, "account.move", "write", { ids: [1] });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(OdooError);
    expect(error.code).toBe("network_error");
    expect(error.httpStatus).toBeNull();
    expect(error.recoverable).toBe(true);
    expect(error.details).not.toContain("secret-classify-key");
    expect(error.details).not.toContain("Bearer");
  });
});

describe("default fetch handler", () => {
  const validHeaders = {
    Authorization: "Bearer my-secret-token-abc123",
    "X-Odoo-Url": "http://odoo.example.com",
    "X-Odoo-Db": "my-db"
  };

  // POST: real MCP traffic is POST; GET /mcp is deliberately 405 (no push stream).
  function makeRequest(headers: Record<string, string>, path = "/mcp") {
    return new Request(`http://worker.example.com${path}`, { method: "POST", headers });
  }

  test("returns 404 for non-/mcp paths", async () => {
    const res = await handler.fetch(makeRequest(validHeaders, "/other"), {} as any, {} as any);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  test("returns 401 when Authorization header is missing", async () => {
    const { Authorization, ...rest } = validHeaders;
    const res = await handler.fetch(makeRequest(rest), {} as any, {} as any);
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const json = JSON.parse(text);
    expect(json.error).toBeDefined();
    expect(text).not.toContain(validHeaders["X-Odoo-Url"]);
    expect(text).not.toContain(validHeaders["X-Odoo-Db"]);
  });

  test("returns 401 when Authorization header is not Bearer-prefixed", async () => {
    const res = await handler.fetch(
      makeRequest({ ...validHeaders, Authorization: "Basic abc123" }),
      {} as any,
      {} as any
    );
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain(validHeaders["X-Odoo-Url"]);
    expect(text).not.toContain(validHeaders["X-Odoo-Db"]);
  });

  test("returns 401 when Bearer token is empty after trimming", async () => {
    const res = await handler.fetch(
      makeRequest({ ...validHeaders, Authorization: "Bearer    " }),
      {} as any,
      {} as any
    );
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).not.toContain(validHeaders["X-Odoo-Url"]);
    expect(text).not.toContain(validHeaders["X-Odoo-Db"]);
  });

  test("returns 401 when X-Odoo-Url header is missing", async () => {
    const { "X-Odoo-Url": _omit, ...rest } = validHeaders;
    const res = await handler.fetch(makeRequest(rest), {} as any, {} as any);
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).not.toContain(validHeaders.Authorization);
    expect(text).not.toContain(validHeaders["X-Odoo-Db"]);
  });

  test("returns 401 when X-Odoo-Db header is missing", async () => {
    const { "X-Odoo-Db": _omit, ...rest } = validHeaders;
    const res = await handler.fetch(makeRequest(rest), {} as any, {} as any);
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).not.toContain(validHeaders.Authorization);
    expect(text).not.toContain(validHeaders["X-Odoo-Url"]);
  });

  test("valid headers reach McpAgent.serve(...).fetch with correctly threaded props", async () => {
    const res = await handler.fetch(makeRequest(validHeaders), {} as any, {} as any);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.props.odooBaseUrl).toBe(validHeaders["X-Odoo-Url"]);
    expect(json.props.odooDb).toBe(validHeaders["X-Odoo-Db"]);
    expect(json.props.odooApiKey).toBe("my-secret-token-abc123");
  });
});

describe("pickSmartFields", () => {
  test("excludes technical/expensive/non-stored fields, prioritizes specific fields, and limits to 15", () => {
    const fieldsMeta = {
      // Excluded:
      create_date: { type: "datetime", store: true },
      write_uid: { type: "many2one", store: true },
      __last_update: { type: "datetime", store: false },
      attachment_ids: { type: "one2many", store: true },
      tag_ids: { type: "many2many", store: true },
      image: { type: "binary", store: true },
      computed_field: { type: "char", store: false },
      __custom_internal: { type: "char", store: true },

      // Normal stored priority fields:
      active: { type: "boolean", store: true },
      state: { type: "selection", store: true },
      display_name: { type: "char", store: true },
      name: { type: "char", store: true },
      id: { type: "integer", store: true },

      // Normal stored other fields (at least 10 to exceed 15 total):
      description: { type: "text", store: true },
      user_id: { type: "many2one", store: true },
      date_deadline: { type: "date", store: true },
      sequence: { type: "integer", store: true },
      kanban_state: { type: "selection", store: true },
      email: { type: "char", store: true },
      phone: { type: "char", store: true },
      website: { type: "char", store: true },
      notes: { type: "text", store: true },
      color: { type: "integer", store: true },
      company_id: { type: "many2one", store: true },
      partner_id: { type: "many2one", store: true }
    };

    const res = pickSmartFields(fieldsMeta);

    // Excluded fields absent
    expect(res).not.toContain("create_date");
    expect(res).not.toContain("write_uid");
    expect(res).not.toContain("__last_update");
    expect(res).not.toContain("attachment_ids");
    expect(res).not.toContain("tag_ids");
    expect(res).not.toContain("image");
    expect(res).not.toContain("computed_field");
    expect(res).not.toContain("__custom_internal");

    // Correct length <= 15
    expect(res.length).toBeLessThanOrEqual(15);
    expect(res.length).toBe(15);

    // Priority ordering
    expect(res.slice(0, 5)).toEqual(["id", "name", "display_name", "state", "active"]);
  });
});

describe("normalizer", () => {
  test("normalizeRecord: many2one populated tuple becomes {id, name}", () => {
    const record = { user_id: [5, "Some Name"] };
    const fieldsMeta = { user_id: { type: "many2one" } };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ user_id: { id: 5, name: "Some Name" } });
  });

  test("normalizeRecord: many2one empty (false) becomes null", () => {
    const record = { user_id: false };
    const fieldsMeta = { user_id: { type: "many2one" } };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ user_id: null });
  });

  test("normalizeRecord: one2many/many2many populated becomes {ids, count}", () => {
    const record = { tag_ids: [1, 2, 3], attachment_ids: [7] };
    const fieldsMeta = {
      tag_ids: { type: "many2many" },
      attachment_ids: { type: "one2many" }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({
      tag_ids: { ids: [1, 2, 3], count: 3 },
      attachment_ids: { ids: [7], count: 1 }
    });
  });

  test("normalizeRecord: one2many/many2many empty array becomes {ids: [], count: 0}", () => {
    const record = { tag_ids: [] };
    const fieldsMeta = { tag_ids: { type: "many2many" } };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ tag_ids: { ids: [], count: 0 } });
  });

  test("normalizeRecord: one2many/many2many false WITH metadata becomes null", () => {
    const record = { tag_ids: false, attachment_ids: false };
    const fieldsMeta = {
      tag_ids: { type: "many2many" },
      attachment_ids: { type: "one2many" }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ tag_ids: null, attachment_ids: null });
  });

  test("normalizeRecord: scalar char/date/datetime false WITH metadata becomes null", () => {
    const record = { name: false, date_deadline: false, write_date: false };
    const fieldsMeta = {
      name: { type: "char" },
      date_deadline: { type: "date" },
      write_date: { type: "datetime" }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ name: null, date_deadline: null, write_date: null });
  });

  test("normalizeRecord: scalar char/date/datetime false WITHOUT metadata stays false", () => {
    const record = { name: false, date_deadline: false };
    expect(normalizeRecord(record)).toEqual({ name: false, date_deadline: false });
  });

  test("normalizeRecord: boolean fields stay boolean, with and without metadata", () => {
    const record = { active: true, is_done: false };
    const fieldsMeta = { active: { type: "boolean" }, is_done: { type: "boolean" } };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ active: true, is_done: false });
    expect(normalizeRecord(record)).toEqual({ active: true, is_done: false });
  });

  test("normalizeRecord: selection field WITH metadata + selection list becomes {value, label}", () => {
    const record = { state: "done" };
    const fieldsMeta = {
      state: {
        type: "selection",
        selection: [
          ["draft", "Draft"],
          ["done", "Done"]
        ] as [string, string][]
      }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ state: { value: "done", label: "Done" } });
  });

  test("normalizeRecord: selection field WITHOUT metadata passes raw value through unchanged", () => {
    const record = { state: "done" };
    expect(normalizeRecord(record)).toEqual({ state: "done" });
  });

  test("normalizeRecord: selection value not found in list falls back gracefully", () => {
    const record = { state: "unknown_value" };
    const fieldsMeta = {
      state: {
        type: "selection",
        selection: [
          ["draft", "Draft"],
          ["done", "Done"]
        ] as [string, string][]
      }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ state: { value: "unknown_value", label: null } });
  });

  test("normalizeRecord: selection field false WITH metadata becomes null", () => {
    const record = { state: false };
    const fieldsMeta = {
      state: {
        type: "selection",
        selection: [
          ["draft", "Draft"],
          ["done", "Done"]
        ] as [string, string][]
      }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ state: null });
  });

  test("normalizeRecord: monetary/float/integer values unchanged, including 0", () => {
    const record = { amount: 0, price: 12.5, sequence: 3 };
    const fieldsMeta = {
      amount: { type: "monetary" },
      price: { type: "float" },
      sequence: { type: "integer" }
    };
    expect(normalizeRecord(record, fieldsMeta)).toEqual({ amount: 0, price: 12.5, sequence: 3 });
    expect(normalizeRecord(record)).toEqual({ amount: 0, price: 12.5, sequence: 3 });
  });

  test("normalizeRecord: date/datetime ISO strings stay untouched", () => {
    const record = { date_deadline: "2026-07-02", write_date: "2026-07-02 10:00:00" };
    const fieldsMeta = { date_deadline: { type: "date" }, write_date: { type: "datetime" } };
    expect(normalizeRecord(record, fieldsMeta)).toEqual(record);
  });

  test("normalizeRecord: heuristic fallback without fieldsMeta still normalizes relational shapes", () => {
    const record = { user_id: [5, "Some Name"], tag_ids: [1, 2, 3] };
    expect(normalizeRecord(record)).toEqual({
      user_id: { id: 5, name: "Some Name" },
      tag_ids: { ids: [1, 2, 3], count: 3 }
    });
  });

  test("normalizeRecord: id field and other clean values pass through untouched", () => {
    const record = { id: 42, display_name: "Task A" };
    expect(normalizeRecord(record)).toEqual({ id: 42, display_name: "Task A" });
  });

  test("normalizeRecord: empty record returns empty object", () => {
    expect(normalizeRecord({})).toEqual({});
  });

  test("normalizeRecords: maps normalizeRecord over multiple records", () => {
    const records = [{ id: 1, user_id: [5, "A"] as [number, string] }, { id: 2, user_id: false }];
    const fieldsMeta = { user_id: { type: "many2one" } };
    expect(normalizeRecords(records, fieldsMeta)).toEqual([
      { id: 1, user_id: { id: 5, name: "A" } },
      { id: 2, user_id: null }
    ]);
  });

  test("normalizeRecords: opts.includeRaw attaches original record under _raw", () => {
    const records = [{ id: 1, user_id: [5, "A"] as [number, string] }];
    const fieldsMeta = { user_id: { type: "many2one" } };
    expect(normalizeRecords(records, fieldsMeta, { includeRaw: true })).toEqual([
      { id: 1, user_id: { id: 5, name: "A" }, _raw: { id: 1, user_id: [5, "A"] } }
    ]);
  });

  test("normalizeRecords: omitted/false includeRaw does not add _raw", () => {
    const records = [{ id: 1 }];
    expect(normalizeRecords(records)).toEqual([{ id: 1 }]);
    expect(normalizeRecords(records, undefined, { includeRaw: false })).toEqual([{ id: 1 }]);
  });

  test("normalizeRecords: empty records array returns empty array", () => {
    expect(normalizeRecords([])).toEqual([]);
  });
});

describe("deriveWorkflowStatus", () => {
  test("record with state string returns the state", () => {
    expect(deriveWorkflowStatus({ state: "draft" })).toBe("draft");
  });

  test("record with stage_id tuple returns the label", () => {
    expect(deriveWorkflowStatus({ stage_id: [3, "Done"] })).toBe("Done");
  });

  test("state takes precedence over stage_id when both are present", () => {
    expect(deriveWorkflowStatus({ state: "confirmed", stage_id: [3, "Done"] })).toBe("confirmed");
  });

  test("record with neither field returns null", () => {
    expect(deriveWorkflowStatus({ id: 1 })).toBeNull();
  });

  test("falsy state values (empty string, 0, false) return null", () => {
    expect(deriveWorkflowStatus({ state: "" })).toBeNull();
    expect(deriveWorkflowStatus({ state: 0 })).toBeNull();
    expect(deriveWorkflowStatus({ state: false })).toBeNull();
  });

  test("stage_id false (Odoo's no-relation convention) returns null", () => {
    expect(deriveWorkflowStatus({ stage_id: false })).toBeNull();
  });

  test("stage_id malformed (not a [id, label] tuple) returns null", () => {
    expect(deriveWorkflowStatus({ stage_id: [3] })).toBeNull();
    expect(deriveWorkflowStatus({ stage_id: "Done" })).toBeNull();
  });
});

describe("searchRecords", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("resolves smart fields when fields is null", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      if (url.endsWith("/fields_get")) {
        return new Response(
          JSON.stringify({
            result: {
              id: { type: "integer", store: true },
              name: { type: "char", store: true },
              display_name: { type: "char", store: true },
              image: { type: "binary", store: true }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], null, 10);

    expect(fetchCalls.length).toBe(2);
    // First call should be fields_get
    expect(fetchCalls[0].url).toContain("/fields_get");
    expect(fetchCalls[0].body).toEqual({ attributes: ["type", "store", "selection"] });
    // Second call should be search_read with resolved smart fields
    expect(fetchCalls[1].url).toContain("/search_read");
    expect(fetchCalls[1].body.fields).toEqual(["id", "name", "display_name"]);
  });

  test("handles __all__ sentinel without calling fields_get", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["__all__"], 10);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/search_read");
    expect(fetchCalls[0].body.fields).toEqual([]);
  });

  test("passes explicit fields list without calling fields_get", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 10);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/search_read");
    expect(fetchCalls[0].body.fields).toEqual(["id", "name"]);
  });

  test("falls back to DEFAULT_GENERIC_FIELDS if fields_get throws", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      if (url.endsWith("/fields_get")) {
        return new Response(JSON.stringify({ error: { message: "Model not found" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], null, 10);

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0].url).toContain("/fields_get");
    expect(fetchCalls[1].url).toContain("/search_read");
    expect(fetchCalls[1].body.fields).toEqual(["id", "display_name"]);
  });

  test("clamps an out-of-range limit down to 100", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 500);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/search_read");
    expect(fetchCalls[0].body.limit).toBe(100);
  });

  test("leaves an in-range limit unchanged", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 1);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/search_read");
    expect(fetchCalls[0].body.limit).toBe(1);
  });

  test("forwards order into search_read kwargs when provided", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 10, "name desc");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.order).toBe("name desc");
  });

  test("forwards offset into search_read kwargs when provided", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 10, undefined, 20);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.offset).toBe(20);
  });

  test("defaults offset to 0 when not provided", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 10);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.offset).toBe(0);
  });

  test("exposes fetched fieldsMeta on the return value when fields is null", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    const fetchMock = mock(async (url: string, init: any) => {
      if (url.endsWith("/fields_get")) {
        return new Response(
          JSON.stringify({
            result: {
              id: { type: "integer", store: true },
              name: { type: "char", store: true },
              display_name: { type: "char", store: true },
              image: { type: "binary", store: true }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const result = await searchRecords(makeQueue(), conn, "test.model", [], null, 10);
    expect(result.fieldsMeta).toEqual({
      id: { type: "integer", store: true },
      name: { type: "char", store: true },
      display_name: { type: "char", store: true },
      image: { type: "binary", store: true }
    });
    expect(result.rows).toEqual([]);
  });

  test("returns fieldsMeta: null when explicit fields list is passed", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const result = await searchRecords(makeQueue(), conn, "test.model", [], ["id", "name"], 10);
    expect(result.fieldsMeta).toBeNull();
  });
});

describe("write tool callOdoo call shapes", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("create_record calls create with vals_list wrapping the values", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: [42] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const values = { name: "New Task" };
    const res = await callOdoo(conn, "project.task", "create", { vals_list: [values] });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/create");
    expect(fetchCalls[0].body).toEqual({ vals_list: [values] });
    expect(res).toEqual([42]);
  });

  test("update_record calls write with ids and vals", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const values = { name: "Renamed" };
    await callOdoo(conn, "project.task", "write", { ids: [7], vals: values });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/write");
    expect(fetchCalls[0].body).toEqual({ ids: [7], vals: values });
  });

  test("delete_record calls unlink with ids", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await callOdoo(conn, "project.task", "unlink", { ids: [7] });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/unlink");
    expect(fetchCalls[0].body).toEqual({ ids: [7] });
  });

  test("does not leak values or API key on write error", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-write-key-99999" };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Access Denied" } }), { status: 403 }))
    );
    globalThis.fetch = fetchMock;

    let error: Error | undefined;
    try {
      await callOdoo(conn, "project.task", "write", { ids: [7], vals: { secret_field: "sensitive-value-xyz" } });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).not.toContain("secret-write-key-99999");
    expect(error?.message).not.toContain("sensitive-value-xyz");
    expect(error?.message).not.toContain("Bearer");
  });
});

describe("create_record provenance stamping", () => {
  const STAMP_RE = /\[agent-source\] engineering_task corr=src-[0-9a-f]{8} via=\S+/;

  test("project.task happy path: exactly create then message_post targeting the new id", async () => {
    const queue = makeStubQueue({ createId: 42 });
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "create_record");

    const result = await handler({ model: "project.task", values: { name: "New Task" } });

    expect(queue.calls.length).toBe(2);
    expect(queue.calls[0].method).toBe("create");
    expect(queue.calls[0].args).toEqual({ vals_list: [{ name: "New Task" }] });
    expect(queue.calls[1].method).toBe("message_post");
    expect(queue.calls[1].model).toBe("project.task");
    expect(queue.calls[1].args.ids).toEqual([42]);
    expect(queue.calls[1].args.message_type).toBe("comment");
    expect(queue.calls[1].args.body).toMatch(STAMP_RE);
    expect(result.isError).toBeUndefined();
  });

  test("result text includes the new id, the same token as the chatter body, and the echo instruction", async () => {
    const queue = makeStubQueue({ createId: 77 });
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "create_record");

    const result = await handler({ model: "project.task", values: { name: "X" } });
    const text = result.content[0].text as string;
    const bodyToken = (queue.calls[1].args.body as string).match(/src-[0-9a-f]{8}/)![0];

    expect(text).toContain("77");
    expect(text).toContain(bodyToken);
    expect(text).toContain("include this token verbatim");
    // The token must be front-loaded (before the id), not appended, so the model leads with it.
    expect(text.indexOf(bodyToken)).toBeLessThan(text.indexOf("77"));
  });

  test("other model: single enqueue, no token, no marker post", async () => {
    const queue = makeStubQueue({ createId: 5 });
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "create_record");

    const result = await handler({ model: "res.partner", values: { name: "Acme" } });
    const text = result.content[0].text as string;

    expect(queue.calls.length).toBe(1);
    expect(queue.calls[0].method).toBe("create");
    expect(text).toContain("5");
    expect(text).not.toContain("Trace token");
    expect(text).not.toContain("[agent-source]");
  });

  test("post failure isolation: still returns id + warning, isError not set", async () => {
    const queue = makeStubQueue({ createId: 88, failMessagePost: true });
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "create_record");

    const result = await handler({ model: "project.task", values: { name: "X" } });
    const text = result.content[0].text as string;

    expect(text).toContain("88");
    expect(text).toContain("failed to post the provenance stamp");
    expect(result.isError).toBeUndefined();
  });

  test("via=unknown fallback when no clientName prop and no client version", async () => {
    const queue = makeStubQueue({ createId: 9 });
    const agent = await buildAgentWithQueue(queue, {
      odooBaseUrl: "http://example.com",
      odooDb: "test-db",
      odooApiKey: "secret-key"
    });
    expect(agent.server.server.getClientVersion()).toBeUndefined();
    const handler = getToolHandler(agent, "create_record");

    await handler({ model: "project.task", values: { name: "X" } });

    expect(queue.calls[1].args.body as string).toMatch(/ via=unknown$/);
  });

  test("uniqueness: two consecutive project.task creates produce different tokens", async () => {
    const queue = makeStubQueue({ createId: 1 });
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "create_record");

    await handler({ model: "project.task", values: { name: "A" } });
    await handler({ model: "project.task", values: { name: "B" } });

    const t1 = (queue.calls[1].args.body as string).match(/src-[0-9a-f]{8}/)![0];
    const t2 = (queue.calls[3].args.body as string).match(/src-[0-9a-f]{8}/)![0];
    expect(t1).not.toBe(t2);
  });
});

describe("chatter HTML escaping — no double-escape", () => {
  // Regression: message_post bodies were escaped locally but sent WITHOUT
  // body_is_html, so Odoo re-escaped them (`<p>` → `&amp;lt;p&amp;gt;`), rendering
  // as the literal text `&lt;p&gt;`. The fix escapes once AND declares
  // body_is_html:true so Odoo leaves the body untouched.

  test("post_message plain text: escaped exactly once AND body_is_html declared", async () => {
    const queue = makeStubQueue();
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "post_message");

    await handler({ model: "project.task", record_id: 7, body: "<p>hi</p> & <b>x</b>", body_is_html: false });

    const call = queue.calls.find((c) => c.method === "message_post")!;
    // single-escaped (renders literally as "<p>hi</p> & <b>x</b>"), NOT &amp;lt;
    expect(call.args.body).toBe("&lt;p&gt;hi&lt;/p&gt; &amp; &lt;b&gt;x&lt;/b&gt;");
    expect(call.args.body_is_html).toBe(true);
  });

  test("post_message plain text: newlines become <br>", async () => {
    const queue = makeStubQueue();
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "post_message");

    await handler({ model: "project.task", record_id: 7, body: "line1\nline2", body_is_html: false });

    const call = queue.calls.find((c) => c.method === "message_post")!;
    expect(call.args.body).toBe("line1<br>line2");
    expect(call.args.body_is_html).toBe(true);
  });

  test("post_message body_is_html:true passes raw HTML through and declares it", async () => {
    const queue = makeStubQueue();
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "post_message");

    await handler({ model: "project.task", record_id: 7, body: "<p>already <b>HTML</b></p>", body_is_html: true });

    const call = queue.calls.find((c) => c.method === "message_post")!;
    expect(call.args.body).toBe("<p>already <b>HTML</b></p>");
    expect(call.args.body_is_html).toBe(true);
  });

  test("batch_post_message: each entry escaped once and body_is_html declared", async () => {
    const queue = makeStubQueue();
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "batch_post_message");

    await handler({
      model: "project.task",
      messages: [
        { record_id: 1, body: "<i>a</i>", body_is_html: false },
        { record_id: 2, body: "<i>b</i>", body_is_html: true }
      ]
    });

    const posts = queue.calls.filter((c) => c.method === "message_post");
    expect(posts[0].args.body).toBe("&lt;i&gt;a&lt;/i&gt;");
    expect(posts[0].args.body_is_html).toBe(true);
    expect(posts[1].args.body).toBe("<i>b</i>");
    expect(posts[1].args.body_is_html).toBe(true);
  });

  test("create_record provenance stamp declares body_is_html", async () => {
    const queue = makeStubQueue({ createId: 42 });
    const agent = await buildAgentWithQueue(queue);
    const handler = getToolHandler(agent, "create_record");

    await handler({ model: "project.task", values: { name: "X" } });

    const post = queue.calls.find((c) => c.method === "message_post")!;
    expect(post.args.body_is_html).toBe(true);
  });
});

describe("post_message tool callOdoo call shape", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls message_post with ids, body, message_type and optional subtype_xmlid", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 99 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const res = await callOdoo(conn, "project.task", "message_post", {
      ids: [7],
      body: "hello",
      message_type: "comment",
      subtype_xmlid: "mail.mt_comment"
    });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/message_post");
    expect(fetchCalls[0].body).toEqual({
      ids: [7],
      body: "hello",
      message_type: "comment",
      subtype_xmlid: "mail.mt_comment"
    });
    expect(res).toBe(99);
  });

  test("omits subtype_xmlid when subtype is not provided", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 100 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await callOdoo(conn, "project.task", "message_post", {
      ids: [7],
      body: "hello",
      message_type: "comment"
    });

    expect(fetchCalls[0].body).toEqual({ ids: [7], body: "hello", message_type: "comment" });
    expect(fetchCalls[0].body.subtype_xmlid).toBeUndefined();
  });

  test("escapeHtml escapes &, <, >, \", ' so plain text can't be interpreted as HTML", () => {
    expect(escapeHtml(`<b>hi</b> & "quotes" 'apos'`)).toBe(
      "&lt;b&gt;hi&lt;/b&gt; &amp; &quot;quotes&quot; &#39;apos&#39;"
    );
  });

  test("body_is_html: false (default) sends an HTML-escaped body to message_post", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 101 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const rawBody = `<script>alert('x')</script> & co.`;
    const body_is_html = false;

    await callOdoo(conn, "project.task", "message_post", {
      ids: [7],
      body: body_is_html ? rawBody : escapeHtml(rawBody),
      message_type: "comment"
    });

    expect(fetchCalls[0].body.body).toBe("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; co.");
  });

  test("body_is_html: true sends the raw body unescaped to message_post", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 102 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const rawBody = "<p>already <b>HTML</b></p>";
    const body_is_html = true;

    await callOdoo(conn, "project.task", "message_post", {
      ids: [7],
      body: body_is_html ? rawBody : escapeHtml(rawBody),
      message_type: "comment"
    });

    expect(fetchCalls[0].body.body).toBe("<p>already <b>HTML</b></p>");
  });

  test("retries on 503 and eventually succeeds (proves callOdoo retry reuse)", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    });
    globalThis.fetch = fetchMock;

    const res = await callOdoo(conn, "project.task", "message_post", { ids: [7], body: "hi", message_type: "comment" });

    expect(res).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("times out after 15s default via callOdoo (no new timeout logic)", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-post-key-abc" };
    const fetchMock = mock((url: any, init: any) => {
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    globalThis.fetch = fetchMock;

    let error: Error | undefined;
    try {
      await callOdoo(conn, "project.task", "message_post", { ids: [7], body: "hi", message_type: "comment" }, 10);
    } catch (err) {
      error = err as Error;
    }

    expect(error?.message).toContain("timed out");
    expect(error?.message).not.toContain("secret-post-key-abc");
  });

  test("does not leak API key or body content on error response", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-post-key-xyz" };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Access Denied" } }), { status: 403 }))
    );
    globalThis.fetch = fetchMock;

    let error: Error | undefined;
    try {
      await callOdoo(conn, "project.task", "message_post", {
        ids: [7],
        body: "super-sensitive-note",
        message_type: "comment"
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).not.toContain("secret-post-key-xyz");
    expect(error?.message).not.toContain("Bearer");
  });

  test("rejects empty-string model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "post_message");
    const result = await handler({ model: "", record_id: 7, body: "hi", body_is_html: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("rejects whitespace-only model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "post_message");
    const result = await handler({ model: "   ", record_id: 7, body: "hi", body_is_html: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("rejects record_id: 0 without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "post_message");
    const result = await handler({ model: "project.task", record_id: 0, body: "hi", body_is_html: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("record_id must be a positive integer");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("rejects record_id: -1 without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "post_message");
    const result = await handler({ model: "project.task", record_id: -1, body: "hi", body_is_html: false });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("record_id must be a positive integer");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("aggregate_records tool callOdoo call shape", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls read_group with domain, fields (from aggregates), groupby, lazy, orderby", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: [{ stage_id: 1, stage_id_count: 3 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const res = await callOdoo(conn, "project.task", "read_group", {
      domain: [["active", "=", true]],
      fields: ["stage_id"],
      groupby: ["stage_id"],
      lazy: true,
      orderby: "stage_id"
    });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/read_group");
    expect(fetchCalls[0].body).toEqual({
      domain: [["active", "=", true]],
      fields: ["stage_id"],
      groupby: ["stage_id"],
      lazy: true,
      orderby: "stage_id"
    });
    expect(res).toEqual([{ stage_id: 1, stage_id_count: 3 }]);
  });

  test("omits orderby when not provided", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await callOdoo(conn, "project.task", "read_group", {
      domain: [],
      fields: ["stage_id"],
      groupby: ["stage_id"],
      lazy: false
    });

    expect(fetchCalls[0].body).toEqual({ domain: [], fields: ["stage_id"], groupby: ["stage_id"], lazy: false });
    expect(fetchCalls[0].body.orderby).toBeUndefined();
  });

  test("retries on 429 and eventually succeeds (proves callOdoo retry reuse)", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.resolve(new Response("Too Many Requests", { status: 429 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    });
    globalThis.fetch = fetchMock;

    const res = await callOdoo(conn, "project.task", "read_group", {
      domain: [],
      fields: ["stage_id"],
      groupby: ["stage_id"],
      lazy: true
    });

    expect(res).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("does not leak API key on error response", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-agg-key-777" };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Bad domain" } }), { status: 400 }))
    );
    globalThis.fetch = fetchMock;

    let error: Error | undefined;
    try {
      await callOdoo(conn, "project.task", "read_group", {
        domain: [],
        fields: ["stage_id"],
        groupby: ["stage_id"],
        lazy: true
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).not.toContain("secret-agg-key-777");
    expect(error?.message).not.toContain("Bearer");
  });
});

describe("aggregate_records pre-flight validation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const TASK_FIELDS_META = {
    stage_id: { type: "many2one", string: "Stage", store: true },
    amount_total: { type: "monetary", string: "Total", store: true },
    state: { type: "selection", string: "Status", store: true }
  };

  function mockOdoo(routes: Record<string, unknown>, log?: { url: string; body: any }[]) {
    return mock(async (url: string, init: any) => {
      const key = Object.keys(routes).find((k) => url.endsWith(`/json/2/${k}`));
      if (log) log.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const outcome = key ? routes[key] : undefined;
      if (outcome instanceof Error) {
        return new Response(JSON.stringify({ error: { message: outcome.message } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ result: outcome ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
  }

  test("invalid groupby — no read_group call", async () => {
    const agent = await buildWriteToolAgent();
    const log: { url: string; body: any }[] = [];
    globalThis.fetch = mockOdoo({ "project.task/fields_get": TASK_FIELDS_META }, log);

    const handler = getToolHandler(agent, "aggregate_records");
    const result = await handler({
      model: "project.task",
      domain: [],
      groupby: ["bogus_field"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("invalid_groupby");
    expect(envelope.method).toBe("read_group");
    expect(log.some((entry) => entry.url.includes("/read_group"))).toBe(false);
  });

  test("unsupported aggregate — no read_group call", async () => {
    const agent = await buildWriteToolAgent();
    const log: { url: string; body: any }[] = [];
    globalThis.fetch = mockOdoo({ "project.task/fields_get": TASK_FIELDS_META }, log);

    const handler = getToolHandler(agent, "aggregate_records");
    const result = await handler({
      model: "project.task",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["amount_total:avg"],
      lazy: true
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("unsupported_aggregate");
    expect(log.some((entry) => entry.url.includes("/read_group"))).toBe(false);
  });

  test("happy path — read_group called once with unchanged body shape", async () => {
    const agent = await buildWriteToolAgent();
    const log: { url: string; body: any }[] = [];
    globalThis.fetch = mockOdoo(
      {
        "project.task/fields_get": TASK_FIELDS_META,
        "project.task/read_group": [{ stage_id: 1, amount_total: 100, __count: 3 }]
      },
      log
    );

    const handler = getToolHandler(agent, "aggregate_records");
    const result = await handler({
      model: "project.task",
      domain: [["active", "=", true]],
      groupby: ["stage_id"],
      aggregates: ["amount_total:sum", "__count"],
      lazy: true,
      orderby: "stage_id"
    });

    expect(result.isError).toBeUndefined();
    const readGroupCalls = log.filter((entry) => entry.url.includes("/read_group"));
    expect(readGroupCalls.length).toBe(1);
    expect(readGroupCalls[0].body).toEqual({
      domain: [["active", "=", true]],
      fields: ["amount_total:sum", "__count"],
      groupby: ["stage_id"],
      lazy: true,
      orderby: "stage_id"
    });
  });

  test("pre-flight error does not leak API key", async () => {
    const agent = await buildWriteToolAgent();
    agent.props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-agg-preflight-key" };
    globalThis.fetch = mockOdoo({ "project.task/fields_get": TASK_FIELDS_META });

    const handler = getToolHandler(agent, "aggregate_records");
    const result = await handler({
      model: "project.task",
      domain: [],
      groupby: ["bogus_field"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.content[0].text).not.toContain("secret-agg-preflight-key");
    expect(result.content[0].text).not.toContain("Bearer");
  });
});

describe("get_fields tool callOdoo call shape", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls fields_get with the full metadata attributes list", async () => {
    const agent = await buildWriteToolAgent();
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: { name: { type: "char", string: "Name" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "get_fields");
    await handler({ model: "project.task" });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/fields_get");
    expect(fetchCalls[0].body.attributes).toEqual([
      "type",
      "string",
      "readonly",
      "required",
      "store",
      "selection",
      "relation",
      "help",
      "searchable",
      "sortable"
    ]);
    expect(fetchCalls[0].body.allfields).toBeUndefined();
  });

  test("forwards an explicit fields allowlist as allfields", async () => {
    const agent = await buildWriteToolAgent();
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: { name: { type: "char", string: "Name" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "get_fields");
    await handler({ model: "project.task", fields: ["name", "stage_id"] });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.allfields).toEqual(["name", "stage_id"]);
  });
});

describe("call_model_method tool callOdoo call shape", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("passes model, method, args and kwargs through unchanged as { ...kwargs, args }", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const args = [1, "two"];
    const kwargs = { context: { lang: "en_US" }, limit: 5 };
    const res = await callOdoo(conn, "res.partner", "some_custom_method", { ...kwargs, args });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/res.partner/some_custom_method");
    expect(fetchCalls[0].body).toEqual({ args: [1, "two"], context: { lang: "en_US" }, limit: 5 });
    expect(res).toBe("ok");
  });

  test("a kwargs key literally named 'args' cannot clobber the real positional args", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const args = [[5]];
    const kwargs = { args: [[999]], vals: { name: "x" } };
    await callOdoo(conn, "project.task", "write", { ...kwargs, args });

    expect(fetchCalls[0].body).toEqual({ args: [[5]], vals: { name: "x" } });
  });

  test("retries on 502 and eventually succeeds (proves callOdoo retry reuse)", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ result: "recovered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    });
    globalThis.fetch = fetchMock;

    const res = await callOdoo(conn, "res.partner", "some_custom_method", { args: [], ...{} });

    expect(res).toBe("recovered");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("does not leak API key or args/kwargs content on error response", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-generic-key-555" };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Method not allowed" } }), { status: 400 }))
    );
    globalThis.fetch = fetchMock;

    let error: Error | undefined;
    try {
      await callOdoo(conn, "res.partner", "dangerous_method", {
        args: ["sensitive-arg-value"],
        secret_field: "sensitive-kwarg-value"
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).not.toContain("secret-generic-key-555");
    expect(error?.message).not.toContain("Bearer");
  });

  test("rejects empty-string model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "call_model_method");
    const result = await handler({ model: "", method: "some_method", args: [], kwargs: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("rejects whitespace-only model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "call_model_method");
    const result = await handler({ model: "   ", method: "some_method", args: [], kwargs: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("rejects empty-string method without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "call_model_method");
    const result = await handler({ model: "res.partner", method: "", args: [], kwargs: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("method must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("rejects whitespace-only method without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "call_model_method");
    const result = await handler({ model: "res.partner", method: "   ", args: [], kwargs: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("method must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("parseButtonsFromArch", () => {
  test("extracts type=object buttons with name/string/confirm, excludes type=action buttons, dedupes by name", () => {
    const arch = `
      <form>
        <header>
          <button name="action_post" type="object" string="Post"/>
          <button name="button_cancel" type="object" string="Cancel" confirm="Are you sure?"/>
          <button name="button_cancel" type="object" string="Duplicate Cancel"/>
          <button name="do_report" type="action" string="Print"/>
        </header>
      </form>
    `;

    const actions = parseButtonsFromArch(arch);

    expect(actions).toEqual([
      { method: "action_post", label: "Post", source: "view" },
      { method: "button_cancel", label: "Cancel", confirm: "Are you sure?", source: "view" }
    ]);
    expect(actions.some((a: any) => a.method === "do_report")).toBe(false);
  });

  test("returns an empty array for missing/empty arch", () => {
    expect(parseButtonsFromArch(undefined)).toEqual([]);
    expect(parseButtonsFromArch(null)).toEqual([]);
    expect(parseButtonsFromArch("")).toEqual([]);
  });
});

describe("mergeModelActions", () => {
  test("view entry wins on duplicate method, curated entries retained, no duplicate methods", () => {
    const curated = CURATED_MODEL_ACTIONS["account.move"];
    const viewActions = [
      { method: "action_post", label: "Post Entry (view)", source: "view" as const },
      { method: "action_new_view_only_method", label: "New", source: "view" as const }
    ];

    const merged = mergeModelActions(curated, viewActions);

    const byMethod = new Map(merged.map((a: any) => [a.method, a]));
    expect(byMethod.get("action_post")).toEqual({ method: "action_post", label: "Post Entry (view)", source: "view" });
    expect(byMethod.get("button_draft")).toEqual({ method: "button_draft", source: "curated" });
    expect(byMethod.get("button_cancel")).toEqual({ method: "button_cancel", source: "curated" });
    expect(byMethod.get("action_new_view_only_method")).toEqual({
      method: "action_new_view_only_method",
      label: "New",
      source: "view"
    });

    const methods = merged.map((a: any) => a.method);
    expect(new Set(methods).size).toBe(methods.length);
  });
});

describe("list_model_actions tool", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("combines curated actions with form-view buttons, view wins on overlap", async () => {
    const agent = await buildWriteToolAgent();
    let fetchCalls: { url: string; body: any }[] = [];
    const arch =
      '<form><header>' +
      '<button name="action_post" type="object" string="Post (from view)"/>' +
      '<button name="do_print" type="action" string="Print"/>' +
      "</header></form>";
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: { views: { form: { arch } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "list_model_actions");
    const result = await handler({ model: "account.move" });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/account.move/get_views");
    expect(fetchCalls[0].body).toEqual({ views: [[false, "form"]] });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.note).toBeUndefined();
    const byMethod = new Map(payload.actions.map((a: any) => [a.method, a]));
    expect(byMethod.get("action_post")).toEqual({ method: "action_post", label: "Post (from view)", source: "view" });
    expect(byMethod.get("button_draft")).toEqual({ method: "button_draft", source: "curated" });
    expect(byMethod.get("do_print")).toBeUndefined();
  });

  test("falls back to curated-only actions with a note when get_views fails, without isError", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("network unreachable")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "list_model_actions");
    const result = await handler({ model: "sale.order" });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(typeof payload.note).toBe("string");
    expect(payload.actions).toEqual([
      { method: "action_confirm", source: "curated" },
      { method: "action_cancel", source: "curated" }
    ]);
  });

  test("rejects empty-string model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "list_model_actions");
    const result = await handler({ model: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("JSON error envelope (tool handlers)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("update_record surfaces a 403 as a permission_denied JSON envelope with isError:true", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Access Denied by Odoo" } }), { status: 403 }))
    );

    const handler = getToolHandler(agent, "update_record");
    const result = await handler({ model: "account.move", record_id: 1, values: { state: "posted" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope).toEqual({
      error: "permission_denied",
      model: "account.move",
      method: "write",
      http_status: 403,
      details: "Access Denied by Odoo",
      recoverable: false
    });
    expect(result.content[0].text).not.toContain("secret-key");
    expect(result.content[0].text).not.toContain("Bearer");
  });

  test("a timed-out call classifies as timeout with recoverable:true", async () => {
    const agent = await buildWriteToolAgent();
    // Rejects immediately with AbortError, so callOdoo's retry loop exhausts
    // without waiting on the real (default 15s) abort timer to fire.
    globalThis.fetch = mock(() => Promise.reject(new DOMException("Aborted", "AbortError")));

    const handler = getToolHandler(agent, "search_records");
    const result = await handler({ model: "account.move", domain: [], fields: ["id"], limit: 10 });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("timeout");
    expect(envelope.recoverable).toBe(true);
    expect(result.content[0].text).not.toContain("secret-key");
    expect(result.content[0].text).not.toContain("Bearer");
  });

  test("search_records returns a success result of [] (not isError) for zero matching rows", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
      )
    );

    const handler = getToolHandler(agent, "search_records");
    const result = await handler({ model: "account.move", domain: [["id", "=", -1]], fields: ["id"], limit: 10 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  test("get_record returns a success result of [] (not isError) when the record does not exist", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
      )
    );

    const handler = getToolHandler(agent, "get_record");
    const result = await handler({ model: "account.move", record_id: 999, fields: ["id"] });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  test("a plain (non-OdooError) thrown exception classifies as unknown, not recoverable", async () => {
    const AgentCtor = McpAgent as any;
    const agent = new AgentCtor();
    agent.odooQueue = makeQueue();
    agent.props = undefined; // requireConnection() throws a plain Error, never reaching callOdoo
    await agent.init();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "update_record");
    const result = await handler({ model: "account.move", record_id: 1, values: { state: "posted" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("unknown");
    expect(envelope.model).toBe("account.move");
    expect(envelope.method).toBe("write");
    expect(envelope.recoverable).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("search_records limit zod schema", () => {
  const schema = z.object({
    model: z.string(),
    domain: z.array(z.any()).default([]),
    fields: z.array(z.string()).nullable().default(null),
    limit: z.number().int().min(1).max(100).default(10),
    order: z.string().optional(),
    offset: z.number().int().min(0).default(0)
  });

  test("accepts valid limits and defaults to 10", () => {
    const res1 = schema.safeParse({ model: "res.partner" });
    expect(res1.success).toBe(true);
    if (res1.success) {
      expect(res1.data.limit).toBe(10);
    }

    const res2 = schema.safeParse({ model: "res.partner", limit: 50 });
    expect(res2.success).toBe(true);
    if (res2.success) {
      expect(res2.data.limit).toBe(50);
    }
  });

  test("rejects invalid limits", () => {
    const res1 = schema.safeParse({ model: "res.partner", limit: 150 });
    expect(res1.success).toBe(false);

    const res2 = schema.safeParse({ model: "res.partner", limit: 0 });
    expect(res2.success).toBe(false);

    const res3 = schema.safeParse({ model: "res.partner", limit: 1.5 });
    expect(res3.success).toBe(false);

    const res4 = schema.safeParse({ model: "res.partner", limit: -5 });
    expect(res4.success).toBe(false);
  });

  test("order is optional and absent when not provided", () => {
    const res = schema.safeParse({ model: "res.partner" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.order).toBeUndefined();
    }
  });

  test("order passes through a valid string", () => {
    const res = schema.safeParse({ model: "res.partner", order: "name desc" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.order).toBe("name desc");
    }
  });

  test("offset defaults to 0 and accepts non-negative integers", () => {
    const res1 = schema.safeParse({ model: "res.partner" });
    expect(res1.success).toBe(true);
    if (res1.success) {
      expect(res1.data.offset).toBe(0);
    }

    const res2 = schema.safeParse({ model: "res.partner", offset: 20 });
    expect(res2.success).toBe(true);
    if (res2.success) {
      expect(res2.data.offset).toBe(20);
    }
  });

  test("rejects negative offset", () => {
    const res = schema.safeParse({ model: "res.partner", offset: -1 });
    expect(res.success).toBe(false);
  });
});

describe("countRecords", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls search_count with domain and returns the numeric result", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 7 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const res = await countRecords(makeQueue(), conn, "project.task", [["active", "=", true]]);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/search_count");
    expect(fetchCalls[0].body).toEqual({ domain: [["active", "=", true]] });
    expect(res).toBe(7);
  });

  test("rejects an empty model without calling fetch", async () => {
    const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-key" };
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    let error: Error | undefined;
    try {
      await countRecords(makeQueue(), conn, "  ", []);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("tool metadata (title/annotations)", () => {
  test("every registered tool has a title and annotations; no write tool is marked read-only", async () => {
    const agent = await buildWriteToolAgent();
    const tools = Object.values(agent.server._registeredTools) as any[];

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toBeTruthy();
      expect(tool.annotations.openWorldHint).toBe(false);
    }

    const writeToolNames = ["create_record", "post_message", "update_record", "delete_record", "call_model_method"];
    for (const name of writeToolNames) {
      expect(agent.server._registeredTools[name].annotations.readOnlyHint).not.toBe(true);
    }
  });

  test("every registered tool declares an outputSchema (structured output)", async () => {
    const agent = await buildWriteToolAgent();
    const tools = Object.entries(agent.server._registeredTools) as [string, any][];

    expect(tools.length).toBeGreaterThan(0);
    for (const [name, tool] of tools) {
      expect(tool.outputSchema, `tool ${name} is missing an outputSchema`).toBeDefined();
    }
  });

  test("search_count returns structuredContent alongside the legacy text content", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ result: 7 }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    const handler = getToolHandler(agent, "search_count");
    const result = await handler({ model: "project.task", domain: [] });

    expect(result.structuredContent).toEqual({ count: 7 });
    expect(JSON.parse(result.content[0].text)).toEqual({ count: 7 });
    globalThis.fetch = originalFetch;
  });

  test("search_records keeps the legacy bare-array text while wrapping structuredContent in a records envelope", async () => {
    const agent = await buildWriteToolAgent();
    const rows = [{ id: 1, name: "Task" }];
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ result: rows }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as any;

    const handler = getToolHandler(agent, "search_records");
    const result = await handler({ model: "project.task", domain: [], fields: ["id", "name"], limit: 10, offset: 0 });

    expect(result.structuredContent).toEqual({
      records: rows,
      returned_fields: ["id", "name"],
      omitted_fields: [],
      warnings: []
    });
    expect(JSON.parse(result.content[0].text)).toEqual(rows);
    globalThis.fetch = originalFetch;
  });
});

describe("search_count", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls search_count RPC and returns { count } matching the mocked value", async () => {
    const agent = await buildWriteToolAgent();
    let fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "search_count");
    const result = await handler({ model: "project.task", domain: [["active", "=", true]] });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/search_count");
    expect(fetchCalls[0].body).toEqual({ domain: [["active", "=", true]] });
    expect(JSON.parse(result.content[0].text)).toEqual({ count: 42 });
  });

  test("rejects an empty model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "search_count");
    const result = await handler({ model: "  ", domain: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("resources", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const connProps = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-resource-key" };

  async function buildAgent() {
    const AgentCtor = McpAgent as any;
    const agent = new AgentCtor();
    agent.odooQueue = makeQueue();
    agent.props = connProps;
    await agent.init();
    return agent;
  }

  function getTemplate(agent: any, name: string) {
    return agent.server._registeredResourceTemplates[name];
  }

  test("registers exactly 4 resource templates with the expected URI patterns", async () => {
    const agent = await buildAgent();
    const templates = agent.server._registeredResourceTemplates;

    expect(Object.keys(templates).sort()).toEqual(["count", "fields", "record", "search"]);
    expect(templates.record.resourceTemplate.uriTemplate.toString()).toBe("odoo://{model}/record/{id}");
    expect(templates.search.resourceTemplate.uriTemplate.toString()).toBe("odoo://{model}/search");
    expect(templates.count.resourceTemplate.uriTemplate.toString()).toBe("odoo://{model}/count");
    expect(templates.fields.resourceTemplate.uriTemplate.toString()).toBe("odoo://{model}/fields");
  });

  test("resources/templates/list surfaces all 4 templates via the SDK's built-in listing", async () => {
    const agent = await buildAgent();
    const handler = agent.server.server._requestHandlers.get("resources/templates/list");
    expect(handler).toBeDefined();

    const result = await handler({ method: "resources/templates/list", params: {} }, {});
    const uris = result.resourceTemplates.map((t: any) => t.uriTemplate).sort();

    expect(uris).toEqual(
      ["odoo://{model}/count", "odoo://{model}/fields", "odoo://{model}/record/{id}", "odoo://{model}/search"].sort()
    );
  });

  describe("odoo://{model}/record/{id}", () => {
    test("fetches a record via searchRecords with an id domain filter", async () => {
      const agent = await buildAgent();
      let fetchCalls: { url: string; body: any }[] = [];
      const fetchMock = mock(async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        if (url.endsWith("/fields_get")) {
          return new Response(JSON.stringify({ result: { id: { type: "integer", store: true } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ result: [{ id: 42, name: "Task 42" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");
      const uri = new URL("odoo://project.task/record/42");
      const result = await template.readCallback(uri, { model: "project.task", id: "42" }, {});

      const searchReadCall = fetchCalls.find((c) => c.url.endsWith("/search_read"));
      expect(searchReadCall).toBeDefined();
      expect(searchReadCall?.body.domain).toEqual([["id", "=", 42]]);
      expect(searchReadCall?.body.limit).toBe(1);
      expect(result.contents[0].uri).toBe(uri.href);
      expect(result.contents[0].mimeType).toBe("application/json");
      expect(JSON.parse(result.contents[0].text)).toEqual({ id: 42, name: "Task 42" });
    });

    test("returns a JSON error envelope for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");
      const uri = new URL("odoo:///record/42");

      const result = await template.readCallback(uri, { model: "", id: "42" }, {});
      const envelope = JSON.parse(result.contents[0].text);

      expect(envelope.error).toBe("unknown");
      expect(envelope.details).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("returns a JSON error envelope for a non-positive/non-numeric id without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");

      for (const badId of ["0", "-1", "abc", ""]) {
        const result = await template.readCallback(
          new URL(`odoo://project.task/record/${badId || "x"}`),
          { model: "project.task", id: badId },
          {}
        );
        const envelope = JSON.parse(result.contents[0].text);
        expect(envelope.details).toContain("id must be a positive integer");
      }
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("returns a JSON error envelope when no record matches", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(async () => {
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");

      const result = await template.readCallback(new URL("odoo://project.task/record/999"), { model: "project.task", id: "999" }, {});
      const envelope = JSON.parse(result.contents[0].text);

      expect(envelope.details).toContain("No project.task record found for id 999");
    });

    test("does not leak the API key on error, and classifies 403 as permission_denied", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ error: { message: "Access Denied" } }), { status: 403 }))
      );
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");

      const result = await template.readCallback(new URL("odoo://project.task/record/1"), { model: "project.task", id: "1" }, {});
      const text = result.contents[0].text;
      const envelope = JSON.parse(text);

      expect(envelope).toEqual({
        error: "permission_denied",
        model: "project.task",
        method: "search_read",
        http_status: 403,
        details: "Access Denied",
        recoverable: false
      });
      expect(text).not.toContain("secret-resource-key");
      expect(text).not.toContain("Bearer");
    });
  });

  describe("odoo://{model}/search", () => {
    test("reuses searchRecords: passes domain/fields/limit parsed from query params", async () => {
      const agent = await buildAgent();
      let fetchCalls: { url: string; body: any }[] = [];
      const fetchMock = mock(async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ result: [{ id: 1 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "search");
      const uri = new URL("odoo://project.task/search");
      uri.searchParams.set("domain", JSON.stringify([["active", "=", true]]));
      uri.searchParams.set("fields", "id,name");
      uri.searchParams.set("limit", "5");

      const result = await template.readCallback(uri, { model: "project.task" }, {});

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toContain("/project.task/search_read");
      expect(fetchCalls[0].body).toEqual({
        domain: [["active", "=", true]],
        fields: ["id", "name"],
        limit: 5,
        offset: 0
      });
      expect(JSON.parse(result.contents[0].text)).toEqual([{ id: 1 }]);
    });

    test("defaults to domain=[], smart fields, limit=10 when no query params are given", async () => {
      const agent = await buildAgent();
      let fetchCalls: { url: string; body: any }[] = [];
      const fetchMock = mock(async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        if (url.endsWith("/fields_get")) {
          return new Response(JSON.stringify({ result: { id: { type: "integer", store: true } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "search");
      const uri = new URL("odoo://project.task/search");
      await template.readCallback(uri, { model: "project.task" }, {});

      const searchReadCall = fetchCalls.find((c) => c.url.endsWith("/search_read"));
      expect(searchReadCall?.body.domain).toEqual([]);
      expect(searchReadCall?.body.limit).toBe(10);
    });

    test("returns a JSON error envelope for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "search");

      const result = await template.readCallback(new URL("odoo:///search"), { model: "" }, {});
      const envelope = JSON.parse(result.contents[0].text);

      expect(envelope.error).toBe("unknown");
      expect(envelope.details).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("returns a JSON error envelope for a malformed domain query param", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "search");
      const uri = new URL("odoo://project.task/search");
      uri.searchParams.set("domain", "not-json");

      const result = await template.readCallback(uri, { model: "project.task" }, {});
      const envelope = JSON.parse(result.contents[0].text);

      expect(envelope.details).toContain("domain query param must be valid JSON array");
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });

  describe("odoo://{model}/count", () => {
    test("calls the countRecords helper (search_count), not client-side counting", async () => {
      const agent = await buildAgent();
      let fetchCalls: { url: string; body: any }[] = [];
      const fetchMock = mock(async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ result: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "count");
      const uri = new URL("odoo://project.task/count");
      uri.searchParams.set("domain", JSON.stringify([["active", "=", true]]));

      const result = await template.readCallback(uri, { model: "project.task" }, {});

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toContain("/project.task/search_count");
      expect(fetchCalls[0].body).toEqual({ domain: [["active", "=", true]] });
      expect(JSON.parse(result.contents[0].text)).toEqual({ count: 3 });
    });

    test("defaults to domain=[] when no query param is given", async () => {
      const agent = await buildAgent();
      let fetchCalls: { url: string; body: any }[] = [];
      const fetchMock = mock(async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ result: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "count");
      await template.readCallback(new URL("odoo://project.task/count"), { model: "project.task" }, {});

      expect(fetchCalls[0].body).toEqual({ domain: [] });
    });

    test("returns a JSON error envelope for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "count");

      const result = await template.readCallback(new URL("odoo:///count"), { model: "" }, {});
      const envelope = JSON.parse(result.contents[0].text);

      expect(envelope.error).toBe("unknown");
      expect(envelope.details).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });

  describe("odoo://{model}/fields", () => {
    test("calls fields_get with the full metadata attributes, matching the get_fields tool", async () => {
      const agent = await buildAgent();
      let fetchCalls: { url: string; body: any }[] = [];
      const fetchMock = mock(async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ result: { name: { type: "char", string: "Name" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "fields");
      const uri = new URL("odoo://project.task/fields");
      const result = await template.readCallback(uri, { model: "project.task" }, {});

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toContain("/project.task/fields_get");
      expect(fetchCalls[0].body).toEqual({
        attributes: ["type", "string", "readonly", "required", "store", "selection", "relation", "help", "searchable", "sortable"]
      });
      expect(fetchCalls[0].body.allfields).toBeUndefined();
      expect(JSON.parse(result.contents[0].text)).toEqual({ name: { type: "char", string: "Name" } });
    });

    test("returns a JSON error envelope for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "fields");

      const result = await template.readCallback(new URL("odoo:///fields"), { model: "" }, {});
      const envelope = JSON.parse(result.contents[0].text);

      expect(envelope.error).toBe("unknown");
      expect(envelope.details).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });

  test("no resource handler ever calls a write method (create/write/unlink)", async () => {
    const agent = await buildAgent();
    let calledMethods: string[] = [];
    const fetchMock = mock(async (url: string) => {
      calledMethods.push(url.split("/").pop() ?? "");
      return new Response(JSON.stringify({ result: url.includes("search_read") ? [{ id: 1 }] : url.includes("search_count") ? 1 : {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    globalThis.fetch = fetchMock;

    await getTemplate(agent, "record").readCallback(new URL("odoo://project.task/record/1"), { model: "project.task", id: "1" }, {});
    await getTemplate(agent, "search").readCallback(new URL("odoo://project.task/search"), { model: "project.task" }, {});
    await getTemplate(agent, "count").readCallback(new URL("odoo://project.task/count"), { model: "project.task" }, {});
    await getTemplate(agent, "fields").readCallback(new URL("odoo://project.task/fields"), { model: "project.task" }, {});

    expect(calledMethods.length).toBeGreaterThan(0);
    for (const method of calledMethods) {
      expect(["create", "write", "unlink"]).not.toContain(method);
    }
  });
});

describe("describe_database", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockOdoo(perModel: Record<string, unknown[] | Error>) {
    return mock(async (url: string) => {
      const model = Object.keys(perModel).find((m) => url.includes(`/json/2/${m}/search_read`));
      const outcome = model ? perModel[model] : undefined;
      if (outcome instanceof Error) {
        return new Response(JSON.stringify({ error: { message: outcome.message } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ result: outcome ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
  }

  test("default run returns all 5 sections with counts", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mockOdoo({
      "ir.module.module": [{ name: "sale", shortdesc: "Sales" }],
      "ir.model": [{ model: "x_custom", name: "Custom" }],
      "ir.model.fields": [{ model: "res.partner", name: "x_studio_foo", ttype: "char", field_description: "Foo" }],
      "ir.actions.server": [{ name: "Action", model_id: [1, "res.partner"], state: "code" }],
      "base.automation": [{ name: "Auto", trigger: "on_create", model_id: [1, "res.partner"], active: true }]
    });

    const handler = getToolHandler(agent, "describe_database");
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);

    expect(Object.keys(body).sort()).toEqual(
      ["automations", "custom_models", "modules", "server_actions", "studio_fields"].sort()
    );
    expect(body.modules.count).toBe(1);
    expect(body.automations.count).toBe(1);
    expect(result.isError).toBeUndefined();
  });

  test("include filters to a subset of sections", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mockOdoo({ "ir.module.module": [{ name: "sale", shortdesc: "Sales" }] });

    const handler = getToolHandler(agent, "describe_database");
    const result = await handler({ include: ["modules"] });
    const body = JSON.parse(result.content[0].text);

    expect(Object.keys(body)).toEqual(["modules"]);
    expect(body.modules.count).toBe(1);
  });

  test("one section erroring does not fail the others", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mockOdoo({
      "ir.module.module": [{ name: "sale", shortdesc: "Sales" }],
      "ir.model": [{ model: "x_custom", name: "Custom" }],
      "ir.model.fields": [],
      "ir.actions.server": [],
      "base.automation": new Error("Invalid model name 'base.automation'")
    });

    const handler = getToolHandler(agent, "describe_database");
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);

    expect(body.automations.error).toContain("base.automation");
    expect(body.automations.count).toBeUndefined();
    expect(body.modules.count).toBe(1);
    expect(body.custom_models.count).toBe(1);
    expect(result.isError).toBeUndefined();
  });
});

describe("expand_record", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const BASE_FIELDS_META = {
    id: { type: "integer", string: "ID" },
    name: { type: "char", string: "Name" }
  };

  /** Routes by `${model}/${method}` (matches the odoo.ts endpoint shape). Optionally logs {url, body} to `log`. */
  function mockOdoo(routes: Record<string, unknown>, log?: { url: string; body: any }[]) {
    return mock(async (url: string, init: any) => {
      const key = Object.keys(routes).find((k) => url.endsWith(`/json/2/${k}`));
      if (log) log.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const outcome = key ? routes[key] : undefined;
      if (outcome instanceof Error) {
        return new Response(JSON.stringify({ error: { message: outcome.message } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ result: outcome ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
  }

  test("default expansion (no relations) returns record, chatter, and attachments", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mockOdoo({
      "project.task/fields_get": BASE_FIELDS_META,
      "project.task/search_read": [{ id: 42, name: "Task A" }],
      "mail.message/search_read": [{ date: "2024-01-01", author_id: [7, "Alice"], body: "hi", message_type: "comment" }],
      "ir.attachment/search_read": [{ name: "file.pdf", mimetype: "application/pdf", file_size: 123, create_date: "2024-01-01" }]
    });

    const handler = getToolHandler(agent, "expand_record");
    const result = await handler({ model: "project.task", record_id: 42, relations: [], include_chatter: true, include_attachments: true, relation_limit: 10 });
    const body = JSON.parse(result.content[0].text);

    expect(body.relations).toEqual({});
    expect(body.chatter).toEqual([{ date: "2024-01-01", author_id: { id: 7, name: "Alice" }, body: "hi", message_type: "comment" }]);
    expect(body.attachments).toEqual([{ name: "file.pdf", mimetype: "application/pdf", file_size: 123, create_date: "2024-01-01" }]);
    expect(body.record).toEqual({ id: 42, name: "Task A" });
    expect(result.isError).toBeUndefined();
  });

  test("explicit relations expansion fetches the comodel and normalizes rows", async () => {
    const agent = await buildWriteToolAgent();
    const fieldsMeta = { ...BASE_FIELDS_META, tag_ids: { type: "many2many", string: "Tags", relation: "test.tag", store: true } };
    const log: { url: string; body: any }[] = [];
    globalThis.fetch = mockOdoo(
      {
        "project.task/fields_get": fieldsMeta,
        "project.task/search_read": [{ id: 42, name: "Task A", tag_ids: [1, 2] }],
        "test.tag/search_read": [
          { id: 1, display_name: "Urgent", state: "open" },
          { id: 2, display_name: "Low", state: "open" }
        ],
        "mail.message/search_read": [],
        "ir.attachment/search_read": []
      },
      log
    );

    const handler = getToolHandler(agent, "expand_record");
    const result = await handler({
      model: "project.task",
      record_id: 42,
      relations: ["tag_ids"],
      include_chatter: false,
      include_attachments: false,
      relation_limit: 10
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.relations.tag_ids).toEqual([
      { id: 1, display_name: "Urgent", state: "open" },
      { id: 2, display_name: "Low", state: "open" }
    ]);
    const tagCall = log.find((entry) => entry.url.endsWith("/test.tag/search_read"));
    expect(tagCall?.body.domain).toEqual([["id", "in", [1, 2]]]);
    expect(result.isError).toBeUndefined();
  });

  test("one section erroring (chatter) does not fail the whole call", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mockOdoo({
      "project.task/fields_get": BASE_FIELDS_META,
      "project.task/search_read": [{ id: 42, name: "Task A" }],
      "mail.message/search_read": new Error("Invalid model name 'mail.message'"),
      "ir.attachment/search_read": [{ name: "file.pdf", mimetype: "application/pdf", file_size: 123, create_date: "2024-01-01" }]
    });

    const handler = getToolHandler(agent, "expand_record");
    const result = await handler({ model: "project.task", record_id: 42, relations: [], include_chatter: true, include_attachments: true, relation_limit: 10 });
    const body = JSON.parse(result.content[0].text);

    expect(body.chatter.error).toContain("mail.message");
    expect(body.record).toEqual({ id: 42, name: "Task A" });
    expect(body.relations).toEqual({});
    expect(body.attachments.length).toBe(1);
    expect(result.isError).toBeUndefined();
  });

  test("caps at 8 Odoo calls per invocation, degrading remaining relation sections", async () => {
    const agent = await buildWriteToolAgent();

    const relFields: Record<string, unknown> = {};
    const recordRow: Record<string, unknown> = { id: 42, name: "Task A" };
    const routes: Record<string, unknown> = {
      "project.task/search_read": [recordRow],
      "mail.message/search_read": [],
      "ir.attachment/search_read": []
    };
    for (let i = 0; i < 8; i++) {
      const field = `rel${i}_ids`;
      const comodel = `rel.model.${i}`;
      relFields[field] = { type: "one2many", string: `Rel ${i}`, relation: comodel, store: true };
      recordRow[field] = [i + 1];
      routes[`${comodel}/search_read`] = [{ id: i + 1, display_name: `Item ${i}` }];
    }
    routes["project.task/fields_get"] = { ...BASE_FIELDS_META, ...relFields };
    globalThis.fetch = mockOdoo(routes);

    const handler = getToolHandler(agent, "expand_record");
    const result = await handler({
      model: "project.task",
      record_id: 42,
      relations: Object.keys(relFields),
      include_chatter: false,
      include_attachments: false,
      relation_limit: 10
    });
    const body = JSON.parse(result.content[0].text);

    expect(agent.odooQueue.getMetrics().odoo_calls).toBeLessThanOrEqual(8);
    const degraded = Object.values(body.relations).filter(
      (v: any) => v && v.error === "call budget exceeded (max 8 Odoo calls per invocation)"
    );
    expect(degraded.length).toBeGreaterThan(0);
    expect(result.isError).toBeUndefined();
  });
});

describe("OAuth shim (ChatGPT path)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Minimal in-memory KV faithful to the calls workers-oauth-provider makes. */
  function makeKV() {
    const store = new Map<string, string>();
    return {
      async get(key: string, opts?: any) {
        const value = store.get(key) ?? null;
        if (value === null) return null;
        const type = typeof opts === "string" ? opts : opts?.type;
        return type === "json" ? JSON.parse(value) : value;
      },
      async put(key: string, value: string, _opts?: any) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list(opts?: any) {
        const prefix = opts?.prefix ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true };
      },
      _store: store
    };
  }

  function makeCtx() {
    return { waitUntil: () => {}, passThroughOnException: () => {}, props: undefined } as any;
  }

  function makeEnv() {
    return { OAUTH_KV: makeKV() } as any;
  }

  async function pkcePair() {
    const verifier = "test-verifier-0123456789-0123456789-0123456789";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return { verifier, challenge };
  }

  const ORIGIN = "http://worker.example.com";
  const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

  async function registerClient(env: any) {
    const res = await handler.fetch(
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"]
        })
      }),
      env,
      makeCtx()
    );
    expect(res.status).toBe(201);
    return (await res.json()) as any;
  }

  async function getAuthorizeForm(env: any, clientId: string, challenge: string) {
    const authorizeUrl =
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=xyz-state&scope=odoo` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const res = await handler.fetch(new Request(authorizeUrl), env, makeCtx());
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/name="oauth_req" value="([^"]+)"/);
    expect(match).not.toBeNull();
    return { html, oauthReq: match![1] };
  }

  function odooValidationFetchMock() {
    return mock(async (url: string, init: any) => {
      if (String(url).includes("/res.users/fields_get")) {
        return new Response(JSON.stringify({ result: { login: { type: "char" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  async function submitAuthorizeForm(env: any, oauthReq: string, creds: Record<string, string>) {
    const body = new URLSearchParams({ oauth_req: oauthReq, ...creds });
    return handler.fetch(
      new Request(`${ORIGIN}/authorize`, { method: "POST", body }),
      env,
      makeCtx()
    );
  }

  test("serves OAuth discovery metadata with authorize/token/register endpoints", async () => {
    const env = makeEnv();
    const res = await handler.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      env,
      makeCtx()
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });

  test("full flow: register → authorize form → Odoo validation → code → token → /mcp props", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkcePair();
    const { client_id } = await registerClient(env);

    const { html, oauthReq } = await getAuthorizeForm(env, client_id, challenge);
    expect(html).toContain("ChatGPT");
    expect(html).toContain('name="odoo_url"');
    expect(html).toContain('name="odoo_db"');
    expect(html).toContain('name="odoo_api_key"');

    const fetchMock = odooValidationFetchMock();
    globalThis.fetch = fetchMock as any;

    const redirectRes = await submitAuthorizeForm(env, oauthReq, {
      odoo_url: "https://acme.odoo.com",
      odoo_db: "acme-prod",
      odoo_api_key: "shim-secret-key-example"
    });
    expect(redirectRes.status).toBe(302);
    const location = new URL(redirectRes.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz-state");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // The validation call hit Odoo with the submitted credentials.
    const validationCall = fetchMock.mock.calls[0] as any;
    expect(String(validationCall[0])).toBe("https://acme.odoo.com/json/2/res.users/fields_get");
    expect(validationCall[1].headers.Authorization).toBe("Bearer shim-secret-key-example");
    expect(validationCall[1].headers["X-Odoo-Database"]).toBe("acme-prod");

    globalThis.fetch = originalFetch;

    const tokenRes = await handler.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: REDIRECT_URI,
          client_id,
          code_verifier: verifier
        })
      }),
      env,
      makeCtx()
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as any;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBe(3600);

    // A token-authenticated /mcp request resolves back to the stored Odoo
    // credentials as the exact same Props shape the header path builds.
    const mcpRes = await handler.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      }),
      env,
      makeCtx()
    );
    expect(mcpRes.status).toBe(200);
    const echoed = (await mcpRes.json()) as any;
    expect(echoed.props).toEqual({
      odooBaseUrl: "https://acme.odoo.com",
      odooDb: "acme-prod",
      odooApiKey: "shim-secret-key-example",
      clientName: "ChatGPT"
    });

    // Refresh grant issues a fresh usable access token.
    const refreshRes = await handler.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id
        })
      }),
      env,
      makeCtx()
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as any;
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });

  test("stored grant data in KV never contains the plaintext Odoo API key", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkcePair();
    const { client_id } = await registerClient(env);
    const { oauthReq } = await getAuthorizeForm(env, client_id, challenge);

    globalThis.fetch = odooValidationFetchMock() as any;
    const redirectRes = await submitAuthorizeForm(env, oauthReq, {
      odoo_url: "https://acme.odoo.com",
      odoo_db: "acme-prod",
      odoo_api_key: "plaintext-should-never-persist-987"
    });
    expect(redirectRes.status).toBe(302);
    globalThis.fetch = originalFetch;

    for (const [key, value] of (env.OAUTH_KV as any)._store.entries()) {
      expect(`${key}=${value}`).not.toContain("plaintext-should-never-persist-987");
    }
  });

  test("rejects the flow when Odoo refuses the credentials, without echoing the key", async () => {
    const env = makeEnv();
    const { challenge } = await pkcePair();
    const { client_id } = await registerClient(env);
    const { oauthReq } = await getAuthorizeForm(env, client_id, challenge);

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid apikey" } }), { status: 401 })
    ) as any;

    const res = await submitAuthorizeForm(env, oauthReq, {
      odoo_url: "https://acme.odoo.com",
      odoo_db: "acme-prod",
      odoo_api_key: "bad-secret-key-13371337"
    });
    const html = await res.text();

    expect(res.status).toBe(400);
    expect(html).toContain("rejected these credentials");
    expect(html).not.toContain("bad-secret-key-13371337");
    // Re-renders the form so the user can retry without restarting the flow.
    expect(html).toContain('name="oauth_req"');
  });

  test("rejects a non-http(s) Odoo URL without calling Odoo", async () => {
    const env = makeEnv();
    const { challenge } = await pkcePair();
    const { client_id } = await registerClient(env);
    const { oauthReq } = await getAuthorizeForm(env, client_id, challenge);

    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock as any;

    const res = await submitAuthorizeForm(env, oauthReq, {
      odoo_url: "ftp://acme.odoo.com",
      odoo_db: "acme-prod",
      odoo_api_key: "some-key"
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("valid http(s) URL");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("tampered oauth_req is rejected", async () => {
    const env = makeEnv();
    const res = await submitAuthorizeForm(env, "not-valid-base64-json", {
      odoo_url: "https://acme.odoo.com",
      odoo_db: "acme-prod",
      odoo_api_key: "some-key"
    });
    expect(res.status).toBe(400);
  });

  test("GET /mcp is declined with 405 on both auth paths (no standalone SSE stream)", async () => {
    const env = makeEnv();
    const viaToken = await handler.fetch(
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: "Bearer some-token" } }),
      env,
      makeCtx()
    );
    expect(viaToken.status).toBe(405);
    expect(viaToken.headers.get("Allow")).toBe("POST, DELETE");

    const viaHeaders = await handler.fetch(
      new Request(`${ORIGIN}/mcp`, {
        headers: {
          Authorization: "Bearer raw-key",
          "X-Odoo-Url": "https://acme.odoo.com",
          "X-Odoo-Db": "acme-prod"
        }
      }),
      {} as any,
      makeCtx()
    );
    expect(viaHeaders.status).toBe(405);
  });

  test("/mcp with an invalid bearer token and no X-Odoo headers returns 401", async () => {
    const env = makeEnv();
    const res = await handler.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer garbage-token" }
      }),
      env,
      makeCtx()
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("garbage-token");
  });

  test("/mcp with X-Odoo headers stays on the raw header path and never touches the OAuth provider", async () => {
    // env deliberately has no OAUTH_KV: the header path must not need it.
    const res = await handler.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer raw-header-key",
          "X-Odoo-Url": "https://acme.odoo.com",
          "X-Odoo-Db": "acme-prod"
        }
      }),
      {} as any,
      makeCtx()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.props.odooApiKey).toBe("raw-header-key");
  });
});

describe("call_model_method JSON-2 body contract", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("body contains only kwargs (+ ids) — never an 'args' key", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "call_model_method");
    const result = await handler({
      model: "ir.attachment",
      method: "read",
      ids: [7, 8],
      kwargs: { fields: ["name", "mimetype"] },
      args: []
    });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/ir.attachment/read");
    // JSON-2 binds every body key as a named kwarg: an injected args:[] would 422
    // on any method without an 'args' parameter (verified live on saas-19.2).
    expect(fetchCalls[0].body).toEqual({ fields: ["name", "mimetype"], ids: [7, 8] });
    expect("args" in fetchCalls[0].body).toBe(false);
  });

  test("omits ids from the body when not provided", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { body: any }[] = [];
    globalThis.fetch = mock(async (_url: string, init: any) => {
      fetchCalls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "call_model_method");
    await handler({ model: "res.partner", method: "search_read", kwargs: { domain: [], limit: 1 }, args: [] });

    expect(fetchCalls[0].body).toEqual({ domain: [], limit: 1 });
    expect("ids" in fetchCalls[0].body).toBe(false);
  });

  test("explicit ids wins over an ids key inside kwargs", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { body: any }[] = [];
    globalThis.fetch = mock(async (_url: string, init: any) => {
      fetchCalls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "call_model_method");
    await handler({ model: "project.task", method: "write", ids: [5], kwargs: { ids: [999], vals: { name: "x" } }, args: [] });

    expect(fetchCalls[0].body).toEqual({ ids: [5], vals: { name: "x" } });
  });

  test("non-empty positional args fail loudly without calling Odoo", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "call_model_method");
    const result = await handler({ model: "res.partner", method: "read", args: [[1, 2]], kwargs: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no positional args");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe("batch_read tool", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("issues a single search_read with an `id in` domain and returns the rows as JSON", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    const rows = [
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" }
    ];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "batch_read");
    // Explicit fields => searchRecords skips fields_get, so exactly one search_read call.
    const result = await handler({ model: "res.partner", ids: [1, 2], fields: ["id", "name"] });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/res.partner/search_read");
    expect(fetchCalls[0].body.domain).toEqual([["id", "in", [1, 2]]]);
    expect(fetchCalls[0].body.fields).toEqual(["id", "name"]);
    expect(fetchCalls[0].body.limit).toBe(2);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(rows);
  });

  test("caps the search_read limit at 100 even for more than 100 ids", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const handler = getToolHandler(agent, "batch_read");
    await handler({ model: "res.partner", ids, fields: ["id"] });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.limit).toBe(100);
  });

  test("rejects empty-string model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "batch_read");
    const result = await handler({ model: "  ", ids: [1], fields: ["id"] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("surfaces isError with the error detail when the queue call fails", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Boom-read" } }), { status: 400 }))
    );

    const handler = getToolHandler(agent, "batch_read");
    const result = await handler({ model: "res.partner", ids: [1], fields: ["id"] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Boom-read");
    expect(result.content[0].text).toContain("invalid_request");
  });
});

describe("batch_update tool", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("issues one write per entry with { ids:[id], vals } and returns per-record ok results", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "batch_update");
    const result = await handler({
      model: "project.task",
      updates: [
        { record_id: 1, values: { name: "One" } },
        { record_id: 2, values: { name: "Two" } }
      ]
    });

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0].url).toContain("/project.task/write");
    expect(fetchCalls[0].body).toEqual({ ids: [1], vals: { name: "One" } });
    expect(fetchCalls[1].body).toEqual({ ids: [2], vals: { name: "Two" } });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([
      { record_id: 1, ok: true },
      { record_id: 2, ok: true }
    ]);
  });

  test("rejects empty-string model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "batch_update");
    const result = await handler({ model: "   ", updates: [{ record_id: 1, values: { name: "x" } }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("fail-fast: a mid-loop error aborts remaining writes and returns isError", async () => {
    const agent = await buildWriteToolAgent();
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ result: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "Boom-write" } }), { status: 400 }));
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "batch_update");
    const result = await handler({
      model: "project.task",
      updates: [
        { record_id: 1, values: { name: "One" } },
        { record_id: 2, values: { name: "Two" } },
        { record_id: 3, values: { name: "Three" } }
      ]
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Boom-write");
    // Aborts after the failing second write — the third is never attempted.
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe("batch_post_message tool", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("HTML-escapes bodies by default and posts message_type comment per record", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 99 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "batch_post_message");
    const result = await handler({
      model: "project.task",
      messages: [{ record_id: 1, body: "<b>hi</b>", body_is_html: false }]
    });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/project.task/message_post");
    expect(fetchCalls[0].body).toEqual({
      ids: [1],
      body: "&lt;b&gt;hi&lt;/b&gt;",
      body_is_html: true,
      message_type: "comment"
    });
    expect(fetchCalls[0].body.subtype_xmlid).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([{ record_id: 1, result: 99 }]);
  });

  test("body_is_html true passes the body verbatim and subtype maps to subtype_xmlid", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "batch_post_message");
    await handler({
      model: "project.task",
      messages: [
        { record_id: 7, body: "<p>already <b>HTML</b></p>", body_is_html: true, subtype: "mail.mt_note" }
      ]
    });

    expect(fetchCalls[0].body).toEqual({
      ids: [7],
      body: "<p>already <b>HTML</b></p>",
      body_is_html: true,
      message_type: "comment",
      subtype_xmlid: "mail.mt_note"
    });
  });

  test("posts to each record in order (per-record looping)", async () => {
    const agent = await buildWriteToolAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: fetchCalls.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const handler = getToolHandler(agent, "batch_post_message");
    const result = await handler({
      model: "project.task",
      messages: [
        { record_id: 1, body: "one", body_is_html: false },
        { record_id: 2, body: "two", body_is_html: false }
      ]
    });

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0].body.ids).toEqual([1]);
    expect(fetchCalls[1].body.ids).toEqual([2]);
    expect(JSON.parse(result.content[0].text)).toEqual([
      { record_id: 1, result: 1 },
      { record_id: 2, result: 2 }
    ]);
  });

  test("rejects empty-string model without calling fetch", async () => {
    const agent = await buildWriteToolAgent();
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "batch_post_message");
    const result = await handler({ model: "", messages: [{ record_id: 1, body: "hi", body_is_html: false }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model must be a non-empty string");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("surfaces isError with the error detail when a post fails", async () => {
    const agent = await buildWriteToolAgent();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Boom-post" } }), { status: 400 }))
    );

    const handler = getToolHandler(agent, "batch_post_message");
    const result = await handler({
      model: "project.task",
      messages: [{ record_id: 1, body: "hi", body_is_html: false }]
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Boom-post");
  });
});
