import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";

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
    MCP_ALLOWED_ORIGINS: "127.0.0.1"
  });
}

async function listeningServer(config = configuration()) {
  const app = createHttpApp(config);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  closeCallbacks.push(async () => {
    (app.locals.closeRuntime as (() => void) | undefined)?.();
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
    expect(tools.tools.map((tool) => tool.name)).not.toContain("odoo_call_method");
  });

  it("serves the enrollment page with a CSP that permits its own submit fetch", async () => {
    const databasePath = join(tmpdir(), `odoo-mcp-test-oauth-${randomUUID()}.sqlite`);
    closeCallbacks.push(async () => rmSync(databasePath, { force: true }));
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
});
