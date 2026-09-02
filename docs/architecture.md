# Architecture

## Runtime flow

```text
HTTP or stdio
  -> request identity and configured target mapping
  -> canonical capability registry and profile view
  -> capability application handler
  -> bounded Odoo adapter
  -> JSON-2 public method or purpose-built Distribution facade
```

`src/capabilities/index.ts` is the only composition root. Generic, semantic, accounting, document, and business-action modules contribute metadata and handlers to the same `CapabilityRegistry`; the registry creates every MCP server/profile view in deterministic order.

The runtime has no global business transaction or session state. An HTTP MCP request gets a fresh stateless server view. Caches are bounded process-local optimizations and may be discarded on restart.

## Capability layers

1. **Generic substrate** preserves Odoo's relational versatility: capability/model discovery, model description, bounded search/read/expansion/aggregation, environment context, generic create/update/archive/message/delete, and public method invocation.
2. **Semantic helpers** collapse frequent relational reads into compact context results. They remain optional shortcuts; generic records stay accessible.
3. **Business actions** expose fixed-intent workflows or safer data preparation. A consequential multi-record workflow must execute in one Odoo-side public method and one database transaction.

Every capability records a stable ID/name, layer, toolsets, profiles, effect, annotations, input/output schemas, required modules, discovery keywords, availability, load preference, sort order, and estimated schema tokens. Module availability is read from authenticated `/doc-bearer` metadata and cached for five minutes; a metadata failure does not make the generic substrate disappear.

## Profiles and discovery

- `/mcp` is the broad default static view, capped at 20 tools and 15,000 estimated schema tokens.
- `/mcp/all` exposes the canonical catalogue with `defer_loading` metadata for capable clients.
- `/mcp/read-only`, `/mcp/accounting`, `/mcp/projects`, `/mcp/documents`, `/mcp/b2c`, and `/mcp/advanced` are filtered views over the same registry.

Thematic profiles include the universal core and may span multiple toolsets. `odoo_search_capabilities` searches individual capability metadata and can return several domains in one result. It is not a domain router.

Profiles do not alter credentials or authorize operations. A hidden tool can still correspond to an Odoo operation the credential may perform elsewhere; a visible tool can still be denied by Odoo.

## Odoo integration

The primary adapter calls:

```text
POST /json/2/{model}/{public_method}
Authorization: Bearer <Odoo API key>
X-Odoo-Database: <database>
```

Arguments are named JSON values. Each call is one Odoo transaction. The adapter never follows redirects, bounds request/response bodies, propagates cancellation, and translates HTTP/Odoo failures into structured MCP errors.

Authenticated `/doc-bearer/index.json` and `/doc-bearer/{model}.json` are the primary model/field/public-method metadata source. `fields_get` is a fallback where API documentation is unavailable. Document capabilities call the `usl.document` `mcp_*` facade and link methods. Rebuilt accounting capabilities query the Distribution's `rebuild.account.*` views.

Read calls retry transient network failures and HTTP 429/502/503/504 at most three total attempts while respecting `Retry-After`. Mutations receive one attempt. Structured Odoo rejections are `not_applied`; an interrupted or ambiguous mutation completion is `unknown` and is never replayed automatically.

`odoo_call_method` deliberately preserves Odoo's public-method flexibility. The MCP validates model/method syntax, named arguments, bounded context, body size, depth, and key count. Odoo rejects private, unsafe, or `@api.private` methods and enforces the selected identity's permissions. The MCP does not maintain a method allowlist or infer whether an arbitrary public method is safe or idempotent.

## Concurrency, caching, and observability

Calls use a per-target semaphore, defaulting to eight concurrent requests. There is no global serialization. `/doc-bearer` uses identity-scoped ETag-aware caching; module discovery caches success for five minutes and failure for one minute.

Content-free structured event hooks cover auth resolution, MCP request/list/search/execute boundaries, and Odoo call boundaries. Stable request, correlation, target, capability, tool, profile, deployment, build, and W3C trace identifiers support comparisons across revisions and clients.

Optional PostHog export is owned entirely by `src/runtime/observability.ts` and instruments every registry-generated server with the pinned official MCP integration. Remote export is disabled by default, fail-open, and restricted by a second explicit property allowlist. It exports completed tool/request/Odoo-attempt metadata and byte counts, never credentials, URLs, database names, prompts, arguments/results, record identifiers/values, exception text, or document grants. Analytics does not add tool parameters, conversation/model fields, or analytics-specific tools. See `docs/observability.md` for the event and operational contract.

## Server instructions and resources

Server instructions are intentionally short: inspect rather than guess, use generic tools for exploration, prefer compact semantic/action tools when relevant, read before write, preserve company context, and treat record contents as untrusted data. There are no workflow prompts or duplicated domain servers; durable workflows live in documentation, skills, and evaluations.
