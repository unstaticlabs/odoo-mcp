import { AsyncLocalStorage } from "node:async_hooks";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import type { CredentialVault } from "./vault.js";
import { emitEvent } from "../runtime/logging.js";

interface DependencyFailure {
  stage: "oauth_client_metadata" | "oauth_client_jwks";
  upstreamStatus?: number;
}

/** Keep dependency diagnostics local to one OAuth exchange; never retain inputs. */
export function oauthDependencyBoundary(vault: CredentialVault, fetcher: ClientMetadataResourceFetch) {
  const requests = new AsyncLocalStorage<{ failure?: DependencyFailure }>();
  const fetchResource: ClientMetadataResourceFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Only classify an unavailable resource already owned by a registered client.
    // A new client's bad URL must still fail as invalid_client.
    const known = vault.database.prepare(
      "SELECT clientId FROM oauthClient WHERE disabled IS NOT 1 AND (clientId = ? OR jwksUri = ?) LIMIT 1"
    ).get(url, url) as { clientId: string } | undefined;
    const state = requests.getStore();
    const stage = known?.clientId === url ? "oauth_client_metadata" : "oauth_client_jwks";
    try {
      const response = await fetcher(input, init);
      if (state && known && (response.status === 404 || response.status === 429 || response.status >= 500)) {
        state.failure = { stage, upstreamStatus: response.status };
      }
      return response;
    } catch (error) {
      if (state && known) state.failure = { stage };
      throw error;
    }
  };
  const run = async (request: Request, handler: (request: Request) => Promise<Response>): Promise<Response> => {
    if (new URL(request.url).pathname !== "/api/auth/oauth2/token") return handler(request);
    const submitted = request.headers.get("X-Correlation-Id")?.trim();
    const correlationId = submitted && /^[A-Za-z0-9._-]{1,128}$/.test(submitted) ? submitted : crypto.randomUUID();
    return requests.run({}, async () => {
      let response: Response;
      try {
        response = await handler(request);
      } catch {
        // An unexpected exception could follow token issuance. Do not claim a
        // definitive outcome or expose a library exception to the OAuth client.
        response = Response.json({ error: "server_error" }, { status: 500 });
      }
      const failure = requests.getStore()?.failure;
      // Never reinterpret success or a response after token issuance.
      if (response.status < 400) return response;
      const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null;
      const codes = new Set(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
        "unsupported_grant_type", "invalid_scope", "invalid_target", "invalid_client_metadata",
        "invalid_redirect_uri", "access_denied", "temporarily_unavailable", "server_error"]);
      const dependencyUnavailable = failure && payload?.error === "invalid_client";
      const code = dependencyUnavailable ? "temporarily_unavailable"
        : typeof payload?.error === "string" && codes.has(payload.error) ? payload.error : "server_error";
      const stage = dependencyUnavailable ? failure.stage : "oauth_token";
      const outcome = response.status >= 500 && !dependencyUnavailable ? "unknown" : "not_applied";
      emitEvent("auth.token.failed", {
        correlation_id: correlationId, stage, status: code, outcome,
        upstream_status: dependencyUnavailable ? failure.upstreamStatus : undefined
      });
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "no-store");
      headers.set("X-Correlation-Id", correlationId);
      if (dependencyUnavailable) headers.set("Retry-After", "30");
      return Response.json({
        error: code,
        error_description: dependencyUnavailable
          ? "The OAuth client's metadata or signing keys are temporarily unavailable. Retry later."
          : "The OAuth token request failed. Use the correlation ID to diagnose the failure.",
        correlation_id: correlationId, stage, outcome,
        ...(dependencyUnavailable && failure.upstreamStatus !== undefined ? { upstream_status: failure.upstreamStatus } : {})
      }, { status: dependencyUnavailable ? 503 : response.status, headers });
    });
  };
  return { fetchResource, run };
}
