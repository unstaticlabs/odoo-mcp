import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("generic record aggregation", () => {
  it("uses the public Odoo 19 formatted_read_group contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([
      { company_id: [3, "USL"], balance: 75 }
    ]));
    const odoo = new OdooClient(8, 1024 * 1024, fetcher);
    const server = createCapabilityRegistry(odoo).createServer(requestContext());
    const client = new Client({ name: "aggregate-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "odoo_aggregate_records",
      arguments: {
        model: "account.move.line",
        domain: [["company_id", "=", 3]],
        groupby: ["company_id"],
        aggregates: ["balance:sum"],
        order: "company_id",
        limit: 10,
        context: {}
      }
    });

    expect(result.isError).not.toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith("/json/2/account.move.line/formatted_read_group")).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      groupby: ["company_id"],
      aggregates: ["balance:sum"],
      order: "company_id",
      limit: 10
    });
  });
});
