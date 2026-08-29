import { describe, expect, mock, test } from "bun:test";
import { callOdoo, OdooError } from "./odoo";

const connection = {
  url: "https://odoo.example.com",
  db: "production",
  apiKey: "secret-api-key"
};

describe("Odoo transport boundary", () => {
  test("rejects an oversized request before credentials reach fetch", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ result: true })));

    await expect(
      callOdoo(connection, "res.partner", "create", { vals_list: [{ name: "too large" }] }, {
        fetcher: fetcher as typeof fetch,
        maxAttempts: 1,
        maxRequestBytes: 8
      })
    ).rejects.toMatchObject({
      code: "payload_too_large",
      mutationOutcome: "not_applied"
    } satisfies Partial<OdooError>);

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("bounds a streamed response even without Content-Length", async () => {
    const fetcher = mock(async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"result":"'));
          controller.enqueue(new TextEncoder().encode("too-large"));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    await expect(
      callOdoo(connection, "res.partner", "search_read", {}, {
        fetcher: fetcher as typeof fetch,
        maxAttempts: 1,
        maxResponseBytes: 12
      })
    ).rejects.toMatchObject({
      code: "payload_too_large",
      mutationOutcome: "unknown"
    } satisfies Partial<OdooError>);
  });

  test("classifies an interrupted response stream as an ambiguous network failure", async () => {
    const fetcher = mock(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"result":'));
            controller.error(new Error("connection reset"));
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      callOdoo(connection, "account.move", "action_post", { ids: [1] }, {
        fetcher: fetcher as typeof fetch,
        maxAttempts: 1
      })
    ).rejects.toMatchObject({
      code: "network_error",
      mutationOutcome: "unknown"
    } satisfies Partial<OdooError>);
  });

  test("does not follow a redirect for a credential-bearing JSON-2 request", async () => {
    const fetcher = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/collect" }
      });
    });

    await expect(
      callOdoo(connection, "res.partner", "search_read", {}, {
        fetcher: fetcher as typeof fetch,
        maxAttempts: 1
      })
    ).rejects.toMatchObject({
      code: "invalid_request",
      httpStatus: 302,
      mutationOutcome: "unknown"
    } satisfies Partial<OdooError>);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
