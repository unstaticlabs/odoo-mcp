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
    expect(names).toContain("odoo_call_method");
    expect(names).toContain("odoo_submit_feedback");
    expect(names).toContain("activities_schedule");
    expect(names).not.toContain("odoo_delete_records");
    expect(registry.profileBudget("default")).toMatchObject({ tools: 31 });
    expect(registry.profileBudget("default").schemaTokens).toBeLessThanOrEqual(15_000);
  });

  it("exposes the public method substrate through writable profiles but not read-only", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    for (const profile of ["default", "advanced", "accounting", "projects", "documents", "b2c"] as const) {
      expect(registry.list(profile).map((item) => item.name), profile).toContain("odoo_call_method");
      expect(registry.list(profile).map((item) => item.name), profile).toContain("odoo_submit_feedback");
    }
    expect(registry.list("read-only").map((item) => item.name)).not.toContain("odoo_call_method");
    expect(registry.list("read-only").map((item) => item.name)).not.toContain("odoo_submit_feedback");
    expect(registry.search("public method escape hatch", 5).map((item) => item.metadata.name))
      .toContain("odoo_call_method");
  });

  it("exposes complete document and draft-preparation workflows without widening permissions", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const added = ["documents_search", "documents_get_content", "documents_create_download_url",
      "documents_revoke_download_url", "projects_create_task", "expenses_get_context",
      "expenses_update_draft", "expenses_configure_draft_vendor_bill"];
    expect(await listedToolNames(registry)).toEqual(expect.arrayContaining(added));
    const readOnly = await listedToolNames(registry, { ...requestContext(), profile: "read-only" });
    expect(readOnly).toEqual(expect.arrayContaining(["documents_search", "documents_get_content", "expenses_get_context"]));
    for (const name of added.filter((name) => !["documents_search", "documents_get_content", "expenses_get_context"].includes(name))) {
      expect(readOnly).not.toContain(name);
    }
    const disabled = await listedToolNames(registry, { ...requestContext(), enabledFeatures: new Set() });
    expect(disabled).toContain("documents_search");
    expect(disabled).not.toContain("documents_create_download_url");
    expect(disabled).not.toContain("documents_revoke_download_url");
    const restricted = requestContext();
    restricted.availableModelAccess!.set("project.task", { read: true, create: false, write: false, unlink: false });
    restricted.availableModelAccess!.set("hr.expense", { read: true, create: false, write: false, unlink: false });
    restricted.availableModelAccess!.set("account.move", { read: true, create: false, write: false, unlink: false });
    const names = await listedToolNames(registry, restricted);
    for (const name of ["projects_create_task", "expenses_update_draft", "expenses_configure_draft_vendor_bill"]) {
      expect(names).not.toContain(name);
    }
  });

  it("does not recommend an action because its description says it cannot do the requested operation", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    for (const query of ["approve expense", "submit expense", "post expense"]) {
      const options = { profile: "default" as const };
      expect(registry.recommendFallback(query, registry.search(query, 20, options), options)?.name)
        .toBe("odoo_call_method");
    }
    const options = { profile: "default" as const };
    expect(registry.recommendFallback("draft expense tax", registry.search("draft expense tax", 20, options), options)?.name)
      .toBe("expenses_update_draft");
  });

  it("treats profiles as filtered canonical views without leaking advanced tools", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const accounting = registry.list("accounting").map((item) => item.name);
    expect(accounting).toContain("odoo_search_records");
    expect(accounting).toContain("accounting_get_invoice_context");
    expect(accounting).toContain("expense_batches_post");
    expect(accounting).toContain("odoo_call_method");
    expect(accounting).not.toContain("odoo_delete_records");

    const documents = registry.list("documents").map((item) => item.name);
    expect(documents).toContain("documents_create_download_url");
    expect(documents).toContain("documents_revoke_download_url");
    expect(registry.search("materialize document PDF", 5).map((item) => item.metadata.name))
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
    const searched = registry.search("create update delete", 20, { availability });
    expect(searched.map((item) => item.metadata.name)).not.toEqual(expect.arrayContaining([
      "odoo_create_records",
      "odoo_update_records",
      "odoo_delete_records"
    ]));
  });

  it("searches the complete catalogue when backend metadata is unknown", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const availability = {
      modules: null,
      publicMethods: null,
      modelAccess: null,
      enabledFeatures: new Set<string>()
    };
    const options = { profile: "default" as const, availability };
    const exposed = registry.list("default", availability).map((item) => item.name);
    expect(exposed).toHaveLength(8);
    expect(exposed).toContain("odoo_call_method");

    for (const query of ["expense", "write", "approve", "approve this expense"]) {
      expect(registry.search(query, 10, options), query).not.toHaveLength(0);
    }
    const matches = registry.search("approve this expense", 10, options);
    expect(matches).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ name: "expenses_approve" }),
      availability: "unknown",
      visibleInCurrentProfile: false,
      callableNow: false
    }));
    expect(registry.recommendFallback("approve this expense", matches, options)).toMatchObject({
      name: "odoo_call_method"
    });

    const known = requestContext();
    const knownAvailability = {
      modules: known.availableModules,
      publicMethods: known.availablePublicMethods,
      modelAccess: known.availableModelAccess,
      enabledFeatures: known.enabledFeatures
    };
    const accountingMatches = registry.search("expenses_approve", 1, {
      profile: "accounting",
      availability: knownAvailability
    });
    expect(registry.recommendFallback("expenses_approve", accountingMatches, {
      profile: "accounting",
      availability: knownAvailability
    })).toMatchObject({ name: "expenses_approve" });
  });

  it("filters definitively unavailable capabilities and recommends a read primitive for read-only", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const unavailable = {
      modules: new Set(["base"]),
      publicMethods: new Map<string, ReadonlySet<string>>(),
      modelAccess: new Map<string, { read: boolean; create: boolean; write: boolean; unlink: boolean }>(),
      enabledFeatures: new Set<string>()
    };
    const absent = registry.search("approve this expense", 20, {
      profile: "default",
      availability: unavailable
    });
    expect(absent.map((item) => item.metadata.name)).not.toEqual(expect.arrayContaining([
      "expenses_approve",
      "expense_batches_approve"
    ]));

    const unknown = { modules: null, publicMethods: null, modelAccess: null, enabledFeatures: new Set<string>() };
    const matches = registry.search("approve this expense", 10, {
      profile: "read-only",
      availability: unknown
    });
    expect(matches.every((item) => !item.callableNow)).toBe(true);
    expect(registry.recommendFallback("approve this expense", matches, {
      profile: "read-only",
      availability: unknown
    })).toMatchObject({ name: "odoo_search_records" });
    const knownReadOnly = requestContext("read_only");
    const knownMatches = registry.search("expense", 10, {
      profile: "read-only",
      availability: {
        publicMethods: knownReadOnly.availablePublicMethods,
        modelAccess: knownReadOnly.availableModelAccess,
        enabledFeatures: knownReadOnly.enabledFeatures
      }
    });
    expect(registry.recommendFallback("expense", knownMatches, {
      profile: "read-only",
      availability: {
        publicMethods: knownReadOnly.availablePublicMethods,
        modelAccess: knownReadOnly.availableModelAccess,
        enabledFeatures: knownReadOnly.enabledFeatures
      }
    })).toMatchObject({ name: "odoo_search_records" });
  });

  it("normalizes punctuation, identifiers, stopwords, and simple plurals deterministically", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    expect(registry.search("ODOO.CALL-METHOD", 1)[0]?.metadata.name).toBe("odoo_call_method");
    expect(registry.search("please approve these expenses", 10).map((item) => item.metadata.name))
      .toContain("expenses_approve");
    expect(registry.search("please do this for me", 10)).toHaveLength(0);
    expect(registry.search("", 100).map((item) => item.metadata.name))
      .toEqual(registry.list("all").map((item) => item.name));
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
    expect(search?._meta).not.toHaveProperty("defer_loading");
    const semantic = tools.tools.find((tool) => tool.name === "projects_get_task_context");
    expect(semantic?._meta).toMatchObject({ "odoo/toolsets": expect.arrayContaining(["projects"]) });
    expect(semantic?._meta).not.toHaveProperty("defer_loading");
    const method = tools.tools.find((tool) => tool.name === "odoo_call_method");
    expect(method).toMatchObject({
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: expect.any(Object),
          method: expect.any(Object),
          ids: expect.any(Object),
          kwargs: expect.any(Object),
          context: expect.any(Object)
        }
      },
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: {
        "odoo/toolsets": expect.arrayContaining(["core", "advanced"])
      }
    });
    expect(method?._meta).not.toHaveProperty("defer_loading");

    const searchResult = await client.callTool({
      name: "odoo_search_capabilities",
      arguments: { query: "approve this expense", limit: 10 }
    });
    expect(searchResult.structuredContent).toMatchObject({
      data: {
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            name: "expenses_approve",
            availability: "available",
            visible_in_current_profile: false,
            callable_now: false
          })
        ]),
        recommended_fallback: { name: "odoo_call_method" },
        selection_note: expect.stringContaining("does not activate tools")
      }
    });
  });

  it("reserves deferred-loading metadata for the explicit all profile", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const server = registry.createServer({ ...requestContext(), profile: "all" });
    const client = new Client({ name: "all-profile-registry-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push(async () => {
      await client.close();
      await server.close();
    });

    const tools = await client.listTools();
    const search = tools.tools.find((tool) => tool.name === "odoo_search_capabilities");
    const semantic = tools.tools.find((tool) => tool.name === "projects_get_task_context");
    expect(search?._meta).toMatchObject({ defer_loading: false });
    expect(semantic?._meta).toMatchObject({ defer_loading: true });
  });
});
