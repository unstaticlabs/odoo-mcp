import { mock, describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";

mock.module("agents/mcp", () => {
  return {
    McpAgent: class McpAgentBase {}
  };
});
mock.module("agents", () => {
  return {};
});

const { callOdoo, pickSmartFields, searchRecords } = await import("./index");

const originalFetch = globalThis.fetch;

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

    await searchRecords(conn, "test.model", [], null, 10);

    expect(fetchCalls.length).toBe(2);
    // First call should be fields_get
    expect(fetchCalls[0].url).toContain("/fields_get");
    expect(fetchCalls[0].body).toEqual({ attributes: ["type", "store"] });
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

    await searchRecords(conn, "test.model", [], ["__all__"], 10);

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

    await searchRecords(conn, "test.model", [], ["id", "name"], 10);

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

    await searchRecords(conn, "test.model", [], null, 10);

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0].url).toContain("/fields_get");
    expect(fetchCalls[1].url).toContain("/search_read");
    expect(fetchCalls[1].body.fields).toEqual(["id", "display_name"]);
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

describe("search_records limit zod schema", () => {
  const schema = z.object({
    model: z.string(),
    domain: z.array(z.any()).default([]),
    fields: z.array(z.string()).nullable().default(null),
    limit: z.number().int().min(1).max(100).default(10)
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
});
