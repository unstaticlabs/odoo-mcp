import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connected(fetcher: typeof fetch) {
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher))
    .createServer(requestContext());
  const client = new Client({ name: "orm-substrate-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function jsonCalls(fetcher: ReturnType<typeof vi.fn>, suffix = "") {
  return fetcher.mock.calls.filter(([url]) =>
    String(url).includes("/json/2/") && String(url).endsWith(suffix));
}

/** A `/doc-bearer` model document carrying Odoo's own `api` classification. */
function modelDocument(methods: Record<string, { api?: string[] }>, fields: Record<string, unknown> = {}) {
  return Response.json({ name: "Model", doc: "", fields, methods });
}

describe("public-method execution contract", () => {
  it("executes a method Odoo classifies as readonly under the read contract", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/doc-bearer/")) {
        return modelDocument({ web_search_read: { api: ["model", "readonly"] } });
      }
      attempts += 1;
      // A read may be retried; the first attempt fails with a retryable status.
      if (attempts === 1) return new Response("", { status: 503 });
      return Response.json({ length: 1, records: [{ id: 4, display_name: "ADA" }] });
    });
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_call_method",
      arguments: {
        model: "res.partner",
        method: "web_search_read",
        kwargs: { domain: [], specification: { display_name: {} }, limit: 1 }
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        result: { length: 1 },
        execution: { outcome: "succeeded", mode: "read" }
      }
    });
    // The retry is the point: a read that Odoo says cannot commit is not held to
    // the one-attempt mutation contract.
    expect(jsonCalls(fetcher, "/res.partner/web_search_read")).toHaveLength(2);
  });

  it("keeps the one-attempt mutation contract for a method Odoo does not classify as readonly", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/doc-bearer/")) {
        return modelDocument({ action_post: { api: ["model"] } });
      }
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    });
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_call_method",
      arguments: { model: "account.move", method: "action_post", ids: [12] }
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
      error: { outcome: "unknown", retry_guidance: "reconcile_first" }
    });
    expect(jsonCalls(fetcher, "/account.move/action_post")).toHaveLength(1);
  });

  it("assumes a mutation when the documentation does not classify the method", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/doc-bearer/")) return new Response("", { status: 404 });
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    });
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_call_method",
      arguments: { model: "account.move", method: "undocumented_action", ids: [12] }
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
      error: { outcome: "unknown" }
    });
    expect(jsonCalls(fetcher, "/account.move/undocumented_action")).toHaveLength(1);
  });
});

describe("model description projection", () => {
  const wideDocument = () => modelDocument(
    Object.fromEntries(Array.from({ length: 90 }, (_, index) => [
      `method_${String(index).padStart(2, "0")}`,
      { api: ["model"], signature: "()", doc: "x".repeat(2000) }
    ])),
    Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
      `field_${String(index).padStart(3, "0")}`,
      {
        type: "char",
        string: `Field ${index}`,
        required: false,
        // Attributes a caller cannot act on, which dominate the raw payload.
        depends: ["a", "b"],
        change_default: false,
        exportable: true,
        domain: "[('company_id', '=', company_id)]"
      }
    ]))
  );

  it("caps and projects the payload, and says what it withheld", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => wideDocument());
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_describe_model",
      arguments: { model: "account.move" }
    });

    const data = (result.structuredContent as { data: Record<string, any> }).data;
    expect(data.fields_page).toMatchObject({ total: 200, returned: 60, has_more: true, detail: "summary" });
    expect(data.methods_page).toMatchObject({ total: 90, returned: 60, has_more: true });
    expect(Object.keys(data.fields)).toHaveLength(60);
    expect(data.fields.field_000).toEqual({ type: "char", string: "Field 0", required: false });
    expect(data.fields.field_000).not.toHaveProperty("depends");
    expect(data.methods.method_00).toEqual({ api: ["model"], signature: "()" });
    expect((result.structuredContent as { warnings: string[] }).warnings.join(" "))
      .toContain("before concluding something is absent");
  });

  it("returns complete metadata for explicitly named fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => wideDocument());
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_describe_model",
      arguments: { model: "account.move", field_names: ["field_001", "absent_field"], detail: "full" }
    });

    const structured = result.structuredContent as { data: Record<string, any>; warnings: string[] };
    expect(Object.keys(structured.data.fields)).toEqual(["field_001"]);
    expect(structured.data.fields.field_001).toHaveProperty("depends");
    expect(structured.data.fields_page).toMatchObject({ total: 200, returned: 1, has_more: false });
    expect(structured.warnings.join(" ")).toContain("absent_field is not documented");
  });

  it("filters by substring", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => wideDocument());
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_describe_model",
      arguments: { model: "account.move", filter: "field_01", include_methods: false }
    });

    const data = (result.structuredContent as { data: Record<string, any> }).data;
    expect(Object.keys(data.fields)).toHaveLength(10);
    expect(data.fields_page).toMatchObject({ total: 200, returned: 10, has_more: false });
    expect(data.methods_page).toMatchObject({ total: 0, returned: 0 });
  });
});

describe("generic read tools", () => {
  it("rejects a malformed domain without calling Odoo", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", domain: ["|", ["is_company", "=", true]] }
    });

    expect(result.isError).toBe(true);
    expect(jsonCalls(fetcher)).toHaveLength(0);
  });

  it("sends named company scope as allowed_company_ids", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const client = await connected(fetcher);

    await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", company_ids: [2], active_test: false, lang: "fr_FR" }
    });

    const [call] = jsonCalls(fetcher, "/res.partner/search_read");
    expect(JSON.parse(String(call?.[1]?.body)).context).toMatchObject({
      allowed_company_ids: [2],
      active_test: false,
      lang: "fr_FR"
    });
  });
});
