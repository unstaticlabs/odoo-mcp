import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent, type Env, type Props } from "./server";
import { oauthDefaultHandler } from "./oauth";

export {
  callOdoo,
  OdooError,
  classifyOdooError,
  classifyAggregationDiagnosis,
  aggregationDiagnosisFromOdooError,
  normalizeOdooDetails,
  matchInvalidGroupby,
  matchUnsupportedAggregate,
  isRecoverable
} from "./odoo";
export type { OdooErrorCode, AggregationDiagnosisCode, AggregationErrorContext } from "./odoo";
export { mcpAggregationErrorFromException, redactDetails } from "./tools/shared";
export type { AggregationErrorEnvelope } from "./tools/shared";
export { OdooQueue } from "./odoo-queue";
export {
  pickSmartFields,
  searchRecords,
  escapeHtml,
  countRecords,
  resolveFields,
  MODEL_FIELD_PRESETS,
  browseRecords,
  resolveNamedFieldPreset,
  buildBrowsePageMeta,
  applyBrowseSafeguard,
  NAMED_MODEL_FIELD_PRESETS,
  BROWSE_MAX_PAYLOAD_BYTES,
  BROWSE_MIN_LIMIT,
  resolveCompactFields,
  buildPageMetadata,
  buildCompactReadEnvelope,
  FIELD_PRESET_NAMES,
  FIELD_PRESET_FALLBACKS,
  FIELD_PRESET_MODEL_OVERRIDES,
  zPageMetadata,
  zCompactFieldsBlock,
  zCompactReadEnvelope
} from "./tools/shared";
export type {
  FieldResolution,
  NamedFieldPreset,
  NamedPresetResolution,
  BrowseResult,
  BrowsePageMeta,
  BrowseSafeguardPlan,
  FieldPresetName,
  PageMetadata,
  CompactReadEnvelope,
  CompactFieldResolution,
  CompactFieldsBlock
} from "./tools/shared";
export { parseButtonsFromArch, mergeModelActions } from "./tools/read";
export { CURATED_MODEL_ACTIONS } from "./tools/actions-map";
export { normalizeRecord, normalizeRecords, deriveWorkflowStatus } from "./normalizer";
export type { OdooFieldMeta, FieldsMeta, NormalizeOptions } from "./normalizer";
export { TtlCache, getFieldsCached, resolveXmlIdCached, cachedSearchRead, TTL_METADATA_MS, TTL_STRUCTURE_MS, TTL_BALANCE_MS } from "./cache";
export type { CachedFieldMeta, XmlIdResolution } from "./cache";
export { validateOdooCredentials } from "./oauth";
export { McpAgent };

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Token-authenticated MCP requests land here after OAuthProvider has resolved
 * the bearer token: ctx.props already holds the decrypted Odoo credentials in
 * the exact same Props shape the header path builds, so McpAgent and every
 * tool below it cannot tell the two auth paths apart.
 */
const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return McpAgent.serve("/mcp", { binding: "McpAgent" }).fetch(request, env, ctx);
  }
};

export const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
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

    // Decline the optional standalone SSE stream (server→client push). This
    // server never sends server-initiated messages, and agents@0.17.3 has a
    // production-only bug where an open standalone stream stalls every
    // subsequent POST on the same session. 405 is the spec-sanctioned way to
    // say "no push stream"; clients fall back to plain request/response.
    if (url.pathname.startsWith("/mcp") && request.method === "GET") {
      return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
    }

    // BYO-key header path (Claude Code, Claude Desktop, …) — unchanged. Any
    // X-Odoo-* header marks the request as header-authenticated; requests
    // without them (ChatGPT) fall through to the OAuth shim below.
    if (
      url.pathname.startsWith("/mcp") &&
      (request.headers.has("X-Odoo-Url") || request.headers.has("X-Odoo-Db"))
    ) {
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
      return McpAgent.serve("/mcp", { binding: "McpAgent" }).fetch(request, env, { ...ctx, props });
    }

    // OAuth shim path: /authorize, /token, /register, /.well-known/*, and
    // token-authenticated /mcp requests.
    return oauthProvider.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
