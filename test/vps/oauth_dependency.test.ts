import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOAuthService } from "../../src/auth/oauth.js";
import { oauthDependencyBoundary } from "../../src/auth/dependencies.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";
import { createRuntimeServices } from "../../src/runtime/server.js";

describe("OAuth client discovery outages", () => {
  it.each(["missing", "unavailable", "timeout", "keys", "malformed"] as const)(
    "classifies %s without bypassing authentication or leaking concurrent requests", async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-oauth-dependency-"));
    const config = loadRuntimeConfig({
      ODOO_PUBLIC_ORIGIN: "https://odoo.example",
      ODOO_DATABASE: "test",
      MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_DATABASE: join(directory, "oauth.sqlite"),
      BETTER_AUTH_SECRET: "a-development-secret-that-is-long-enough-for-tests",
      MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
    });
    const services = createRuntimeServices(config);
    const oauth = createOAuthService(config, services, {
      fetchClientMetadataResource: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (String(input).includes("unknown.example")) return new Response(null, { status: 404 });
        if (scenario === "timeout") throw new Error("private provider failure");
        if (scenario === "malformed") return Response.json({ private: "provider response" });
        if (scenario === "keys" && String(input).endsWith("client.json")) return Response.json({
          client_id: String(input), client_name: "Synthetic client",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://client.example/jwks.json"
        });
        return new Response("private provider response", { status: scenario === "unavailable" ? 502 : 404 });
      }
    })!;
    try {
      await oauth.ready;
      oauth.vault.database.prepare(`INSERT INTO oauthClient
        (id, clientId, clientDiscoveryId, name, tokenEndpointAuthMethod, redirectUris, grantTypes, jwksUri)
        VALUES (?, ?, 'cimd', 'Synthetic client', 'none', ?, ?, 'https://client.example/jwks.json')`)
        .run("synthetic", "https://client.example/client.json", '["https://client.example/callback"]', '["authorization_code","refresh_token"]');
      const request = (clientId: string, correlationId: string) => oauth.authFetch(new Request(
        `${config.publicOrigin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Correlation-Id": correlationId },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: "synthetic-token" })
        }
      ));
      // Client assertions trigger discovery before token lookup, as in the incident.
      const assertionRequest = (clientId: string, correlationId: string) => oauth.authFetch(new Request(
        `${config.publicOrigin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Correlation-Id": correlationId },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId,
            refresh_token: "synthetic-token", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: clientId, iss: clientId })).toString("base64url")}.c2ln` })
        }
      ));
      const [response, unknown] = await Promise.all([
        assertionRequest("https://client.example/client.json", "incident-189-test"),
        assertionRequest("https://unknown.example/client.json", "unknown-client-test")
      ]);
      if (scenario === "malformed") {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_client", stage: "oauth_token" });
        return;
      }
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("X-Correlation-Id")).toBe("incident-189-test");
      const result = await response.json();
      expect(result).toMatchObject({ error: "temporarily_unavailable", correlation_id: "incident-189-test",
        stage: scenario === "keys" ? "oauth_client_jwks" : "oauth_client_metadata", outcome: "not_applied" });
      if (scenario === "timeout") expect(result).not.toHaveProperty("upstream_status");
      else expect(result.upstream_status).toBe(scenario === "unavailable" ? 502 : 404);
      expect(JSON.stringify(result)).not.toMatch(/private provider|client\.example|synthetic-token/);
      expect(oauth.vault.database.prepare("SELECT count(*) AS count FROM oauthClient").get()).toEqual({ count: 1 });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: "invalid_client", outcome: "not_applied",
        correlation_id: "unknown-client-test", stage: "oauth_token" });
      const invalid = await request("https://client.example/client.json", "invalid-grant-test");
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "invalid_grant", stage: "oauth_token", outcome: "not_applied" });
      if (scenario === "missing") {
        const boundary = oauthDependencyBoundary(oauth.vault, async () => Response.json({}));
        const request = new Request(`${config.publicOrigin}/api/auth/oauth2/token`, {
          headers: { "X-Correlation-Id": "x".repeat(129) }
        });
        let attempts = 0;
        const success = Response.json({ access_token: "synthetic-success" });
        expect(await boundary.run(request, async () => { attempts++; return success; })).toBe(success);
        const failure = await boundary.run(request, async () => { attempts++; throw new Error("private exception"); });
        expect(failure.status).toBe(500);
        const result = await failure.json();
        expect(result).toMatchObject({ error: "server_error", stage: "oauth_token", outcome: "unknown" });
        expect(result.correlation_id).toMatch(/^[a-f0-9-]{36}$/);
        expect(JSON.stringify(result)).not.toContain("private exception");
        expect(attempts).toBe(2);
      }
    } finally {
      await services.accessCache.close();
      oauth.close();
      await services.observability.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
