import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { AccountingAgent, DocumentsAgent, McpAgent, ProjectsAgent, type Env, type Props } from "./server";
import { oauthDefaultHandler } from "./oauth";
import { OdooOriginCoordinator } from "./origin-coordinator";
import { allowLocalHttpFromEnv, normalizeOdooOrigin, validateOdooDatabase } from "./odoo-target";

// Entry-module exports are restricted to handlers and Durable Object classes:
// the Workers runtime rejects anything else ("Incorrect type for map entry").
// Test-support re-exports live in ./test-exports instead.
export { McpAgent, AccountingAgent, ProjectsAgent, DocumentsAgent, OdooOriginCoordinator };

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024;

function normalizeProps(props: Props, request: Request, env: Env, authMode: "header" | "oauth"): Props {
  const workerOrigin = new URL(request.url).origin;
  return {
    ...props,
    odooBaseUrl: normalizeOdooOrigin(props.odooBaseUrl, {
      allowLocalHttp: allowLocalHttpFromEnv(env.ALLOW_LOCAL_HTTP_ODOO),
      workerOrigin
    }),
    odooDb: validateOdooDatabase(props.odooDb),
    authMode,
    workerOrigin
  };
}

class RequestTooLargeError extends Error {}

/** Enforce the body cap even when Content-Length is absent or dishonest. */
async function boundedRequest(request: Request, maxBytes: number): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.set("Content-Length", String(total));
  return new Request(request, { headers, body });
}

function invalidTargetResponse(error: unknown): Response {
  return Response.json(
    {
      error: "invalid_odoo_connection",
      details: error instanceof Error ? error.message : "Invalid Odoo connection configuration."
    },
    { status: 400, headers: { "Cache-Control": "no-store" } }
  );
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
// The provider sets a grant's expiry once at authorization and never extends it
// on refresh, so this is a hard wall from the initial connect — after it, every
// client of that grant must re-run the OAuth flow.
const REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
// Must comfortably outlive grants: refresh requires the DCR client record, and
// the library default (90 days) would kill year-long grants at day 90.
const CLIENT_REGISTRATION_TTL_SECONDS = 2 * 365 * 24 * 60 * 60; // 2 years

/**
 * One endpoint per tool surface, all sharing the same OAuth front door and the
 * same Props contract. Paths are siblings (never nested under /mcp): both our
 * header-path routing and OAuthProvider's apiHandlers match by prefix, so a
 * nested /mcp/accounting would be swallowed by /mcp.
 */
const MCP_ENDPOINTS = [
  { path: "/mcp", serve: () => McpAgent.serve("/mcp", { binding: "McpAgent" }) },
  { path: "/accounting/mcp", serve: () => AccountingAgent.serve("/accounting/mcp", { binding: "AccountingAgent" }) },
  { path: "/projects/mcp", serve: () => ProjectsAgent.serve("/projects/mcp", { binding: "ProjectsAgent" }) },
  { path: "/documents/mcp", serve: () => DocumentsAgent.serve("/documents/mcp", { binding: "DocumentsAgent" }) }
] as const;

function matchMcpEndpoint(pathname: string): (typeof MCP_ENDPOINTS)[number] | undefined {
  return MCP_ENDPOINTS.find((e) => pathname === e.path || pathname.startsWith(`${e.path}/`));
}

/**
 * Token-authenticated MCP requests land here after OAuthProvider has resolved
 * the bearer token: ctx.props already holds the decrypted Odoo credentials in
 * the exact same Props shape the header path builds, so the agents and every
 * tool below them cannot tell the two auth paths apart. Tokens are not scoped
 * to an endpoint — any grant works on any path, which is fine because every
 * path resolves to the same user-supplied Odoo credentials.
 */
const apiHandlers = Object.fromEntries(
  MCP_ENDPOINTS.map((endpoint) => [
    endpoint.path,
    {
      fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
          const props = normalizeProps((ctx as ExecutionContext<Props>).props, request, env, "oauth");
          return endpoint.serve().fetch(request, env, { ...ctx, props });
        } catch (error) {
          return Promise.resolve(invalidTargetResponse(error));
        }
      }
    }
  ])
);

export const oauthProvider = new OAuthProvider<Env>({
  apiHandlers,
  defaultHandler: oauthDefaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
  scopesSupported: ["odoo"]
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const contentLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MCP_REQUEST_BYTES) {
      return Response.json({ error: "request_too_large", max_bytes: MAX_MCP_REQUEST_BYTES }, { status: 413 });
    }

    try {
      request = await boundedRequest(request, MAX_MCP_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return Response.json({ error: "request_too_large", max_bytes: MAX_MCP_REQUEST_BYTES }, { status: 413 });
      }
      throw error;
    }

    const mcpEndpoint = matchMcpEndpoint(url.pathname);

    // Decline the optional standalone SSE stream (server→client push). This
    // server never sends server-initiated messages, and agents@0.17.3 has a
    // production-only bug where an open standalone stream stalls every
    // subsequent POST on the same session. 405 is the spec-sanctioned way to
    // say "no push stream"; clients fall back to plain request/response.
    if (mcpEndpoint && request.method === "GET") {
      return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
    }

    // BYO-key header path (Claude Code, Claude Desktop, …) — unchanged. Any
    // X-Odoo-* header marks the request as header-authenticated; requests
    // without them (ChatGPT) fall through to the OAuth shim below.
    if (mcpEndpoint && (request.headers.has("X-Odoo-Url") || request.headers.has("X-Odoo-Db"))) {
      const authHeader = request.headers.get("Authorization");
      const odooBaseUrl = request.headers.get("X-Odoo-Url");
      const odooDb = request.headers.get("X-Odoo-Db");
      const odooApiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

      if (!odooApiKey || !odooBaseUrl || !odooDb) {
        return new Response(
          JSON.stringify({ error: "Missing or malformed Authorization / X-Odoo-Url / X-Odoo-Db headers" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      try {
        const props = normalizeProps({ odooBaseUrl, odooDb, odooApiKey }, request, env, "header");
        return mcpEndpoint.serve().fetch(request, env, { ...ctx, props });
      } catch (error) {
        return invalidTargetResponse(error);
      }
    }

    // OAuth shim path: /authorize, /token, /register, /.well-known/*, and
    // token-authenticated /mcp requests.
    return oauthProvider.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
