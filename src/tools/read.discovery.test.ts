import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import { callOdoo } from "../odoo";
import { OdooQueue } from "../odoo-queue";
import { registerReadTools } from "./read";
import { validatedToolHandler } from "./structured-test-util";

const originalFetch = globalThis.fetch;
const props = { odooBaseUrl: "https://odoo.example.com", odooDb: "db", odooApiKey: "secret" };

function serverFor(caller: typeof callOdoo) {
  const server = new McpServer({ name: "test", version: "1" });
  registerReadTools(server, () => props, new OdooQueue(caller), new TtlCache());
  return server;
}

describe("dynamic Odoo API discovery", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses authenticated doc-bearer model and method metadata", async () => {
    globalThis.fetch = mock(async (request: Request | URL | string) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      if (url.endsWith("/doc-bearer/index.json")) {
        return Response.json({
          modules: ["base"],
          models: [
            { model: "res.partner", name: "Contact", doc: "People", fields: { id: {}, name: {} }, methods: ["search", "write"] },
            { model: "sale.order", name: "Sales Order", doc: "Sales", fields: { id: {} }, methods: ["action_confirm"] }
          ]
        });
      }
      return Response.json({
        model: "res.partner",
        name: "Contact",
        doc: "People and companies",
        fields: { name: { name: "name", type: "char", readonly: false } },
        methods: {
          search: {
            signature: "(domain, offset=0, limit=None, order=None) -> list[int]",
            parameters: { domain: { annotation: "DomainType" } },
            doc: "Search records"
          }
        }
      });
    });
    const caller = (async (_conn, _model, method) => (method === "get_views" ? { views: { form: { arch: '<button type="object" name="action_archive" string="Archive"/>' } } } : [])) as typeof callOdoo;
    const server = serverFor(caller);

    const discover = await validatedToolHandler(server, "discover_models")({ query: "partner", limit: 10, offset: 0 });
    expect(discover.structuredContent).toMatchObject({
      source: "doc_bearer",
      models: [{ model: "res.partner", name: "Contact", field_count: 2, method_count: 2 }]
    });

    const describe = await validatedToolHandler(server, "describe_model_api")({ model: "res.partner" });
    expect(describe.structuredContent).toMatchObject({
      source: "doc_bearer",
      model: "res.partner",
      methods: { search: { signature: expect.stringContaining("domain") } },
      actions: [{ method: "action_archive", source: "view" }]
    });
  });

  test("falls back honestly when API documentation is unavailable", async () => {
    globalThis.fetch = mock(async () => new Response("denied", { status: 403 }));
    const caller = (async (_conn, model, method) => {
      if (model === "ir.model" && method === "search_read") return [{ model: "x_custom", name: "Custom" }];
      if (model === "ir.model" && method === "search_count") return 1;
      if (method === "fields_get") return { name: { type: "char", string: "Name" } };
      if (method === "get_views") return { views: { form: { arch: '<button type="object" name="do_work"/>' } } };
      throw new Error("unexpected call");
    }) as typeof callOdoo;
    const server = serverFor(caller);

    const discover = await validatedToolHandler(server, "discover_models")({ query: "custom", limit: 10, offset: 0 });
    expect(discover.structuredContent).toMatchObject({ source: "ir_model", models: [{ model: "x_custom" }] });

    const describe = await validatedToolHandler(server, "describe_model_api")({ model: "x_custom" });
    expect(describe.structuredContent).toMatchObject({
      source: "orm_fallback",
      methods: { do_work: { signature: null, source: "view" } }
    });
  });
});
