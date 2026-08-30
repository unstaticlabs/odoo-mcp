import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("Distribution semantic and business capabilities", () => {
  it("executes a document link as exactly one Odoo-side mutation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 91 }));
    const odoo = new OdooClient(8, 1024 * 1024, fetcher);
    const registry = createCapabilityRegistry(odoo);
    const server = registry.createServer({ ...requestContext(), profile: "documents" });
    const client = new Client({ name: "semantic-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "documents_link_to_record",
      arguments: {
        document_id: 17,
        model: "project.task",
        id: 42,
        context: { allowed_company_ids: [3] }
      }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith("/json/2/usl.document/link_to_record")).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({
      ids: [17],
      res_model: "project.task",
      res_id: 42,
      context: {
        allowed_company_ids: [3],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(result.structuredContent).toMatchObject({
      data: { outcome: "succeeded", correlation_id: "correlation-test" }
    });
  });
});
