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
  const odoo = new OdooClient(8, 1024 * 1024, fetcher);
  const server = createCapabilityRegistry(odoo).createServer({ ...requestContext(), profile: "accounting" });
  const client = new Client({ name: "accounting-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("rebuilt accounting capabilities", () => {
  it("reads the authoritative company overview with a scoped company context", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([{
      id: 8,
      display_name: "USL Accounting Overview",
      company_id: [3, "USL"],
      readiness_status: "warning"
    }]));
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "accounting_get_overview",
      arguments: { company_id: 3, context: {} }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith("/json/2/rebuild.account.overview/search_read")).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      domain: [["company_id", "=", 3]],
      limit: 1,
      context: {
        allowed_company_ids: [3],
        company_id: 3,
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        overview: {
          readiness_status: "warning",
          _ref: {
            model: "rebuild.account.overview",
            id: 8,
            url: "https://odoo.example/odoo/rebuild.account.overview/8"
          }
        }
      }
    });
  });

  it("keeps rebuilt report tools out of the generic default while making overview broad", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const defaultNames = registry.list("default").map((item) => item.name);
    const accountingNames = registry.list("accounting").map((item) => item.name);

    expect(defaultNames).toContain("accounting_get_overview");
    expect(defaultNames).not.toContain("accounting_get_management_report");
    expect(accountingNames).toEqual(expect.arrayContaining([
      "accounting_get_overview",
      "accounting_review_key_accounts",
      "accounting_get_management_report",
      "accounting_get_tax_report_context"
    ]));
  });
});
