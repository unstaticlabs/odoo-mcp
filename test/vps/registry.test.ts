import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { CapabilityRegistry, defineCapability } from "../../src/capabilities/registry.js";
import { OdooClient } from "../../src/odoo/client.js";
import type { AgentAccessState } from "../../src/runtime/agent_access_cache.js";
import { requestContext } from "./fixtures.js";

const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((close) => close()));
});

describe("canonical capability registry", () => {
  async function listedToolNames(registry: CapabilityRegistry, context = requestContext()) {
    const server = registry.createServer(context);
    const client = new Client({ name: "registry-availability-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push(async () => {
      await client.close();
      await server.close();
    });
    return (await client.listTools()).tools.map((tool) => tool.name);
  }

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
    const names = registry.list("all", { modules }).map((item) => item.name);
    expect(names).toContain("odoo_search_models");
    expect(names).toContain("projects_get_task_context");
    expect(names).not.toContain("documents_search");
    expect(names).not.toContain("expense_batches_post");
  });

  it("uses Odoo's read-only access document while preserving advertised collaboration methods", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const context = requestContext("read_only");
    const availability = {
      modelAccess: context.availableModelAccess,
      publicMethods: context.availablePublicMethods,
      enabledFeatures: context.enabledFeatures
    };
    const names = registry.list("all", availability).map((item) => item.name);
    expect(names).toContain("odoo_search_records");
    expect(names).toContain("odoo_post_message");
    expect(names).toContain("odoo_set_self_following");
    expect(names).toContain("activities_schedule");
    expect(names).toContain("documents_create_download_url");
    expect(names).toContain("documents_revoke_download_url");
    expect(names).toContain("expense_batches_get_context");
    expect(names).not.toContain("odoo_create_records");
    expect(names).not.toContain("odoo_update_records");
    expect(names).not.toContain("odoo_delete_records");
    expect(names).toContain("odoo_call_method");
    const searched = registry.search("create update delete", 20, availability);
    expect(searched.map((item) => item.name)).not.toEqual(expect.arrayContaining([
      "odoo_create_records",
      "odoo_update_records",
      "odoo_delete_records"
    ]));
  });

  it("filters fixed tools per application while keeping generic writes for mixed access", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const modelAccess = new Map([
      ["account.move", { read: true, create: false, write: false, unlink: false }],
      ["project.task", { read: true, create: true, write: true, unlink: false }]
    ]);
    const names = registry.list("all", {
      modelAccess,
      publicMethods: new Map()
    }).map((item) => item.name);
    expect(names).toContain("odoo_search_records");
    expect(names).toContain("odoo_create_records");
    expect(names).toContain("odoo_update_records");
    expect(names).toContain("projects_create_task");
    expect(names).not.toContain("expenses_configure_draft_vendor_bill");
    expect(names).not.toContain("odoo_delete_records");
  });

  it("publishes the read-only Agent catalogue from the authenticated identity", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const server = registry.createServer({ ...requestContext("read_only"), profile: "all" });
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
    expect(names).toContain("expense_batches_get_context");
    expect(names).not.toContain("odoo_create_records");
  });

  it("hides backend-dependent tools until their methods and feature flag are both available", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const modules = new Set(["base", "api_doc", "mail", "usl_documents"]);
    const withoutMethods = registry.list("documents", { modules, publicMethods: null })
      .map((item) => item.name);
    expect(withoutMethods).not.toContain("documents_create_download_url");

    const publicMethods = new Map([
      ["usl.document", new Set(["mcp_create_download_grant", "mcp_revoke_download_grant"])]
    ]);
    expect(registry.list("documents", { modules, publicMethods, enabledFeatures: new Set() })
      .map((item) => item.name)).not.toContain("documents_create_download_url");
    expect(registry.list("documents", {
      modules,
      publicMethods,
      enabledFeatures: new Set(["document_materialization"])
    }).map((item) => item.name)).toEqual(expect.arrayContaining([
      "documents_create_download_url",
      "documents_revoke_download_url"
    ]));
  });

  it("fails closed while registering backend-dependent tools at runtime", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const unavailable = await listedToolNames(registry, {
      ...requestContext(),
      profile: "documents",
      availablePublicMethods: undefined,
      enabledFeatures: undefined
    });
    expect(unavailable).toContain("odoo_search_records");
    expect(unavailable).not.toContain("documents_create_download_url");
    expect(unavailable).not.toContain("documents_get_context");

    const undiscoverable = await listedToolNames(registry, {
      ...requestContext(),
      profile: "documents",
      availablePublicMethods: null,
      enabledFeatures: new Set(["document_materialization"])
    });
    expect(undiscoverable).not.toContain("documents_create_download_url");
    expect(undiscoverable).not.toContain("documents_get_context");

    const methods = new Map([
      ["usl.document", new Set(["mcp_create_download_grant", "mcp_revoke_download_grant"])]
    ]);
    const flagDisabled = await listedToolNames(registry, {
      ...requestContext(),
      profile: "documents",
      availablePublicMethods: methods,
      enabledFeatures: new Set()
    });
    expect(flagDisabled).not.toContain("documents_create_download_url");

    const partial = await listedToolNames(registry, {
      ...requestContext(),
      profile: "documents",
      availablePublicMethods: new Map([
        ["usl.document", new Set(["mcp_create_download_grant"])]
      ]),
      enabledFeatures: new Set(["document_materialization"])
    });
    expect(partial).toContain("documents_create_download_url");
    expect(partial).not.toContain("documents_revoke_download_url");

    const available = await listedToolNames(registry, {
      ...requestContext(),
      profile: "documents",
      availablePublicMethods: methods,
      enabledFeatures: new Set(["document_materialization"])
    });
    expect(available).toEqual(expect.arrayContaining([
      "documents_create_download_url",
      "documents_revoke_download_url"
    ]));
  });

  it("updates a dynamic stdio catalogue and notifies only when visible names change", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const context = requestContext();
    let refresh!: (state: AgentAccessState) => boolean | void;
    const server = registry.createServer(context, {
      dynamic: true,
      subscribe(listener) {
        refresh = listener;
      }
    });
    const client = new Client({ name: "dynamic-registry-test", version: "1.0.0" });
    let notifications = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => { notifications++; });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push(async () => {
      await client.close();
      await server.close();
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("odoo_create_records");

    const readOnlyAccess = new Map(
      [...context.availableModelAccess!].map(([model]) => [model, {
        read: true,
        create: false,
        write: false,
        unlink: false
      }] as const)
    );
    const contracted: AgentAccessState = {
      available: true,
      snapshot: {
        identity: context.agentIdentity!,
        surface: {
          modules: new Set(),
          publicMethods: context.availablePublicMethods!,
          modelAccess: readOnlyAccess
        },
        refreshedAt: Date.now()
      }
    };
    expect(refresh(contracted)).toBe(true);
    await vi.waitFor(() => expect(notifications).toBe(1));
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("odoo_create_records");

    expect(refresh(contracted)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toBe(1);

    const expanded: AgentAccessState = {
      available: true,
      snapshot: {
        identity: context.agentIdentity!,
        surface: {
          modules: new Set(),
          publicMethods: context.availablePublicMethods!,
          modelAccess: requestContext().availableModelAccess!
        },
        refreshedAt: Date.now()
      }
    };
    expect(refresh(expanded)).toBe(true);
    await vi.waitFor(() => expect(notifications).toBe(2));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("odoo_create_records");
  });

  it("keeps output validation after a successful mutation inside the receipt boundary", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 91 }));
    const odoo = new OdooClient(8, 1024 * 1024, fetcher);
    const registry = new CapabilityRegistry().add(defineCapability({
      id: "test.invalid_mutation_output",
      name: "test_invalid_mutation_output",
      title: "Invalid Mutation Output",
      description: "Exercise mutation-aware output validation.",
      layer: "business_action",
      toolsets: ["core"],
      profiles: ["default"],
      effect: "write",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      keywords: ["test"],
      requiredModules: [],
      defaultVisible: true,
      alwaysLoad: true,
      sortOrder: 1,
      input: z.object({}).strict(),
      output: z.object({ accepted: z.boolean() }).strict(),
      async handler(_input, context, signal) {
        const receipt = await odoo.call(context, "test.model", "mutate", {}, {
          kind: "mutation",
          signal,
          reconciliation: {
            targetModel: "test.model",
            knownIds: [91],
            suggestedTool: "odoo_read_records",
            instructions: "Read test.model,91 before deciding whether to repeat the mutation."
          }
        });
        return receipt.finalize(() => ({
          data: { accepted: "not-a-boolean" } as unknown as { accepted: boolean }
        }));
      }
    }));
    const server = registry.createServer(requestContext());
    const client = new Client({ name: "mutation-output-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push(async () => {
      await client.close();
      await server.close();
    });
    const result = await client.callTool({ name: "test_invalid_mutation_output", arguments: {} });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      error: {
        outcome: "unknown",
        retry_guidance: "reconcile_first",
        stage: "response_processing",
        known: {
          request_sent: "yes",
          response_received: "yes",
          result_received: "yes",
          target_model: "test.model",
          record_ids: [91]
        }
      }
    });
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
