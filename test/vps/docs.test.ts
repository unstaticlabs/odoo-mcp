import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });

async function connected(fetcher: typeof fetch, modules = new Set(["usl_docs"])) {
  const context = { ...requestContext("read_only"), profile: "read-only" as const, availableModules: modules };
  const registry = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher));
  const server = registry.createServer(context);
  const client = new Client({ name: "guide-reader", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, registry };
}

const page = {
  path: "how-to/process-expense.md", url: "/usl/user-docs/how-to/process-expense",
  title: "Review an expense", type: "how-to", description: "Check the evidence before posting.",
  lang: "en", persona: null, app: "Expenses", score: 24, snippet: "Review the receipt and payment match."
};

describe("user-guide search", () => {
  it("is a native read visible without abstract-model CRUD metadata", async () => {
    const { client, registry } = await connected(vi.fn<typeof fetch>());
    const tool = (await client.listTools()).tools.find(tool => tool.name === "docs_search");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(registry.list("default").map(item => item.name)).toContain("docs_search");
  });

  it("preserves native ranking, readable snippets and canonical links in one read", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([page, {
      ...page, path: "reference/expenses.md", url: "/usl/user-docs/reference/expenses",
      title: "Expense reference", score: 15, persona: "accountant", app: null
    }]));
    const { client } = await connected(fetcher);
    const result = await client.callTool({ name: "docs_search", arguments: { query: "expense receipt", lang: "en", limit: 2 } });
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/json\/2\/usl\.docs\.guide\/search_pages$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: "expense receipt", lang: "en", limit: 2 });
    expect(result.structuredContent).toMatchObject({ data: { pages: [
      { ...page, url: "https://odoo.example/usl/user-docs/how-to/process-expense" },
      { title: "Expense reference", score: 15, url: "https://odoo.example/usl/user-docs/reference/expenses", app: null }
    ] } });
  });

  it("returns an empty search and retains native access errors", async () => {
    const empty = await connected(vi.fn<typeof fetch>(async () => Response.json([])));
    expect((await empty.client.callTool({ name: "docs_search", arguments: { query: "no matching guide" } })).structuredContent)
      .toMatchObject({ data: { pages: [] } });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ name: "odoo.exceptions.AccessError", message: "Internal users only" }, { status: 403 }));
    const denied = await connected(fetcher);
    const result = await denied.client.callTool({ name: "docs_search", arguments: { query: "expense" } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code: "ODOO_PERMISSION_DENIED" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{ query: " " }, { query: "expense", limit: 51 }, { query: "expense", unexpected: true }])
    ("rejects malformed bounded input before contacting Odoo: %j", async args => {
      const fetcher = vi.fn<typeof fetch>(); const { client } = await connected(fetcher);
      expect((await client.callTool({ name: "docs_search", arguments: args })).isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    });

  it("does not advertise a guide on a server that does not install it", async () => {
    const { client } = await connected(vi.fn<typeof fetch>(), new Set());
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("docs_search");
  });
});
