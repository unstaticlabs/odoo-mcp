import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((close) => close()));
});

describe("canonical capability registry", () => {
  it("keeps the default surface broad, deterministic, and within budget", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const names = registry.list("default").map((capability) => capability.name);
    expect(names).toEqual([...names].sort((left, right) => {
      const leftMeta = registry.list("default").find((item) => item.name === left)!;
      const rightMeta = registry.list("default").find((item) => item.name === right)!;
      return leftMeta.sortOrder - rightMeta.sortOrder || left.localeCompare(right);
    }));
    expect(names).toContain("odoo_search_records");
    expect(names).toContain("odoo_create_records");
    expect(names).not.toContain("odoo_call_method");
    expect(registry.profileBudget("default")).toMatchObject({ tools: expect.any(Number) });
    expect(registry.profileBudget("default").tools).toBeLessThanOrEqual(20);
    expect(registry.profileBudget("default").schemaTokens).toBeLessThanOrEqual(15_000);
  });

  it("exposes the public method substrate only through advanced/all views", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    expect(registry.list("default").map((item) => item.name)).not.toContain("odoo_call_method");
    expect(registry.list("advanced").map((item) => item.name)).toContain("odoo_call_method");
    expect(registry.search("public method escape hatch", 5).map((item) => item.name)).toContain("odoo_call_method");
  });

  it("registers valid MCP v2 schemas and structured tool metadata", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const server = registry.createServer(requestContext());
    const client = new Client({ name: "registry-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push(async () => {
      await client.close();
      await server.close();
    });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(registry.list("default").map((item) => item.name));
    const search = tools.tools.find((tool) => tool.name === "odoo_search_capabilities");
    expect(search?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(search?.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(search?._meta).toMatchObject({ "odoo/layer": "generic" });
  });
});
