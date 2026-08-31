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
    }, {
      kind: "mutation",
      reconciliation: {
        suggestedTool: "odoo_read_records",
        targetModel: "project.task",
        knownIds: [1],
        fields: ["name"],
        instructions: "Read task 1 and compare its name before deciding whether to retry."
      }
    });
    await expect(call).rejects.toMatchObject<Partial<OdooError>>({
      code: "odoo_server_error",
      mutationOutcome: "unknown"
    });
    expect(calls).toBe(1);
  });

  it("preserves successful mutation evidence when result validation fails", async () => {
    const fetcher = async (): Promise<Response> => Response.json({ id: 91 });
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    const receipt = await client.call<{ id: number }>(requestContext(), "stock.picking", "create", {
      vals_list: [{}]
    }, {
      kind: "mutation",
      reconciliation: {
        suggestedTool: "odoo_read_records",
        targetModel: "stock.picking",
        instructions: "Read the returned picking before creating another receipt."
      }
    });

    await expect(receipt.finalize(() => {
      throw new Error("invalid projected result");
    }, (result) => ({ knownIds: [result.id] }))).rejects.toMatchObject<Partial<OdooError>>({
      mutationOutcome: "unknown",
      mutationStage: "response_processing",
      known: {
        requestSent: "yes",
        responseReceived: "yes",
        resultReceived: "yes",
        targetModel: "stock.picking",
        knownIds: [91]
      }
    });
  });

  it("bounds successful API discovery identities and never caches failures", async () => {
    let calls = 0;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++;
      return new Headers(init?.headers).get("Authorization") === "Bearer rejected"
        ? new Response("no", { status: 401 })
        : Response.json({ modules: ["base"] });
    };
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    const context = requestContext();
    for (let index = 0; index < 1_000; index++) {
      await expect(client.fetchApiDocument({
        ...context,
        principal: { ...context.principal, apiKey: "rejected", database: `bad-${index}` }
      })).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect((client as unknown as { apiDocumentCache: Map<string, unknown> }).apiDocumentCache.size).toBe(0);

    for (let index = 0; index < 60; index++) {
      await client.fetchApiDocument({
        ...context,
        principal: { ...context.principal, apiKey: `key-${index}` }
      });
    }
    expect((client as unknown as { apiDocumentCache: Map<string, unknown> }).apiDocumentCache.size).toBe(50);
    expect(calls).toBe(1_060);
  });

  it("discovers installed modules and published methods from the API document", async () => {
    const client = new OdooClient(8, 1024, (async () => Response.json({
      modules: ["base", "usl_documents"],
      models: [{ model: "usl.document", methods: ["mcp_get", "mcp_create_download_grant"] }]
    })) as typeof fetch);
    const surface = await client.discoverSurface(requestContext());
    expect(surface?.modules).toEqual(new Set(["base", "usl_documents"]));
    expect(surface?.publicMethods.get("usl.document")).toEqual(
      new Set(["mcp_get", "mcp_create_download_grant"])
    );
  });

  it("keeps the HTTP status when an error response is not JSON", async () => {
    const fetcher = async (): Promise<Response> => new Response("<html>Not Found</html>", { status: 404 });
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    await expect(client.call(requestContext(), "usl.document.link", "search_read", { domain: [] }))
      .rejects.toMatchObject<Partial<OdooError>>({
        code: "model_or_method_not_found",
        httpStatus: 404
      });
  });

  it("retries a read when a transient error page is not JSON", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls++;
      return calls === 1
        ? new Response("<html>502 Bad Gateway</html>", { status: 502 })
        : new Response(JSON.stringify([{ id: 7 }]), { status: 200 });
    };
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    const result = await client.call(requestContext(), "res.partner", "search_read", { domain: [] });
    expect(result).toEqual([{ id: 7 }]);
    expect(calls).toBe(2);
  });

  it("reports invalid JSON only when the response succeeded", async () => {
    const fetcher = async (): Promise<Response> => new Response("<html>surprise</html>", { status: 200 });
    const client = new OdooClient(8, 1024, fetcher as typeof fetch);
    await expect(client.call(requestContext(), "res.partner", "search_read", { domain: [] }))
      .rejects.toMatchObject<Partial<OdooError>>({
        code: "odoo_server_error",
        message: "Odoo returned invalid JSON"
      });
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
