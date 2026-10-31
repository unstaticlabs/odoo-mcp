import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixturePath = process.env.ODOO_PROJECT_ATTACHMENT_FIXTURE;
const enabled = process.env.ODOO_INTEGRATION_MUTATION_QA === "1" && Boolean(fixturePath);

describe.skipIf(!enabled).sequential("project attachment bytes in a disposable Distribution", () => {
  let client: Client;
  let server: ReturnType<ReturnType<typeof createCapabilityRegistry>["createServer"]>;
  let cache: AgentAccessSnapshotCache;
  let odoo: OdooClient;
  let context: RequestContext;
  let fixture: { synthetic: true; database: string; task_id: number; company_id: number };

  beforeAll(async () => {
    fixture = JSON.parse(readFileSync(fixturePath!, "utf8"));
    const origin = process.env.ODOO_INTEGRATION_ORIGIN;
    const database = process.env.ODOO_INTEGRATION_DATABASE;
    const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
    if (!origin || !database || !apiKey || fixture.synthetic !== true || fixture.database !== database ||
      !Number.isInteger(fixture.task_id) || fixture.task_id <= 0 ||
      !Number.isInteger(fixture.company_id) || fixture.company_id <= 0) {
      throw new Error("Project attachment integration requires its explicit synthetic task fixture");
    }
    const internalOrigin = process.env.ODOO_INTEGRATION_INTERNAL_ORIGIN ?? origin;
    for (const address of [origin, internalOrigin]) {
      const url = new URL(address);
      if (url.protocol !== "http:" ||
        !(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost"))) {
        throw new Error("Project attachment mutation integration requires a localhost Distribution");
      }
    }
    context = {
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "all",
      principal: { targetId: "synthetic-project-attachment", publicOrigin: origin,
        internalOrigin, database, apiKey, authMode: "direct" }
    };
    odoo = new OdooClient();
    cache = new AgentAccessSnapshotCache(odoo);
    const snapshot = await cache.initialize(context);
    context.agentIdentity = snapshot.identity;
    context.availableModules = snapshot.surface?.modules ?? null;
    context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
    context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context);
    context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
    server = createCapabilityRegistry(odoo).createServer(context);
    client = new Client({ name: "project-attachment-integration", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 120_000);

  afterAll(async () => { await client?.close(); await server?.close(); await cache?.close(); });

  it.each([
    { label: "UTF-8 text", bytes: Buffer.from("Synthetic MCP project attachment — café\n", "utf8") },
    { label: "512 KiB binary boundary", bytes: Buffer.alloc(512 * 1024, 0xa5) }
  ])("stores exact bytes, checksum and task ownership for $label", async ({ bytes }) => {
    const name = `synthetic-mcp-attachment-${crypto.randomUUID()}.txt`;
    const rpcContext = { allowed_company_ids: [fixture.company_id] };
    const uploaded = await client.callTool({
      name: "projects_attach_file",
      arguments: { task_id: fixture.task_id, name, data_base64: bytes.toString("base64"),
        mimetype: "text/plain", context: rpcContext }
    });
    expect(uploaded.isError).not.toBe(true);
    const result = uploaded.structuredContent as { data: { result: { attachment_id: number; file_size: number } } };
    expect(result.data.result.file_size).toBe(bytes.byteLength);
    const attachmentId = result.data.result.attachment_id;
    expect(attachmentId).toBeGreaterThan(0);
    const attachments = await odoo.call<Record<string, unknown>[]>(context, "ir.attachment", "read", {
      ids: [attachmentId], fields: ["raw", "file_size", "checksum", "res_model", "res_id", "name"], context: rpcContext
    }, { responseBytes: 2 * 1024 * 1024 });
    expect(attachments).toHaveLength(1);
    const attachment = attachments[0]!;
    expect(typeof attachment.raw).toBe("string");
    expect(Buffer.from(attachment.raw as string, "base64").equals(bytes)).toBe(true);
    expect(attachment.file_size).toBe(bytes.byteLength);
    expect(attachment.checksum).toBe(createHash("sha1").update(bytes).digest("hex"));
    expect(attachment.res_model).toBe("project.task");
    expect(attachment.res_id).toBe(fixture.task_id);
    expect(attachment.name).toBe(name);
  }, 60_000);
});
