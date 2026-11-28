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
import { AgentAccessWarmingError } from "../runtime/agent_access_cache.js";
import { createRequestContext, type OdooPrincipal, type ProfileName } from "../runtime/context.js";
import { resolveDirectConnection, type RuntimeConfig } from "../runtime/config.js";
import { emitEvent } from "../runtime/logging.js";
import type { RuntimeServices } from "../runtime/server.js";
import { CredentialVault, type ValidatedEnrollment } from "./vault.js";
import { oauthDependencyBoundary } from "./dependencies.js";
import { migrateLegacyAccountIssuer } from "./migrations.js";
import { verifyOAuthQueryParams, type ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

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

// Contract with the Odoo module `usl_access_control`. Odoo checks a fresh
// identity, lets the owner select an Agent, and returns a one-time code. The
// code is useless without the verifier that only this process holds.
const ODOO_CONNECT_PATH = "/usl/agent-access/connect";
const ODOO_TOKEN_PATH = "/usl/agent-access/token";
const HANDOFF_MAX_SECONDS = 600;
const HANDOFF_MIN_SECONDS = 30;
const HANDOFF_EXCHANGE_TIMEOUT_MS = 15_000;
const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const HandoffTokenSchema = z.object({
  api_key: z.string().min(1).max(8192)
});

class HandoffExchangeError extends Error {
  constructor(readonly upstreamStatus: number | null) {
    super("Odoo did not accept the connection code");
    this.name = "HandoffExchangeError";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function oauthClientLabel(clientId: string | null, registeredName: string | null): string {
  let label = registeredName ?? "";
  if (!label && clientId) {
    try {
      label = new URL(clientId).hostname;
    } catch {
      label = clientId;
    }
  }
  label = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return label || "MCP client";
}

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

export function credentialEndpointHeaders(publicOrigin: string, source: Request): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    // This is a server-side request to our own Better Auth endpoint. It does
    // not inherit browser headers automatically, but Better Auth still
    // requires the configured trusted origin for CSRF validation.
    Origin: publicOrigin
  });
  const cookie = source.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  return headers;
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

export function createOAuthService(
  config: RuntimeConfig,
  services: RuntimeServices,
  dependencies: { fetchClientMetadataResource?: ClientMetadataResourceFetch; fetch?: typeof fetch } = {}
): OAuthService | null {
  const oauth = config.oauth;
  if (!oauth) return null;
  const vault = new CredentialVault(oauth, config);
  try {
    migrateLegacyAccountIssuer(vault.database);
  } catch (error) {
    vault.close();
    throw error;
  }
  const dependencyBoundary = oauthDependencyBoundary(vault, dependencies.fetchClientMetadataResource ?? fetchClientMetadataResource);
  services.accessCache.setPersistentStore(vault);
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
        fetchClientMetadataResource: dependencyBoundary.fetchResource,
        metadataProfile: "mcp-2026-07-28"
      })
    ]
  } satisfies BetterAuthOptions;
  const initializedAuth = getMigrations(authOptions)
    .then((migrations) => migrations.runMigrations())
    .then(async () => {
      // Native validation starts during construction, so initialize only after
      // the schema exists. Keep validation enabled for the resulting runtime.
      const auth = betterAuth(authOptions);
      await auth.$context;
      return auth;
    });
  const ready = initializedAuth.then(() => undefined);

  async function callCredentialEndpoint(path: "/sign-up/email" | "/sign-in/email", body: object, source: Request): Promise<Response> {
    await ready;
    const auth = await initializedAuth;
    return await auth.handler(new Request(`${config.publicOrigin}/api/auth${path}`, {
      method: "POST",
      headers: credentialEndpointHeaders(config.publicOrigin, source),
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
    context.eventObserver = services.observability;
    context.analyticsPrincipalId = services.observability.principalId(principal);
    const snapshot = await services.accessCache.initialize(context, request.signal, {
      requireSurface: true,
      timeoutMs: config.accessRefreshTimeoutMs
    });
    const identity = snapshot.identity;
    services.accessCache.touch(context);
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

  const handoffCookie = config.publicOrigin.startsWith("https://") ? "__Host-odoo_enroll" : "odoo_enroll";

  function messagePage(status: number, title: string, content: string, headers?: HeadersInit): Response {
    const nonce = randomBytes(18).toString("base64url");
    const response = html(page(title, `<h1>${escapeHtml(title)}</h1>${content}`, "", nonce), nonce);
    const merged = new Headers(response.headers);
    for (const [name, value] of new Headers(headers)) merged.set(name, value);
    return new Response(response.body, { status, headers: merged });
  }

  /**
   * Send the browser to Odoo instead of the manual API key form. Return null
   * when the handoff does not apply; the caller then shows the manual form.
   */
  async function startHandoff(request: Request, url: URL): Promise<Response | null> {
    const handoff = oauth!.odooHandoff;
    const oauthQuery = url.search.slice(1);
    if (!handoff || !oauthQuery || oauthQuery.length > 16_384) return null;
    // Only a query that this server signed can start a handoff. This keeps
    // the client name honest and stops a foreign page from starting one.
    if (!await verifyOAuthQueryParams(oauthQuery, oauth!.authSecret)) return null;
    const parameters = new URLSearchParams(oauthQuery);
    const remaining = Number(parameters.get("exp")) - Math.floor(Date.now() / 1000);
    if (!(remaining >= HANDOFF_MIN_SECONDS)) return null;
    const ttlSeconds = Math.min(HANDOFF_MAX_SECONDS, remaining);
    const existing = cookieValue(request, handoffCookie);
    let pending;
    try {
      pending = vault.createHandoff(
        oauthQuery,
        ttlSeconds,
        existing && HANDOFF_TOKEN_PATTERN.test(existing) ? existing : undefined
      );
    } catch {
      return messagePage(503, "Try again in a moment", "<p>Too many connections wait for Odoo now.</p>", { "Retry-After": "60" });
    }
    const clientId = parameters.get("client_id");
    const destination = new URL(ODOO_CONNECT_PATH, handoff.publicOrigin);
    destination.searchParams.set("state", pending.state);
    destination.searchParams.set("code_challenge", pending.codeChallenge);
    destination.searchParams.set("return_url", `${config.publicOrigin}/oauth/enroll/callback`);
    destination.searchParams.set(
      "client_name",
      oauthClientLabel(clientId, clientId ? vault.clientDisplayName(clientId) : null)
    );
    emitEvent("auth.enrollment.handoff", { target_id: handoff.targetId, status: "started" });
    return new Response(null, {
      status: 302,
      headers: {
        Location: destination.href,
        "Set-Cookie": `${handoffCookie}=${pending.binding}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; SameSite=Lax${config.publicOrigin.startsWith("https://") ? "; Secure" : ""}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      }
    });
  }

  /** Server-to-server exchange. The API key never reaches the browser. */
  async function exchangeHandoffCode(code: string, codeVerifier: string, signal: AbortSignal): Promise<string> {
    const handoff = oauth!.odooHandoff!;
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(`${handoff.internalOrigin}${ODOO_TOKEN_PATH}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Odoo-Database": handoff.database
        },
        body: new URLSearchParams({ code, code_verifier: codeVerifier }).toString(),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(HANDOFF_EXCHANGE_TIMEOUT_MS)])
      });
    } catch {
      throw new HandoffExchangeError(null);
    }
    if (!response.ok) throw new HandoffExchangeError(response.status);
    const parsed = HandoffTokenSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new HandoffExchangeError(response.status);
    return parsed.data.api_key;
  }

  async function handoffCallback(request: Request, url: URL): Promise<Response> {
    const started = Date.now();
    const handoff = oauth!.odooHandoff;
    const state = url.searchParams.get("state") ?? "";
    const binding = cookieValue(request, handoffCookie) ?? "";
    await ready;
    const pending = handoff && HANDOFF_TOKEN_PATTERN.test(state) && HANDOFF_TOKEN_PATTERN.test(binding)
      ? vault.consumeHandoff(state, binding)
      : null;
    if (!handoff || !pending) {
      emitEvent("auth.enrollment.handoff", { status: "rejected", error_name: "unknown_state" });
      return messagePage(
        400,
        "Connection request expired",
        "<p>This connection request is not valid, is expired, or was used before. Start the connection again from your MCP client.</p>"
      );
    }
    const retryHref = escapeHtml(`/oauth/enroll?${pending.oauthQuery}`);
    const manualHref = `/oauth/enroll/manual?${pending.oauthQuery}`;
    const choices = `<p><a href="${retryHref}">Try again with Odoo</a></p><p><a href="${escapeHtml(manualHref)}">Enter an Agent API key by hand</a></p>`;
    const error = url.searchParams.get("error");
    if (error === "manual_entry") {
      return new Response(null, { status: 302, headers: { Location: manualHref, "Cache-Control": "no-store" } });
    }
    if (error) {
      emitEvent("auth.enrollment.handoff", { target_id: handoff.targetId, status: "cancelled" });
      return messagePage(200, "Connection cancelled", `<p>Odoo did not connect an Agent. No API key was stored.</p>${choices}`);
    }
    const code = url.searchParams.get("code") ?? "";
    try {
      if (!HANDOFF_TOKEN_PATTERN.test(code)) throw new HandoffExchangeError(null);
      const apiKey = await exchangeHandoffCode(code, pending.codeVerifier, request.signal);
      const response = await completeEnrollment({
        odooUrl: handoff.publicOrigin,
        database: handoff.database,
        apiKey,
        oauthQuery: pending.oauthQuery
      }, request, started);
      const payload = await response.clone().json().catch(() => null) as unknown;
      const location = response.ok ? redirectFromAuthPayload(payload) : null;
      if (!location) {
        return messagePage(502, "Connection failed", `<p>The authorization flow did not continue.</p>${choices}`);
      }
      const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
      // Better Auth signs the user in through these cookies.
      for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return new Response(null, { status: 302, headers });
    } catch (error) {
      emitEvent("auth.enrollment.completed", {
        status: "rejected",
        method: "handoff",
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Error",
        ...(error instanceof HandoffExchangeError && error.upstreamStatus !== null
          ? { upstream_status: error.upstreamStatus }
          : {})
      });
      if (error instanceof AgentAccessWarmingError) {
        return messagePage(
          503,
          "Odoo is not ready",
          `<p>${escapeHtml(error.message)}</p>${choices}`,
          { "Retry-After": String(error.retryAfterSeconds) }
        );
      }
      return messagePage(
        error instanceof HandoffExchangeError ? 502 : 400,
        "Connection failed",
        `<p>${escapeHtml(error instanceof Error ? error.message : "Unable to validate the Odoo connection")}</p>${choices}`
      );
    }
  }

  /**
   * Validate the key, store it in the vault, and sign the internal OAuth user
   * in. Both the manual form and the Odoo handoff end here.
   */
  async function completeEnrollment(
    input: z.infer<typeof EnrollmentInputSchema>,
    request: Request,
    started: number
  ): Promise<Response> {
    const enrollment = await validateEnrollment(input, request);
    vault.upsert(enrollment);
    const enrolledPrincipal: OdooPrincipal = {
      ...resolveDirectConnection(config, new Headers({
        "X-Odoo-Url": input.odooUrl,
        "X-Odoo-Database": input.database,
        "X-Odoo-Api-Key": input.apiKey
      }))!,
      authMode: "oauth",
      enrollmentId: enrollment.enrollmentId
    };
    services.accessCache.persistCurrent(createRequestContext("default", enrolledPrincipal));
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
  }

  async function enrollmentFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/oauth/enroll/callback") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
      return await handoffCallback(request, url);
    }
    const manual = url.pathname === "/oauth/enroll/manual";
    if (manual && request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
    if (request.method === "GET") {
      if (!manual) {
        await ready;
        const redirect = await startHandoff(request, url);
        if (redirect) return redirect;
      }
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
    const response = await fetch('/oauth/enroll', {
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
      return await completeEnrollment(input, request, started);
    } catch (error) {
      emitEvent("auth.enrollment.completed", {
        status: "rejected",
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Error"
      });
      if (error instanceof AgentAccessWarmingError) {
        return json(
          { error: "surface_warming", message: error.message },
          503,
          { "Retry-After": String(error.retryAfterSeconds) }
        );
      }
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
    const auth = await initializedAuth;
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
    let protectedHandler: ReturnType<typeof requireMcpAuth> | undefined;
    const handleAuthorizedRequest = async (request: Request, claims: JWTPayload) => {
      const enrollmentId = typeof claims.odoo_enrollment_id === "string" ? claims.odoo_enrollment_id : null;
      if (!enrollmentId) return json({ error: "invalid_token", message: "The token has no Odoo enrollment" }, 401);
      const started = Date.now();
      try {
        const principal = vault.resolve(enrollmentId);
        const authInfo = bearerAuthInfo(claims, principal, request);
        const context = createRequestContext(profile, principal, authInfo);
        context.eventObserver = services.observability;
        context.analyticsPrincipalId = services.observability.principalId(principal);
        await services.accessCache.initialize(context, request.signal, {
          requireSurface: true,
          timeoutMs: Math.min(5_000, config.accessRefreshTimeoutMs)
        });
        services.accessCache.touch(context);
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
        if (error instanceof AgentAccessWarmingError) {
          return json(
            { error: "surface_warming", message: error.message },
            503,
            { "Retry-After": String(error.retryAfterSeconds) }
          );
        }
        return json({ error: "invalid_token", message: error instanceof Error ? error.message : "Invalid Odoo enrollment" }, 401);
      }
    };
    return { fetch: async (request: Request) => {
      await ready;
      const auth = await initializedAuth;
      protectedHandler ??= requireMcpAuth(auth, handleAuthorizedRequest, { resource, requiredScopes: ["odoo"] });
      return await protectedHandler(request);
    } };
  }

  return {
    vault,
    ready,
    authFetch: async (request) => {
      await ready;
      const auth = await initializedAuth;
      return await dependencyBoundary.run(request, auth.handler);
    },
    enrollmentFetch,
    consentFetch,
    revokeFetch,
    protectMcp,
    close: () => vault.close()
  };
}
