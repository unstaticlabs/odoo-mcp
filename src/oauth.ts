import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { callOdoo, type OdooConnection } from "./odoo";
import { escapeHtml } from "./tools/shared";
import type { Env, Props } from "./server";

/**
 * OAuth shim for clients that cannot send static BYO-key headers (ChatGPT).
 *
 * This module is the "identity provider" side of the shim: /authorize renders a
 * form where the user pastes their own Odoo URL + database + API key. We verify
 * the credentials with a real (lightweight) Odoo call, then hand them to
 * @cloudflare/workers-oauth-provider as grant `props`. The provider encrypts
 * props at rest and decrypts them back into `ctx.props` on token-authenticated
 * /mcp requests, so everything downstream sees the exact same `Props` shape the
 * header path produces.
 *
 * The plaintext API key exists only inside a single request: form POST →
 * validation call → completeAuthorization(). It is never logged, echoed back
 * into the form, or stored unencrypted.
 */

/** Shorter than the tool-call timeout: this runs inside an interactive form submit. */
const VALIDATION_TIMEOUT_MS = 8_000;

/**
 * Cheapest call that still proves url+db+key are valid together: fields_get on
 * res.users is readable by every authenticated Odoo user and returns 401/404
 * for a bad key, database, or host.
 */
export async function validateOdooCredentials(conn: OdooConnection): Promise<void> {
  await callOdoo(conn, "res.users", "fields_get", { attributes: ["type"] }, VALIDATION_TIMEOUT_MS);
}

function encodeOauthReq(authRequest: AuthRequest): string {
  return btoa(JSON.stringify(authRequest));
}

function decodeOauthReq(encoded: string): AuthRequest {
  return JSON.parse(atob(encoded)) as AuthRequest;
}

interface AuthorizePageOptions {
  authRequest: AuthRequest;
  clientName: string;
  error?: string;
  odooUrl?: string;
  odooDb?: string;
}

/** The API key input is intentionally never re-filled after a failed attempt. */
function renderAuthorizePage(opts: AuthorizePageOptions): Response {
  const { authRequest, clientName, error, odooUrl, odooDb } = opts;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Odoo &middot; odoo-mcp</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f2ee; margin: 0;
         display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 2rem; margin-top: 8vh;
          width: 100%; max-width: 26rem; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
  h1 { font-size: 1.2rem; margin: 0 0 .4rem; }
  p.sub { color: #555; font-size: .88rem; margin: 0 0 1.2rem; }
  label { display: block; font-size: .82rem; font-weight: 600; margin: .9rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .55rem .6rem; font-size: .95rem;
          border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 1.4rem; width: 100%; padding: .65rem; font-size: 1rem; border: 0; border-radius: 6px;
           background: #714b67; color: #fff; cursor: pointer; }
  button:hover { background: #5d3d55; }
  .error { background: #fdecea; border: 1px solid #f5c6c2; color: #92322a; border-radius: 6px;
           padding: .6rem .8rem; font-size: .86rem; margin-bottom: .5rem; }
  .note { color: #777; font-size: .78rem; margin-top: 1rem; }
</style>
</head>
<body>
<main class="card">
  <h1>Connect ${escapeHtml(clientName)} to Odoo</h1>
  <p class="sub">Enter your own Odoo credentials. They are checked against your Odoo instance,
  stored encrypted, and used only to proxy this client's requests as <em>your</em> Odoo user.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/authorize">
    <input type="hidden" name="oauth_req" value="${escapeHtml(encodeOauthReq(authRequest))}">
    <label for="odoo_url">Odoo URL</label>
    <input id="odoo_url" name="odoo_url" type="url" required placeholder="https://your-org.odoo.com"
           value="${escapeHtml(odooUrl ?? "")}">
    <label for="odoo_db">Database</label>
    <input id="odoo_db" name="odoo_db" type="text" required placeholder="your-db"
           value="${escapeHtml(odooDb ?? "")}">
    <label for="odoo_api_key">API key</label>
    <input id="odoo_api_key" name="odoo_api_key" type="password" required autocomplete="off"
           placeholder="Odoo &rarr; Preferences &rarr; Account Security &rarr; API Keys">
    <button type="submit">Verify &amp; connect</button>
  </form>
  <p class="note">Your API key encodes your own Odoo permissions &mdash; this connection can never do
  more in Odoo than your user can.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: opts.error ? 400 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function lookupClientName(env: Env, clientId: string): Promise<string> {
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(clientId);
    return client?.clientName || client?.clientId || "this client";
  } catch {
    return "this client";
  }
}

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return new Response("Invalid authorization request", { status: 400 });
  }
  if (!authRequest.clientId) {
    return new Response("Invalid authorization request", { status: 400 });
  }
  const clientName = await lookupClientName(env, authRequest.clientId);
  return renderAuthorizePage({ authRequest, clientName });
}

async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Invalid form submission", { status: 400 });
  }

  let authRequest: AuthRequest;
  try {
    authRequest = decodeOauthReq(String(form.get("oauth_req") ?? ""));
    if (!authRequest.clientId || !authRequest.redirectUri) throw new Error("incomplete");
  } catch {
    return new Response("Invalid or expired authorization request — restart the flow from your client", {
      status: 400
    });
  }
  const clientName = await lookupClientName(env, authRequest.clientId);

  const rawUrl = String(form.get("odoo_url") ?? "").trim();
  const odooDb = String(form.get("odoo_db") ?? "").trim();
  const odooApiKey = String(form.get("odoo_api_key") ?? "").trim();

  let odooBaseUrl: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
    odooBaseUrl = parsed.origin;
  } catch {
    return renderAuthorizePage({
      authRequest,
      clientName,
      error: "The Odoo URL must be a valid http(s) URL, e.g. https://your-org.odoo.com",
      odooDb
    });
  }

  if (!odooDb || !odooApiKey) {
    return renderAuthorizePage({
      authRequest,
      clientName,
      error: "Database and API key are required",
      odooUrl: odooBaseUrl
    });
  }

  try {
    await validateOdooCredentials({ url: odooBaseUrl, db: odooDb, apiKey: odooApiKey });
  } catch (err) {
    // callOdoo error messages never contain the API key (see src/odoo.ts).
    const detail = err instanceof Error ? err.message : "unknown error";
    return renderAuthorizePage({
      authRequest,
      clientName,
      error: `Odoo rejected these credentials or could not be reached — check the URL, database and API key. (${detail})`,
      odooUrl: odooBaseUrl,
      odooDb
    });
  }

  const props: Props = { odooBaseUrl, odooDb, odooApiKey, clientName };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: `${new URL(odooBaseUrl).host}/${odooDb}`,
    metadata: { odooHost: new URL(odooBaseUrl).host, odooDb },
    scope: authRequest.scope,
    props
  });

  return Response.redirect(redirectTo, 302);
}

/**
 * Default (non-API) handler for the OAuthProvider: serves the /authorize UI and
 * keeps the historical 404 for everything else. /token, /register and the
 * .well-known metadata endpoints are handled by the provider itself.
 */
export const oauthDefaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      if (request.method === "GET") return handleAuthorizeGet(request, env);
      if (request.method === "POST") return handleAuthorizePost(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response("Not found", { status: 404 });
  }
};
