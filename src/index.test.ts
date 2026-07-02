import { mock, describe, test, expect, afterEach } from "bun:test";

mock.module("agents/mcp", () => {
  return {
    McpAgent: class McpAgentBase {}
  };
});
mock.module("agents", () => {
  return {};
});

// Import after mocking to avoid loading cloudflare/email module
const { callOdoo } = await import("./index");

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
