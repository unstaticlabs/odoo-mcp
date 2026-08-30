import { describe, expect, it } from "vitest";
import { OdooClient, OdooError } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

describe("JSON-2 adapter", () => {
  it("retries transient reads and sends bearer/database attribution", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init });
      return requests.length === 1
        ? new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 })
        : new Response(JSON.stringify([{ id: 7, name: "USL" }]), { status: 200 });
    };
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    const result = await client.call(requestContext(), "res.partner", "search_read", {
      domain: [],
      fields: ["name"]
    });
    expect(result).toEqual([{ id: 7, name: "USL" }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("http://odoo:8069/json/2/res.partner/search_read");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(new Headers(requests[0]?.init?.headers).get("X-Odoo-Database")).toBe("test");
  });

  it("never replays a mutation after an ambiguous server failure", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls++;
      return new Response("gateway failure", { status: 503 });
    };
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    const call = client.call(requestContext(), "project.task", "write", {
      ids: [1],
      vals: { name: "Changed" }
    }, { kind: "mutation" });
    await expect(call).rejects.toMatchObject<Partial<OdooError>>({
      code: "odoo_server_error",
      mutationOutcome: "unknown"
    });
    expect(calls).toBe(1);
  });

  it("rejects oversized responses before parsing them", async () => {
    const fetcher = async (): Promise<Response> => new Response("x".repeat(100), {
      status: 200,
      headers: { "Content-Length": "100" }
    });
    const client = new OdooClient(8, 50, fetcher as typeof fetch);
    await expect(client.call(requestContext(), "res.partner", "search", { domain: [] })).rejects.toMatchObject({
      code: "payload_too_large"
    });
  });
});
