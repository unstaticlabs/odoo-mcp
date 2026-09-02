# VPS deployment and rollback

The production shape is one non-root Node 26 container on the same private network as the USL Odoo Distribution. The reverse proxy terminates TLS and forwards only the MCP public origin to port 3000. Odoo traffic uses the configured private origin.

## Build and configure

```bash
npm ci
npm run check
npm run eval:validate
docker build -t usl-odoo-mcp:<git-sha> .
```

Copy `compose.example.yml`, attach it to the existing Odoo network, configure the public/internal target mapping, and mount production secrets. Keep port 3000 bound to loopback unless an internal proxy network requires otherwise.

Required runtime configuration:

- `MCP_PUBLIC_ORIGIN`, `MCP_ALLOWED_HOSTS`, and `MCP_ALLOWED_ORIGINS`;
- `MCP_DOCUMENT_MATERIALIZATION_ENABLED=false` until its coordinated Odoo backend is deployed;
- one or more Odoo targets;
- request/response bounds and per-target concurrency if defaults are unsuitable;
- OAuth database/secrets/trusted origins when hosted clients are enabled.
- optional PostHog analytics configuration from `docs/observability.md`; keep
  `MCP_ANALYTICS_ENABLED=false` until residency, retention, deletion, and
  project access have been approved.

`MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` are comma-separated hostnames accepted by the MCP Express boundary. The hostname from `MCP_PUBLIC_ORIGIN` is always included in the origin allowlist so same-origin MCP clients keep working when additional origins are configured. `MCP_OAUTH_TRUSTED_ORIGINS` contains complete trusted web origins for OAuth.

## Rollout

1. Build an immutable image tagged with the Git SHA.
2. Back up the OAuth SQLite database and both secret files.
3. Run `oauth:migrate` with the candidate image and production mounts.
4. Start the candidate container without removing the preceding image.
5. Require `GET /healthz` to return `status=ok`.
6. Require `GET /readyz` to return `status=ready`, the default tool budget within 20/15,000, OAuth `ready` or deliberately `disabled`, and analytics `ready` or deliberately `disabled`. Analytics `degraded` does not make the MCP unavailable, but fix it before treating telemetry as complete.
7. Run the authenticated MCP initialization/tool-list smoke test and a bounded Odoo read.
8. Run a hosted OAuth reconnect test when OAuth is enabled.
9. Shift reverse-proxy traffic and monitor content-free error/latency events.

The process handles `SIGTERM`/`SIGINT` by closing the listener and OAuth vault, then attempting a bounded two-second analytics flush. Give the container a normal termination grace period; PostHog failure never delays shutdown beyond that bound and in-flight mutations are not replayed after termination.

## Reverse proxy requirements

- TLS 1.2+ on the public origin.
- Preserve `Host`, request method/body, `Authorization`, the three direct Odoo headers, `Content-Type`, `Accept`, `X-Correlation-Id`, and standard `traceparent`, `tracestate`, and `baggage` headers.
- Enforce a body limit no larger than the configured MCP maximum.
- Do not buffer or automatically replay failed POST requests.
- Route `/.well-known/*`, `/api/auth/*`, and `/oauth/*` when OAuth is enabled.
- Apply network access controls to `/healthz` and `/readyz` if operational metadata should not be public.

## Data and backup

The only MCP persistent state is the optional SQLite OAuth vault. Use a durable mounted volume, monitor free disk, and back up with `npm run oauth:backup`. Its parent directory must be dedicated to the MCP process, owned by that process user, and mode `0700`; startup creates a missing directory but refuses to modify an existing unsafe or shared directory. The SQLite database uses WAL mode. Never copy only a live database file with a naive file copy while writes are active.

Odoo records, authorization, and business audit history remain in Odoo and follow the Distribution's backup procedures.

## Document materialization dependency

The deferred `documents_create_download_url` and `documents_revoke_download_url`
tools require the coordinated `usl_documents` backend public methods and Paperless
`3.0.5-usl.9`. Until these changes reach `19-usl`, the authoritative Distribution
source is `usl/codex/chore-post-migration-continuous-operations`. The MCP does not
proxy file bytes and does not know Paperless credentials. Odoo issues the opaque
capability and remains the authorization gateway for each GET, HEAD, and Range
request.

Deploy and verify that authoritative Distribution branch first. Confirm `/doc-bearer` publishes
`usl.document.mcp_create_download_grant` and
`usl.document.mcp_revoke_download_grant`, configure the ingress below, and only
then set `MCP_DOCUMENT_MATERIALIZATION_ENABLED=true`. The registry requires both
the deployed public methods and this operator flag; otherwise it omits the two
tools while leaving document search, metadata, and OCR available.

Before exposing the tools, configure Odoo's frozen HTTPS `web.base.url` and the
Distribution's `/agent-documents/<43-character-token>` ingress contract. That
route must suppress access logs, strip spoofed `X-USL-Document-Grant` headers,
rewrite to the private fixed Odoo controller, preserve Range/If-Range, and
disable caching. Keep Odoo and Paperless ports private. The authoritative Nginx
and Caddy examples live in the Distribution runbook
`docs/operations/document-materialization.md`.

Treat a returned URL as a temporary secret. MCP request telemetry must not log
tool results. For rollback, set `MCP_DOCUMENT_MATERIALIZATION_ENABLED=false`
before removing the Odoo backend or ingress.

## Rollback

Runtime/profile/capability rollback is an image change. Keep the preceding image and restore proxy traffic to it. Additive Odoo public methods may remain deployed because MCP rollback does not depend on removing them.

For a release that changed the OAuth schema:

1. stop the candidate;
2. preserve its database for investigation;
3. restore the pre-migration SQLite backup with the matching secrets;
4. run the preceding image;
5. verify readiness and one OAuth connection.

Do not retry an operation whose connection failed after mutation dispatch. Inspect the record in Odoo using the correlation ID and reconcile before any deliberate new attempt.
