import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { AccountingAgent, McpAgent, ProjectsAgent, type Env, type Props } from "./server";
import { oauthDefaultHandler } from "./oauth";

// Entry-module exports are restricted to handlers and Durable Object classes:
// the Workers runtime rejects anything else ("Incorrect type for map entry").
// Test-support re-exports live in ./test-exports instead.
export { McpAgent, AccountingAgent, ProjectsAgent };

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * One endpoint per tool surface, all sharing the same OAuth front door and the
 * same Props contract. Paths are siblings (never nested under /mcp): both our
 * header-path routing and OAuthProvider's apiHandlers match by prefix, so a
 * nested /mcp/accounting would be swallowed by /mcp.
 */
const MCP_ENDPOINTS = [
  { path: "/mcp", serve: () => McpAgent.serve("/mcp", { binding: "McpAgent" }) },
  { path: "/accounting/mcp", serve: () => AccountingAgent.serve("/accounting/mcp", { binding: "AccountingAgent" }) },
  { path: "/projects/mcp", serve: () => ProjectsAgent.serve("/projects/mcp", { binding: "ProjectsAgent" }) }
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
        return endpoint.serve().fetch(request, env, ctx);
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
  scopesSupported: ["odoo"]
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

      const props: Props = { odooBaseUrl, odooDb, odooApiKey };
      return mcpEndpoint.serve().fetch(request, env, { ...ctx, props });
    }

    // OAuth shim path: /authorize, /token, /register, /.well-known/*, and
    // token-authenticated /mcp requests.
    return oauthProvider.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
