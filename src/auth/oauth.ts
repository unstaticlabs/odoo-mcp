import { randomBytes } from "node:crypto";
import { setDefaultAutoSelectFamily } from "node:net";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { betterAuth, type BetterAuthOptions, type JWTPayload } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import { z } from "zod";
import { createRequestContext, type ProfileName } from "../runtime/context.js";
import { resolveDirectConnection, type RuntimeConfig } from "../runtime/config.js";
import { emitEvent } from "../runtime/logging.js";
import type { RuntimeServices } from "../runtime/server.js";
import { loadAgentIdentity } from "../odoo/agent_identity.js";
import { CredentialVault, type ValidatedEnrollment } from "./vault.js";

// Node enables socket family autoselection (RFC 8305) by default since v20.
// An autoselecting socket calls its custom DNS `lookup` with `all: true` and
// expects an address array; the @better-auth/cimd node transport pins one
// DNS answer through a `lookup` callback that returns a scalar. The socket
// then dials `undefined` and every CIMD metadata fetch fails with
// ERR_INVALID_IP_ADDRESS before it reaches the network, so a hosted CIMD
// client (ChatGPT sends client_id=https://chatgpt.com/oauth/client.json)
// cannot authorize at all. Verified against @better-auth/cimd@1.7.2 on
// Node 24. A per-request opt-out is not possible: the transport builds its
// own request options. Remove this when the upstream transport honors the
// `all` callback contract or sets `autoSelectFamily: false` itself.
setDefaultAutoSelectFamily(false);

const EnrollmentInputSchema = z.object({
  odooUrl: z.string().url().max(2048),
  database: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(8192),
  oauthQuery: z.string().min(1).max(16_384)
}).strict();

export interface OAuthService {
  readonly vault: CredentialVault;
  readonly ready: Promise<void>;
  authFetch(request: Request): Promise<Response>;
  enrollmentFetch(request: Request): Promise<Response>;
  consentFetch(request: Request): Promise<Response>;
  revokeFetch(request: Request): Promise<Response>;
  protectMcp(
    profile: ProfileName,
    handler: { fetch(request: Request, options?: { authInfo?: AuthInfo }): Promise<Response> }
  ): { fetch(request: Request): Promise<Response> };
  close(): void;
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

function html(document: string, nonce: string): Response {
  return new Response(document, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // connect-src covers the pages' own same-origin fetch submissions
      // (enroll, consent, revoke). Without it the browser falls back to
      // default-src 'none' and blocks the submit, so hosted enrollment
      // cannot complete at all.
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function page(title: string, content: string, script: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f7; color: #17202a; }
    main { box-sizing: border-box; width: min(34rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #d7dce2; border-radius: .75rem; background: white; box-shadow: 0 .5rem 2rem #17202a14; }
    h1 { margin-top: 0; font-size: 1.5rem; } p, label { line-height: 1.5; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; margin-top: .35rem; padding: .7rem; border: 1px solid #aeb7c2; border-radius: .4rem; font: inherit; }
    button { margin-top: 1.25rem; padding: .7rem 1rem; border: 0; border-radius: .4rem; background: #714b67; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    button[disabled] { opacity: .55; cursor: wait; } #message { min-height: 1.5rem; color: #9d1c20; }
    code { font-size: .9em; }
    @media (prefers-color-scheme: dark) { body { background: #11151a; color: #eef2f5; } main { background: #1b222a; border-color: #3b4652; } }
  </style>
</head>
<body><main>${content}</main><script nonce="${nonce}">${script}</script></body>
</html>`;
}

export function redirectFromAuthPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["url", "redirect_uri", "redirectUri"]) {
    if (typeof record[key] !== "string") continue;
    const value = record[key].trim();
    if (/^\/(?!\/)/.test(value)) return value;
    try {
      const destination = new URL(value);
      if (destination.protocol === "https:" || destination.protocol === "http:") return value;
    } catch {
      // Try the next supported response field.
    }
  }
  return null;
}

function bearerAuthInfo(claims: JWTPayload, principal: ReturnType<CredentialVault["resolve"]>, request: Request): AuthInfo {
  const scope = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
  const clientId = typeof claims.client_id === "string"
    ? claims.client_id
    : typeof claims.azp === "string" ? claims.azp : "oauth";
  const correlation = request.headers.get("X-Correlation-Id")?.trim();
  const correlationId = correlation && /^[A-Za-z0-9._-]{1,128}$/.test(correlation)
    ? correlation
    : crypto.randomUUID();
  return {
    token: "oauth-bearer",
    clientId,
    scopes: scope,
    ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
    extra: {
      odoo: principal,
      requestId: crypto.randomUUID(),
      correlationId
    }
  };
}

export function createOAuthService(config: RuntimeConfig, services: RuntimeServices): OAuthService | null {
  const oauth = config.oauth;
  if (!oauth) return null;
  const vault = new CredentialVault(oauth, config);
  const resource = `${config.publicOrigin}/mcp`;

  const authOptions = {
    database: vault.database,
    secret: oauth.authSecret,
    baseURL: config.publicOrigin,
    basePath: "/api/auth",
    trustedOrigins: oauth.trustedOrigins,
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/oauth/enroll",
        consentPage: "/oauth/consent",
        resource,
        scopes: ["openid", "profile", "email", "offline_access", "odoo"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: oauth.accessTokenSeconds,
        refreshTokenExpiresIn: oauth.refreshTokenSeconds,
        customAccessTokenClaims: ({ user }) => {
          if (!user?.email) throw new Error("An Odoo enrollment is required for this OAuth grant");
          const enrollmentId = vault.enrollmentIdForEmail(user.email);
          if (!enrollmentId) throw new Error("The Odoo enrollment was revoked or no longer exists");
          vault.resolve(enrollmentId);
          return { odoo_enrollment_id: enrollmentId };
        }
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28"
      })
    ]
  } satisfies BetterAuthOptions;
  const auth = betterAuth(authOptions);
  const ready = getMigrations(authOptions)
    .then((migrations) => migrations.runMigrations())
    .then(async () => { await auth.$context; });

  async function callCredentialEndpoint(path: "/sign-up/email" | "/sign-in/email", body: object, source: Request): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json"
    });
    const cookie = source.headers.get("Cookie");
    if (cookie) headers.set("Cookie", cookie);
    return await auth.handler(new Request(`${config.publicOrigin}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: source.signal
    }));
  }

  async function validateEnrollment(input: z.infer<typeof EnrollmentInputSchema>, request: Request): Promise<ValidatedEnrollment> {
    const principal = resolveDirectConnection(config, new Headers({
      "X-Odoo-Url": input.odooUrl,
      "X-Odoo-Database": input.database,
      "X-Odoo-Api-Key": input.apiKey
    }));
    if (!principal) throw new Error("Unable to resolve the Odoo connection");
    const context = createRequestContext("default", principal);
    const identity = await loadAgentIdentity(services.client, context, request.signal);
    return {
      enrollmentId: vault.stableEnrollmentId(principal.targetId, principal.database, identity.user_id),
      targetId: principal.targetId,
      publicOrigin: principal.publicOrigin,
      database: principal.database,
      apiKey: principal.apiKey,
      odooUserId: identity.user_id,
      displayName: identity.agent.name
    };
  }

  async function enrollmentFetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const nonce = randomBytes(18).toString("base64url");
      return html(page(
        "Connect Odoo",
        `<h1>Connect an Odoo Agent</h1>
<p>Create an Agent in <strong>My Agents</strong>, then enter that Agent's API key. Your ChatGPT authorization remains separate from the Odoo identity that performs the work.</p>
<form id="enroll">
  <label>Odoo URL<input name="odooUrl" type="url" autocomplete="url" required placeholder="https://odoo.example"></label>
  <label>Database<input name="database" autocomplete="organization" required></label>
  <label>API key<input name="apiKey" type="password" autocomplete="current-password" required></label>
  <button type="submit">Connect Odoo</button>
  <p id="message" role="alert"></p>
</form>`,
        `const form = document.querySelector('#enroll');
const message = document.querySelector('#message');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = '';
  const fields = new FormData(form);
  try {
    const response = await fetch(location.pathname, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        odooUrl: fields.get('odooUrl'), database: fields.get('database'),
        apiKey: fields.get('apiKey'), oauthQuery: location.search.slice(1)
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'Connection failed');
    const candidate = data.url || data.redirect_uri || data.redirectUri;
    if (!candidate) throw new Error('The authorization server did not provide a continuation URL');
    const destination = new URL(candidate, location.origin);
    if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('The authorization server returned an invalid continuation URL');
    location.assign(destination.href);
  } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); button.disabled = false; }
});`,
        nonce
      ), nonce);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST" });
    await ready;
    const started = Date.now();
    try {
      const input = EnrollmentInputSchema.parse(await request.json());
      const enrollment = await validateEnrollment(input, request);
      vault.upsert(enrollment);
      const email = vault.internalEmail(enrollment.enrollmentId);
      const credentials = {
        email,
        password: vault.internalPassword(enrollment.enrollmentId),
        oauth_query: input.oauthQuery
      };
      let response = await callCredentialEndpoint("/sign-up/email", {
        ...credentials,
        name: enrollment.displayName
      }, request);
      if (!response.ok) response = await callCredentialEndpoint("/sign-in/email", credentials, request);
      if (!response.ok) return response;
      const userId = vault.userIdForEmail(email);
      if (!userId) return json({ error: "oauth_enrollment_failed", message: "The OAuth user record was not created" }, 500);
      vault.attachUser(enrollment.enrollmentId, userId);
      emitEvent("auth.enrollment.completed", {
        target_id: enrollment.targetId,
        status: "ok",
        duration_ms: Date.now() - started
      });
      const payload = await response.clone().json().catch(() => null) as unknown;
      if (!redirectFromAuthPayload(payload)) {
        return json({ error: "oauth_enrollment_failed", message: "The authorization flow did not return a continuation URL" }, 500);
      }
      return response;
    } catch (error) {
      emitEvent("auth.enrollment.completed", {
        status: "rejected",
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Error"
      });
      return json({
        error: "invalid_odoo_enrollment",
        message: error instanceof Error ? error.message : "Unable to validate the Odoo connection"
      }, 400);
    }
  }

  async function consentFetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
    const nonce = randomBytes(18).toString("base64url");
    return html(page(
      "Authorize Odoo MCP",
      `<h1>Authorize Odoo MCP</h1>
<p>This client will act through the Odoo identity you just connected. Odoo remains authoritative for every record and business operation.</p>
<button id="allow" type="button">Allow access</button>
<p id="message" role="alert"></p>`,
      `const button = document.querySelector('#allow');
const message = document.querySelector('#message');
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/oauth2/consent', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({accept: true, oauth_query: location.search.slice(1)})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'Authorization failed');
    const candidate = data.url || data.redirect_uri || data.redirectUri;
    if (!candidate) throw new Error('The authorization server did not provide a continuation URL');
    const destination = new URL(candidate, location.origin);
    if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('The authorization server returned an invalid continuation URL');
    location.assign(destination.href);
  } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); button.disabled = false; }
});`,
      nonce
    ), nonce);
  }

  async function revokeFetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const nonce = randomBytes(18).toString("base64url");
      return html(page(
        "Revoke Odoo MCP",
        `<h1>Disconnect Odoo MCP</h1><p>This immediately invalidates the stored Odoo enrollment and its MCP grants.</p><button id="revoke" type="button">Disconnect</button><p id="message" role="alert"></p>`,
        `const button = document.querySelector('#revoke'); const message = document.querySelector('#message');
button.addEventListener('click', async () => { button.disabled = true; const response = await fetch(location.pathname, {method:'POST'}); const data = await response.json(); message.textContent = response.ok ? 'Disconnected.' : (data.message || data.error); });`,
        nonce
      ), nonce);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST" });
    await ready;
    const cookie = request.headers.get("Cookie");
    if (!cookie) return json({ error: "authentication_required" }, 401);
    const sessionResponse = await auth.handler(new Request(`${config.publicOrigin}/api/auth/get-session`, {
      headers: { Cookie: cookie, Accept: "application/json" },
      signal: request.signal
    }));
    const session = await sessionResponse.json().catch(() => null) as { user?: { id?: unknown } } | null;
    const userId = typeof session?.user?.id === "string" ? session.user.id : null;
    if (!userId) return json({ error: "authentication_required" }, 401);
    const revoked = vault.revokeUser(userId);
    await auth.handler(new Request(`${config.publicOrigin}/api/auth/sign-out`, {
      method: "POST",
      headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
      signal: request.signal
    }));
    emitEvent("auth.enrollment.revoked", { status: revoked ? "ok" : "not_found" });
    return json({ revoked });
  }

  function protectMcp(
    profile: ProfileName,
    handler: { fetch(request: Request, options?: { authInfo?: AuthInfo }): Promise<Response> }
  ) {
    const protectedHandler = requireMcpAuth(auth, async (request, claims) => {
      const enrollmentId = typeof claims.odoo_enrollment_id === "string" ? claims.odoo_enrollment_id : null;
      if (!enrollmentId) return json({ error: "invalid_token", message: "The token has no Odoo enrollment" }, 401);
      const started = Date.now();
      try {
        const principal = vault.resolve(enrollmentId);
        const authInfo = bearerAuthInfo(claims, principal, request);
        await loadAgentIdentity(
          services.client,
          createRequestContext(profile, principal, authInfo),
          request.signal,
        );
        const requestId = typeof authInfo.extra?.requestId === "string" ? authInfo.extra.requestId : undefined;
        const correlationId = typeof authInfo.extra?.correlationId === "string" ? authInfo.extra.correlationId : undefined;
        emitEvent("auth.resolved", {
          request_id: requestId,
          correlation_id: correlationId,
          target_id: principal.targetId,
          auth_mode: "oauth",
          profile,
          status: "ok",
          duration_ms: Date.now() - started
        });
        return await handler.fetch(request, { authInfo });
      } catch (error) {
        emitEvent("auth.resolved", {
          auth_mode: "oauth",
          profile,
          status: "rejected",
          duration_ms: Date.now() - started,
          error_name: error instanceof Error ? error.name : "Error"
        });
        return json({ error: "invalid_token", message: error instanceof Error ? error.message : "Invalid Odoo enrollment" }, 401);
      }
    }, { resource, requiredScopes: ["odoo"] });
    return { fetch: async (request: Request) => { await ready; return await protectedHandler(request); } };
  }

  return {
    vault,
    ready,
    authFetch: async (request) => { await ready; return await auth.handler(request); },
    enrollmentFetch,
    consentFetch,
    revokeFetch,
    protectMcp,
    close: () => vault.close()
  };
}
