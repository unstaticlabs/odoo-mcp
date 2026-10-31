import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOAuthService } from "../../src/auth/oauth.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";
import { createRuntimeServices } from "../../src/runtime/server.js";

const verifier = "synthetic-native-pkce-verifier-for-loopback-qualification-12345";
const challenge = createHash("sha256").update(verifier).digest("base64url");

// Exercise the application's real Better Auth handler, rather than matching
// strings in the dependency's generated source. No callback is fetched.
describe("native OAuth loopback redirects", () => {
  it.each([
    ["localhost", "http://localhost/callback", "http://localhost:41981/callback", true],
    ["IPv4", "http://127.0.0.1/callback", "http://127.0.0.1:41982/callback", true],
    ["IPv6", "http://[::1]/callback", "http://[::1]:41983/callback", true],
    ["PKCE lifecycle", "http://localhost/callback", "http://localhost:41984/callback", true],
    ["different hostname", "http://localhost/callback", "http://127.0.0.1:41981/callback", false],
    ["different path", "http://localhost/callback", "http://localhost:41981/other", false],
    ["different query", "http://localhost/callback?fixture=one", "http://localhost:41981/callback?fixture=two", false]
  ] as const)("%s: only the loopback port may change", async (_label, registered, requested, accepted) => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-native-loopback-"));
    const config = loadRuntimeConfig({
      ODOO_PUBLIC_ORIGIN: "https://odoo.example", ODOO_DATABASE: "synthetic",
      MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000", MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_DATABASE: join(directory, "oauth.sqlite"),
      BETTER_AUTH_SECRET: "synthetic-local-oauth-secret-long-enough-for-tests",
      MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
    });
    const services = createRuntimeServices(config);
    const oauth = createOAuthService(config, services)!;
    const cookies = new Map<string, string>();
    const request = async (path: string, body?: Record<string, unknown>) => {
      const response = await oauth.authFetch(new Request(`${config.publicOrigin}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: { Origin: config.publicOrigin, "Content-Type": "application/json",
          Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") },
        ...(body ? { body: JSON.stringify(body) } : {})
      }));
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const separator = pair!.indexOf("=");
        cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
      }
      return response;
    };
    try {
      await oauth.ready;
      const enrollmentId = "synthetic-loopback-enrollment";
      oauth.vault.upsert({ enrollmentId, targetId: config.targets[0]!.id,
        publicOrigin: "https://odoo.example", database: "synthetic", apiKey: "synthetic-offline-key",
        odooUserId: 1, displayName: "Synthetic Loopback Operator" });
      const email = oauth.vault.internalEmail(enrollmentId);
      const signup = await request("/sign-up/email", {
        name: "Synthetic Loopback Operator", email,
        password: "Synthetic-only-password-123!"
      });
      expect(signup.status).toBe(200);
      expect(cookies.size).toBeGreaterThan(0);
      const userId = oauth.vault.userIdForEmail(email);
      expect(userId).toBeTruthy();
      oauth.vault.attachUser(enrollmentId, userId!);
      // DCR is disabled in the application. Seed native registration records;
      // the real handler still validates redirects, session, consent and PKCE.
      const clientId = "synthetic-loopback";
      oauth.vault.database.prepare(`INSERT INTO oauthClient
        (id, clientId, name, tokenEndpointAuthMethod, redirectUris, grantTypes, requirePKCE, skipConsent)
        VALUES ('synthetic', ?, 'Synthetic native client', 'none', ?, ?, 1, 0)`)
        .run(clientId, JSON.stringify([registered]), '["authorization_code","refresh_token"]');
      expect(oauth.vault.database.prepare("SELECT identifier FROM oauthResource WHERE identifier = ?")
        .get(`${config.publicOrigin}/mcp`)).toEqual({ identifier: `${config.publicOrigin}/mcp` });
      oauth.vault.database.prepare(`INSERT INTO oauthClientResource (id, clientId, resourceId)
        VALUES ('synthetic-link', ?, ?)`).run(clientId, `${config.publicOrigin}/mcp`);
      const query = new URLSearchParams({ client_id: clientId, response_type: "code",
        redirect_uri: requested, scope: "odoo offline_access", resource: `${config.publicOrigin}/mcp`, state: "synthetic-state",
        code_challenge: challenge, code_challenge_method: "S256" });
      const authorization = await request(`/oauth2/authorize?${query}`);
      expect(authorization.status).toBe(302);
      const location = new URL(authorization.headers.get("Location")!, config.publicOrigin);
      if (!accepted) {
        expect(location.origin).toBe(config.publicOrigin);
        expect(location.searchParams.get("error")).toBe("invalid_redirect");
        expect(location.searchParams.has("code")).toBe(false);
        return;
      }
      expect(location.searchParams.get("error"), location.searchParams.get("error_description") ?? "").toBe(null);
      expect(location.origin).toBe(config.publicOrigin);
      expect(location.pathname).toBe("/oauth/consent");
      const consent = await request("/oauth2/consent", { accept: true, oauth_query: location.search.slice(1) });
      expect(consent.status).toBe(200);
      const continuation = await consent.json() as { url?: string; redirect_uri?: string; redirectUri?: string };
      const callback = new URL(continuation.url ?? continuation.redirect_uri ?? continuation.redirectUri!);
      const destination = new URL(requested);
      expect(callback.origin).toBe(destination.origin);
      expect(callback.pathname).toBe(destination.pathname);
      expect(callback.searchParams.get("state")).toBe("synthetic-state");
      expect(callback.searchParams.get("code")).toBeTruthy();
      expect(callback.searchParams.has("error")).toBe(false);
      if (_label === "PKCE lifecycle") {
        const formRequest = (endpoint: string, body: Record<string, string>) => oauth.authFetch(new Request(
          `${config.publicOrigin}/api/auth/oauth2/${endpoint}`, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, ...body })
          }
        ));
        const exchanged = await formRequest("token", {
          grant_type: "authorization_code", code: callback.searchParams.get("code")!,
          redirect_uri: requested, code_verifier: verifier, resource: `${config.publicOrigin}/mcp`
        });
        expect(exchanged.status).toBe(200);
        const tokens = await exchanged.json() as { access_token: string; refresh_token: string; token_type: string };
        expect(tokens.token_type.toLowerCase()).toBe("bearer");
        expect(tokens.access_token).toBeTruthy();
        expect(tokens.refresh_token).toBeTruthy();
        const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString());
        expect(claims.odoo_enrollment_id).toBe(enrollmentId);
        expect(claims.aud).toContain(`${config.publicOrigin}/mcp`);

        // A second real code is still bound to its original S256 challenge.
        // Previously granted consent may allow the native handler to skip it.
        const next = await request(`/oauth2/authorize?${query}`);
        expect(next.status).toBe(302);
        let nextCallback = new URL(next.headers.get("Location")!, config.publicOrigin);
        if (nextCallback.pathname === "/oauth/consent") {
          const allowed = await request("/oauth2/consent", { accept: true, oauth_query: nextCallback.search.slice(1) });
          expect(allowed.status).toBe(200);
          const payload = await allowed.json() as { url?: string; redirect_uri?: string; redirectUri?: string };
          nextCallback = new URL(payload.url ?? payload.redirect_uri ?? payload.redirectUri!);
        }
        expect(nextCallback.searchParams.get("code")).toBeTruthy();
        const wrong = await formRequest("token", {
          grant_type: "authorization_code", code: nextCallback.searchParams.get("code")!,
          redirect_uri: requested, code_verifier: `${verifier}-wrong`, resource: `${config.publicOrigin}/mcp`
        });
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });

        const refreshed = await formRequest("token", {
          grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: `${config.publicOrigin}/mcp`
        });
        expect(refreshed.status).toBe(200);
        const renewed = await refreshed.json() as { access_token: string; refresh_token: string };
        expect(renewed.access_token).toBeTruthy();
        expect(renewed.refresh_token).toBeTruthy();
        const revoked = await formRequest("revoke", { token: renewed.refresh_token, token_type_hint: "refresh_token" });
        expect(revoked.status).toBe(200);
        const reuse = await formRequest("token", {
          grant_type: "refresh_token", refresh_token: renewed.refresh_token, resource: `${config.publicOrigin}/mcp`
        });
        expect(reuse.status).toBe(400);
        expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
      }
    } finally {
      await services.accessCache.close();
      oauth.close();
      await services.observability.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
