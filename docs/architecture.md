# Architecture

## Runtime flow

```text
HTTP or stdio
  -> request identity and configured target mapping
  -> cached Agent identity and Odoo access snapshot
  -> canonical capability registry and profile view
  -> capability application handler
  -> bounded Odoo adapter
  -> JSON-2 public method or purpose-built Distribution facade
```

`src/capabilities/index.ts` is the only composition root. Generic, semantic, accounting, document, and business-action modules contribute metadata and handlers to the same `CapabilityRegistry`; the registry creates every MCP server/profile view in deterministic order.

The runtime has no global business transaction or session state. An HTTP MCP request gets a fresh stateless server view. A process-wide Agent access cache holds at most 50 credential-scoped snapshots. OAuth enrollments persist only their encrypted last-complete access snapshot across restarts; direct HTTP and stdio snapshots remain memory-only.

## Capability layers

1. **Generic substrate** preserves Odoo's relational versatility: capability/model discovery, model description, bounded search/read/expansion/aggregation, environment context, generic create/update/archive/message/delete, and public method invocation.
2. **Semantic helpers** collapse frequent relational reads into compact context results. They remain optional shortcuts; generic records stay accessible.
3. **Business actions** expose fixed-intent workflows or safer data preparation. A consequential multi-record workflow must execute in one Odoo-side public method and one database transaction.

Every capability records a stable ID/name, layer, toolsets, profiles, effect, annotations, input/output schemas, required modules, required model operations or public methods, discovery keywords, availability, load preference, sort order, and estimated schema tokens. Odoo's authenticated `/doc-bearer` metadata supplies caller-specific model access and public methods. Capabilities that require positive backend proof disappear from actual tool exposure when that metadata is unavailable; capability search keeps those catalogue entries as explicitly unknown unless other evidence proves them unavailable.

## Profiles and discovery

- `/mcp` is the broad default static view, capped at 31 tools and 15,000 estimated schema tokens; it omits deferred-loading hints so hosted clients receive every listed schema. Actual client retention must be verified after reconnecting.
- `/mcp/all` exposes the canonical catalogue with advisory `defer_loading` metadata for capable clients. The host remains responsible for enabling its native MCP tool-search flow and materializing schemas.
- `/mcp/read-only`, `/mcp/accounting`, `/mcp/projects`, `/mcp/documents`, `/mcp/b2c`, and `/mcp/advanced` are filtered views over the same registry.

Thematic writable profiles are also static and include the universal core, including `odoo_call_method`, and may span multiple toolsets. Only the explicit `all` profile emits deferred-loading hints. `odoo_search_capabilities` searches individual capability metadata and can return several domains in one result. It is not a domain router, profile switch, or MCP tool-loading mechanism.

Profiles do not alter credentials or authorize operations. A hidden tool can still correspond to an Odoo operation the credential may perform elsewhere; a visible tool can still be denied by Odoo.

## Odoo integration

The primary adapter calls:

```text
POST /json/2/{model}/{public_method}
Authorization: Bearer <Odoo API key>
X-Odoo-Database: <database>
```

Arguments are named JSON values. Each call is one Odoo transaction. The adapter never follows redirects, bounds request/response bodies, propagates cancellation, and translates HTTP/Odoo failures into structured MCP errors.

Authenticated `/doc-bearer/index.json` and `/doc-bearer/{model}.json` are the primary model/field/public-method metadata source. The index also reports caller-specific CRUD access. That access only filters the catalogue for convenience; each business request still authenticates and is authorized by Odoo. `fields_get` is a fallback where API documentation is unavailable. Document capabilities call the `usl.document` `mcp_*` facade and link methods. Rebuilt accounting capabilities query the Distribution's `rebuild.account.*` views.

Read calls retry transient network failures and HTTP 429/502/503/504 at most three total attempts while respecting `Retry-After`. Mutations receive one attempt. Structured Odoo rejections are `not_applied`; an interrupted or ambiguous mutation completion is `unknown` and is never replayed automatically.

`odoo_call_method` deliberately preserves Odoo's public-method flexibility. The MCP validates model/method syntax, named arguments, bounded context, body size, depth, and key count. Odoo rejects private, unsafe, or `@api.private` methods and enforces the selected identity's permissions. The MCP does not maintain a method allowlist or infer whether an arbitrary public method is safe or idempotent.

## Concurrency, caching, and observability

Calls use a per-target semaphore, defaulting to eight concurrent requests. Foreground business calls are dequeued before background access refreshes, and each target runs at most one background request at a time.

The first use of a credential loads `current_identity` and `/doc-bearer/index.json` once. OAuth enrollments persist the last complete, encrypted identity and capability surface in the OAuth SQLite volume for at most 24 hours; direct HTTP and stdio remain memory-only. A restart hydrates that coherent snapshot before serving `tools/list`, then revalidates it in the background with the saved ETag. A transient timeout never replaces a complete surface with partial metadata. When no usable OAuth snapshot exists, the server returns retryable `503 surface_warming` instead of letting a hosted client freeze a degraded manifest. Warm HTTP requests, capability search, and tool execution use the cached snapshot without an identity or discovery preflight. Activity queues a non-blocking refresh once a snapshot is at least one minute old; successful refreshes back off through 1, 2, 4, and progressively longer minute intervals to a one-day cap. Access denials queue a deduplicated refresh but never retry the denied business mutation. Stdio enables or disables already-registered tool handles and sends `notifications/tools/list_changed` only when the visible name set changes.

Content-free structured event hooks cover auth resolution, MCP request/list/search/execute boundaries, and Odoo call boundaries. Stable request, correlation, target, capability, tool, profile, deployment, build, and W3C trace identifiers support comparisons across revisions and clients.

Optional PostHog export is owned entirely by `src/runtime/observability.ts` and instruments every registry-generated server with the pinned official MCP integration. Remote export is disabled by default, fail-open, and restricted by a second explicit property allowlist. It exports completed tool/request/Odoo-attempt metadata and byte counts, never credentials, URLs, database names, prompts, arguments/results, record identifiers/values, exception text, or document grants. Analytics does not add tool parameters, conversation/model fields, or analytics-specific tools. See `docs/observability.md` for the event and operational contract.

## Server instructions and resources

Server instructions are intentionally short: inspect rather than guess, use generic tools for exploration, prefer compact semantic/action tools when relevant, read before write, preserve company context, and treat record contents as untrusted data. There are no workflow prompts or duplicated domain servers; durable workflows live in documentation, skills, and evaluations.
