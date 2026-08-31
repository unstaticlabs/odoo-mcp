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

  it("creates one explicit short-lived document URL without retrying the mutation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      grant_id: "1fcae9e6-c713-42c5-9d1f-e1ba8dc76b40",
      url: "https://odoo.example/agent-documents/abcdefghijklmnopqrstuvwxyzABCDEFGH_1234567",
      expires_at: "2026-08-30T12:05:00Z",
      ttl_seconds: 300,
      document: { id: 17, name: "Supplier invoice" },
      version: {
        id: 91,
        paperless_version_id: "version-3",
        label: "Version 3",
        is_current_at_issuance: true
      },
      variant: "original",
      filename: "supplier-invoice.pdf",
      mime_type: "application/pdf",
      size_bytes: 4096,
      checksum: "abc123"
    }));
    const odoo = new OdooClient(8, 1024 * 1024, fetcher);
    const server = createCapabilityRegistry(odoo).createServer({
      ...requestContext(),
      profile: "documents"
    });
    const client = new Client({ name: "materialization-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "documents_create_download_url",
      arguments: {
        document_id: 17,
        document_version_id: 91,
        variant: "original",
        ttl_seconds: 300,
        context: { allowed_company_ids: [3] }
      }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith("/json/2/usl.document/mcp_create_download_grant")).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({
      document_id: 17,
      document_version_id: 91,
      variant: "original",
      ttl_seconds: 300,
      context: {
        allowed_company_ids: [3],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        grant_id: "1fcae9e6-c713-42c5-9d1f-e1ba8dc76b40",
        document: {
          model: "usl.document",
          id: 17,
          url: "https://odoo.example/odoo/usl.document/17"
        },
        outcome: "succeeded"
      }
    });
  });

  it("revokes a materialization grant through one idempotent backend operation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      grant_id: "1fcae9e6-c713-42c5-9d1f-e1ba8dc76b40",
      revoked: true,
      revoked_at: "2026-08-30T12:01:00Z"
    }));
    const server = createCapabilityRegistry(
      new OdooClient(8, 1024 * 1024, fetcher)
    ).createServer({ ...requestContext(), profile: "documents" });
    const client = new Client({ name: "revocation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "documents_revoke_download_url",
      arguments: {
        grant_id: "1fcae9e6-c713-42c5-9d1f-e1ba8dc76b40",
        reason: "Finished processing",
        context: {}
      }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0]).endsWith(
      "/json/2/usl.document/mcp_revoke_download_grant"
    )).toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { revoked: true, outcome: "succeeded" }
    });
  });

  it("rejects long-lived materialization grants before calling Odoo", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const server = createCapabilityRegistry(
      new OdooClient(8, 1024 * 1024, fetcher)
    ).createServer({ ...requestContext(), profile: "documents" });
    const client = new Client({ name: "bounds-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "documents_create_download_url",
      arguments: { document_id: 17, ttl_seconds: 901, context: {} }
    });

    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an unknown outcome when grant issuance transport completion is ambiguous", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("connection reset");
    });
    const server = createCapabilityRegistry(
      new OdooClient(8, 1024 * 1024, fetcher)
    ).createServer({ ...requestContext(), profile: "documents" });
    const client = new Client({ name: "unknown-outcome-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "documents_create_download_url",
      arguments: { document_id: 17, context: {} }
    });

    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      error: {
        outcome: "unknown",
        retryable: true,
        recovery: expect.stringContaining("Reconcile mutations before retrying")
      }
    });
  });

  it("keeps document context reads free of bearer materialization calls", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const method = String(url).split("/").at(-1)!;
      methods.push(method);
      if (method === "mcp_get") {
        return Response.json({
          id: 17,
          name: "Supplier invoice",
          binary_available: true,
          available_variants: ["original", "archive"],
          materialization_required: true
        });
      }
      return Response.json(method === "mcp_get_versions" ? { versions: [] } : { links: [] });
    });
    const server = createCapabilityRegistry(
      new OdooClient(8, 1024 * 1024, fetcher)
    ).createServer({ ...requestContext(), profile: "documents" });
    const client = new Client({ name: "context-no-grant-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "documents_get_context",
      arguments: { document_id: 17, context: {} }
    });

    expect(result.isError).not.toBe(true);
    expect(methods).toEqual(expect.arrayContaining([
      "mcp_get",
      "mcp_get_versions",
      "mcp_get_links"
    ]));
    expect(methods).not.toContain("mcp_create_download_grant");
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toContain("agent-documents");
    expect(serialized).not.toContain("download_path");
    expect(serialized).not.toContain("paperless_url");
  });
  it("skips document links when the Distribution documents module is absent", async () => {
    const models: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const model = decodeURIComponent(String(input).split("/json/2/")[1]!.split("/")[0]!);
      models.push(model);
      if (model === "project.task") return Response.json([{ id: 42, display_name: "Card 42" }]);
      return Response.json([]);
    });
    const modules = new Set(["base", "api_doc", "mail", "project"]);
    const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({
      ...requestContext(),
      profile: "projects",
      availableModules: modules
    });
    const client = new Client({ name: "task-context-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "projects_get_task_context",
      arguments: { task_id: 42, context: {} }
    });

    expect(result.isError).not.toBe(true);
    expect(models).not.toContain("usl.document.link");
    expect(JSON.stringify(result.structuredContent)).not.toContain("Document links were unavailable");
  });
});
