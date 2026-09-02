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

  it("treats profiles as filtered canonical views without leaking advanced tools", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const accounting = registry.list("accounting").map((item) => item.name);
    expect(accounting).toContain("odoo_search_records");
    expect(accounting).toContain("accounting_get_invoice_context");
    expect(accounting).toContain("expense_batches_post");
    expect(accounting).not.toContain("odoo_call_method");
    expect(accounting).not.toContain("odoo_delete_records");

    const documents = registry.list("documents").map((item) => item.name);
    expect(documents).toContain("documents_create_download_url");
    expect(documents).toContain("documents_revoke_download_url");
    expect(registry.search("materialize document PDF", 5).map((item) => item.name))
      .toContain("documents_create_download_url");
    const materialize = registry.list("documents").find(
      (item) => item.name === "documents_create_download_url"
    );
    expect(materialize).toMatchObject({
      layer: "business_action",
      effect: "consequential",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      alwaysLoad: false
    });
    const revoke = registry.list("documents").find(
      (item) => item.name === "documents_revoke_download_url"
    );
    expect(revoke?.annotations.idempotentHint).toBe(true);

    const readOnly = registry.list("read-only");
    expect(readOnly.every((item) => item.effect === "read")).toBe(true);
  });

  it("omits capabilities whose Distribution modules are known to be unavailable", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const modules = new Set(["base", "api_doc", "mail", "project"]);
    const names = registry.list("all", modules).map((item) => item.name);
    expect(names).toContain("odoo_search_models");
    expect(names).toContain("projects_get_task_context");
    expect(names).not.toContain("documents_search");
    expect(names).not.toContain("expense_batches_post");
  });

  it("limits read-only Agents to reads and the explicit collaboration corridor", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const names = registry.list("all", undefined, "read_only").map((item) => item.name);
    expect(names).toContain("odoo_search_records");
    expect(names).toContain("odoo_post_message");
    expect(names).toContain("odoo_set_self_following");
    expect(names).toContain("activities_schedule");
    expect(names).toContain("documents_create_download_url");
    expect(names).toContain("documents_revoke_download_url");
    expect(names).not.toContain("expense_batches_get_context");
    expect(names).not.toContain("odoo_create_records");
    expect(names).not.toContain("odoo_update_records");
    expect(names).not.toContain("odoo_archive_records");
    expect(names).not.toContain("odoo_delete_records");
    expect(names).not.toContain("odoo_call_method");
    const searched = registry.search("create update delete", 20, undefined, "read_only");
    expect(searched.map((item) => item.name)).not.toEqual(expect.arrayContaining([
      "odoo_create_records",
      "odoo_update_records",
      "odoo_delete_records"
    ]));
  });

  it("keeps write tools available for mixed Agents while Odoo enforces each application", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const names = registry.list("all", undefined, "mixed").map((item) => item.name);
    expect(names).toContain("odoo_search_records");
    expect(names).toContain("odoo_create_records");
    expect(names).toContain("odoo_update_records");
  });

  it("publishes the read-only Agent catalogue from the authenticated identity", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const server = registry.createServer(requestContext("read_only"));
    const client = new Client({ name: "readonly-registry-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push(async () => {
      await client.close();
      await server.close();
    });
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "activities_schedule",
      "documents_create_download_url",
      "documents_revoke_download_url",
      "odoo_post_message",
      "odoo_set_self_following"
    ]));
    expect(names).not.toContain("expense_batches_get_context");
    expect(names).not.toContain("odoo_create_records");
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
    const semantic = tools.tools.find((tool) => tool.name === "projects_get_task_context");
    expect(semantic?._meta).toMatchObject({ defer_loading: true, "odoo/toolsets": expect.arrayContaining(["projects"]) });
  });
});
