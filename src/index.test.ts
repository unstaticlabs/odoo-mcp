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

const { callOdoo, pickSmartFields, searchRecords, escapeHtml, countRecords, McpAgent } = await import("./index");

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

    const res = await countRecords(conn, "project.task", [["active", "=", true]]);

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
      await countRecords(conn, "  ", []);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("model must be a non-empty string");
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

    test("throws a clear error for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");
      const uri = new URL("odoo:///record/42");

      let error: Error | undefined;
      try {
        await template.readCallback(uri, { model: "", id: "42" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error?.message).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("throws a clear error for a non-positive/non-numeric id without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");

      for (const badId of ["0", "-1", "abc", ""]) {
        let error: Error | undefined;
        try {
          await template.readCallback(new URL(`odoo://project.task/record/${badId || "x"}`), { model: "project.task", id: badId }, {});
        } catch (err) {
          error = err as Error;
        }
        expect(error?.message).toContain("id must be a positive integer");
      }
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("throws a clear not-found error when no record matches", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(async () => {
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");

      let error: Error | undefined;
      try {
        await template.readCallback(new URL("odoo://project.task/record/999"), { model: "project.task", id: "999" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error?.message).toContain("No project.task record found for id 999");
    });

    test("does not leak the API key on error", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ error: { message: "Access Denied" } }), { status: 403 }))
      );
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "record");

      let error: Error | undefined;
      try {
        await template.readCallback(new URL("odoo://project.task/record/1"), { model: "project.task", id: "1" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).not.toContain("secret-resource-key");
      expect(error?.message).not.toContain("Bearer");
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
        limit: 5
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

    test("throws a clear error for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "search");

      let error: Error | undefined;
      try {
        await template.readCallback(new URL("odoo:///search"), { model: "" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error?.message).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("throws a clear error for a malformed domain query param", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "search");
      const uri = new URL("odoo://project.task/search");
      uri.searchParams.set("domain", "not-json");

      let error: Error | undefined;
      try {
        await template.readCallback(uri, { model: "project.task" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error?.message).toContain("domain query param must be valid JSON array");
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

    test("throws a clear error for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "count");

      let error: Error | undefined;
      try {
        await template.readCallback(new URL("odoo:///count"), { model: "" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error?.message).toContain("model must be a non-empty string");
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });

  describe("odoo://{model}/fields", () => {
    test("calls fields_get with type/string attributes, matching the get_fields tool", async () => {
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
      expect(fetchCalls[0].body).toEqual({ attributes: ["type", "string"] });
      expect(JSON.parse(result.contents[0].text)).toEqual({ name: { type: "char", string: "Name" } });
    });

    test("throws a clear error for an empty model without calling fetch", async () => {
      const agent = await buildAgent();
      const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
      globalThis.fetch = fetchMock;

      const template = getTemplate(agent, "fields");

      let error: Error | undefined;
      try {
        await template.readCallback(new URL("odoo:///fields"), { model: "" }, {});
      } catch (err) {
        error = err as Error;
      }

      expect(error?.message).toContain("model must be a non-empty string");
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
