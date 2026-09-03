import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http.js";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";
import { createObservability } from "../../src/runtime/observability.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

function configuration() {
  return loadRuntimeConfig({
    ODOO_PUBLIC_ORIGIN: "https://odoo.example",
    ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
    ODOO_DATABASE: "usl",
    MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    MCP_ALLOWED_HOSTS: "127.0.0.1",
    MCP_ALLOWED_ORIGINS: "chatgpt.com"
  });
}

const agentIdentity = {
  schema_version: 3,
  principal_kind: "agent",
  user_id: 41,
  agent: {
    id: 7,
    name: "HTTP Test Agent",
    purpose: "Exercise MCP transport.",
    state: "active",
    access_mode: "read_write",
    authority_reduced: false,
    partner_id: 43
  },
  owner: { id: 5, name: "Valentin" },
  credential: { id: 9, name: "HTTP test", expires_at: "2027-09-02 00:00:00" },
  company_id: 1,
  company_ids: [1, 2],
  companies: [{ id: 1, name: "USL" }, { id: 2, name: "USL MEDIA" }],
  effective_applications: [{ id: 10, name: "Accounting", access: "read_write" }],
  effective_group_ids: [1, 10]
};

function testServices(
  config: ReturnType<typeof configuration>,
  identity: unknown = agentIdentity,
  calls?: string[]
) {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls?.push(url);
    if (url.includes("/json/2/usl.agent/current_identity")) return Response.json(identity);
    if (url.endsWith("/doc-bearer/index.json")) return Response.json({ modules: [] });
    if (url.endsWith("/json/2/res.partner/search_read")) return Response.json([]);
    return Response.json({ message: "unexpected test request" }, { status: 404 });
  };
  const client = new OdooClient(8, 1024 * 1024, fetcher);
  return {
    client,
    registry: createCapabilityRegistry(client),
    enabledFeatures: new Set(config.documentMaterializationEnabled ? ["document_materialization"] : []),
    observability: createObservability(config.analytics),
    accessCache: new AgentAccessSnapshotCache(client)
  };
}

async function listeningServer(
  config = configuration(),
  identity: unknown = agentIdentity,
  calls?: string[]
) {
  const app = createHttpApp(config, testServices(config, identity, calls));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  closeCallbacks.push(async () => {
    await (app.locals.closeRuntime as (() => Promise<void>) | undefined)?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return `http://127.0.0.1:${address.port}`;
}

const credentialHeaders = {
  "X-Odoo-Url": "https://odoo.example",
  "X-Odoo-Database": "usl",
  "X-Odoo-Api-Key": "secret"
};

describe("VPS HTTP MCP transport", () => {
  it("serves health/readiness and a modern stateless MCP client", async () => {
    const origin = await listeningServer();
    await expect(fetch(`${origin}/healthz`).then((response) => response.json())).resolves.toEqual({ status: "ok" });
    const readiness = await fetch(`${origin}/readyz`).then((response) => response.json()) as Record<string, unknown>;
    expect(readiness.status).toBe("ready");

    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: credentialHeaders }
    });
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(transport);
    closeCallbacks.push(async () => client.close());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("odoo_search_records");
    expect(tools.tools.map((tool) => tool.name)).toContain("odoo_call_method");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("odoo_delete_records");
  });

  it("performs setup once while warm list and tool requests add only the business call", async () => {
    const calls: string[] = [];
    const origin = await listeningServer(configuration(), agentIdentity, calls);
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: credentialHeaders }
    });
    const client = new Client({ name: "http-request-count-test", version: "1.0.0" });
    await client.connect(transport);
    closeCallbacks.push(async () => client.close());
    expect(calls.filter((url) => url.includes("/current_identity"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/doc-bearer/index.json"))).toHaveLength(1);

    await client.listTools();
    await client.callTool({
      name: "odoo_search_records",
      arguments: { model: "res.partner", domain: [], fields: ["name"], context: {} }
    });
    expect(calls.filter((url) => url.includes("/current_identity"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/doc-bearer/index.json"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/json/2/res.partner/search_read"))).toHaveLength(1);
  });

  it("serves the enrollment page with a CSP that permits its own submit fetch", async () => {
    const databaseDirectory = mkdtempSync(join(tmpdir(), `odoo-mcp-test-oauth-${randomUUID()}-`));
    const databasePath = join(databaseDirectory, "oauth.sqlite");
    closeCallbacks.push(async () => rmSync(databaseDirectory, { recursive: true, force: true }));
    const origin = await listeningServer(loadRuntimeConfig({
      ODOO_PUBLIC_ORIGIN: "https://odoo.example",
      ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
      ODOO_DATABASE: "usl",
      MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
      MCP_ALLOWED_ORIGINS: "127.0.0.1",
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_DATABASE: databasePath,
      BETTER_AUTH_SECRET: "vps-test-better-auth-secret-vps-test",
      MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
    }));
    const response = await fetch(`${origin}/oauth/enroll`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("retains the preceding stateless protocol generation", async () => {
    const origin = await listeningServer();
    const response = await fetch(`${origin}/mcp/advanced`, {
      method: "POST",
      headers: {
        ...credentialHeaders,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" }
        }
      })
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    expect(data).toBeDefined();
    const payload = JSON.parse(data!) as { result?: { protocolVersion?: string } };
    expect(payload.result?.protocolVersion).toBe("2025-11-25");
  });

  it("rejects missing credentials and unknown profiles before MCP dispatch", async () => {
    const origin = await listeningServer();
    const missing = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    expect(missing.status).toBe(401);
    const unknown = await fetch(`${origin}/mcp/not-a-profile`, {
      method: "POST",
      headers: { ...credentialHeaders, "Content-Type": "application/json" },
      body: "{}"
    });
    expect(unknown.status).toBe(404);
  });

  it("rejects a human Odoo key before exposing MCP tools", async () => {
    const origin = await listeningServer(configuration(), {
      uid: 5,
      name: "Human user"
    });
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...credentialHeaders,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }
      })
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("governed Agent credential");
  });

  it("allows its public hostname when additional client origins are configured", async () => {
    const origin = await listeningServer();
    const sameOrigin = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}"
    });
    expect(sameOrigin.status).toBe(401);
    const rejected = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}"
    });
    expect(rejected.status).toBe(403);
  });
});
