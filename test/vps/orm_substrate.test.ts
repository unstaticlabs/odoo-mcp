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

describe("Odoo read specifications", () => {
  it("reads nested relations in one web_search_read call and pages by keyset", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/res.partner/web_search_read")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        // limit+1 rows signal another page; `length` is what Odoo counted.
        return Response.json({ length: 3, records: [
          { id: 10, display_name: "A", country_id: { id: 1, display_name: "FR" }, child_ids: [] },
          { id: 11, display_name: "B", country_id: false, child_ids: [{ id: 30, display_name: "B1" }] },
          { id: 12, display_name: "C", country_id: false, child_ids: [] }
        ] });
      }
      return Response.json(0);
    });
    const client = await connected(fetcher);
    const specification = {
      display_name: {},
      country_id: { fields: { display_name: {} } },
      child_ids: { fields: { display_name: {} }, limit: 5 }
    };

    const first = await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", domain: [["is_company", "=", true]], specification, limit: 2, include_count: true }
    });
    expect(first.isError).not.toBe(true);
    const firstData = (first.structuredContent as { data: any }).data;
    expect(firstData.records).toHaveLength(2);
    expect(firstData.records[0].country_id).toEqual({ id: 1, display_name: "FR" });
    expect(firstData.records[1].child_ids).toEqual([{ id: 30, display_name: "B1" }]);
    expect(firstData.page).toMatchObject({ returned: 2, has_more: true, total: 3 });
    expect(bodies[0]).toMatchObject({ domain: [["is_company", "=", true]], specification, limit: 3, offset: 0, order: "id asc" });
    // An exact total was requested on the first page, so no count_limit capped it.
    expect(bodies[0]).not.toHaveProperty("count_limit");
    expect(jsonCalls(fetcher)).toHaveLength(1);

    const second = await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", domain: [["is_company", "=", true]], specification, limit: 2, cursor: firstData.page.next_cursor }
    });
    expect(second.isError).not.toBe(true);
    // The next page restricts by the last id seen rather than skipping rows.
    expect(bodies[1]).toMatchObject({ domain: [["id", ">", 11], ["is_company", "=", true]], offset: 0, count_limit: 3 });
  });

  it("falls back to offset paging when the order is not id alone", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json([{ id: 5, name: "x" }, { id: 4, name: "y" }, { id: 3, name: "z" }]);
    });
    const client = await connected(fetcher);
    const first = await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", fields: ["name"], order: "name asc, id asc", limit: 2 }
    });
    const cursor = (first.structuredContent as { data: any }).data.page.next_cursor;
    await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", fields: ["name"], order: "name asc, id asc", limit: 2, cursor }
    });
    expect(bodies[1]).toMatchObject({ domain: [], offset: 2, limit: 3 });
  });

  it("rejects fields together with specification without calling Odoo", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", fields: ["name"], specification: { name: {} } }
    });
    expect(result.isError).toBe(true);
    expect(jsonCalls(fetcher)).toHaveLength(0);
  });

  it("reads known ids with a specification and still sees archived records", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ length: 1, records: [{ id: 7, display_name: "Archived", active: false }] });
    });
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "odoo_read_records",
      arguments: { model: "res.partner", ids: [7, 8], specification: { display_name: {}, active: {} } }
    });
    expect(result.structuredContent).toMatchObject({ data: { missing_ids: [8] } });
    expect(bodies[0]).toMatchObject({ domain: [["id", "in", [7, 8]]], limit: 2 });
    expect((bodies[0].context as Record<string, unknown>).active_test).toBe(false);
    expect(jsonCalls(fetcher, "/res.partner/web_search_read")).toHaveLength(1);
  });
});

describe("write-and-read-back", () => {
  it("creates through web_save_multi and returns the records read back", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json([{ id: 501, display_name: "New task", stage_id: { id: 2, display_name: "New" } }]);
    });
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "odoo_create_records",
      arguments: {
        model: "project.task",
        values: [{ name: "New task", tag_ids: { link: [3] } }],
        specification: { display_name: {}, stage_id: { fields: { display_name: {} } } }
      }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        ids: [501],
        read_back: [{ id: 501, stage_id: { id: 2, display_name: "New" } }],
        execution: { outcome: "succeeded" }
      }
    });
    expect(jsonCalls(fetcher, "/project.task/web_save_multi")).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ vals_list: [{ name: "New task", tag_ids: [[4, 3, 0]] }] });
  });

  it("updates through web_save and returns the records read back", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json([{ id: 9, priority: "1" }, { id: 10, priority: "1" }]);
    });
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "odoo_update_records",
      arguments: { model: "project.task", ids: [9, 10], values: { priority: "1" }, specification: { priority: {} } }
    });
    expect(result.structuredContent).toMatchObject({
      data: { updated: true, ids: [9, 10], read_back: [{ id: 9, priority: "1" }, { id: 10, priority: "1" }] }
    });
    expect(jsonCalls(fetcher, "/project.task/web_save")).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ ids: [9, 10], vals: { priority: "1" }, specification: { priority: {} } });
  });

  it("keeps the plain create and write paths when no specification is passed", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/create") ? Response.json([77]) : Response.json(true));
    const client = await connected(fetcher);
    const created = await client.callTool({ name: "odoo_create_records", arguments: { model: "res.partner", values: [{ name: "x" }] } });
    const updated = await client.callTool({ name: "odoo_update_records", arguments: { model: "res.partner", ids: [77], values: { name: "y" } } });
    expect(created.structuredContent).toMatchObject({ data: { ids: [77] } });
    expect((created.structuredContent as { data: any }).data).not.toHaveProperty("read_back");
    expect(updated.structuredContent).toMatchObject({ data: { updated: true } });
    expect(jsonCalls(fetcher, "/res.partner/create")).toHaveLength(1);
    expect(jsonCalls(fetcher, "/res.partner/write")).toHaveLength(1);
  });
});
