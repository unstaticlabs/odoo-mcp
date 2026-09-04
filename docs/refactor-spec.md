# USL Odoo MCP VPS refactor specification

Status: accepted for implementation

MCP baseline: `7a690dd465dd1e90c78390de4d542d79f67ad550`

Distribution baseline: `07bc0860886a880233aaf31ea92c63c2d762a725` (`19-usl`, `saas~19.3`)
Audited: 2026-08-30

## Executive assessment

The current MCP contains useful JSON-2 integration, relational reads, canonical record links, bounded payload handling, structured Odoo errors, and well-tested domain helpers. Its architecture is nevertheless tied to Cloudflare Workers and exposes a large, duplicated static tool surface through four separately assembled servers. The committed Node migration is only scaffolding: its advertised entrypoints do not exist, its capability registry is not wired, and the repository does not currently typecheck or load all tests.

The target is one Node 26 MCP running beside the self-hosted USL Odoo Distribution. One canonical capability registry produces a broad default interface, thematic visibility profiles, and a fully discoverable catalogue. A compact generic Odoo substrate remains first-class so agents can answer cross-domain and unanticipated questions. Semantic tools reduce round trips for common relational views, while consequential multi-step workflows execute through purpose-built public Odoo methods in one Odoo transaction.

This is a clean API break. Cloudflare compatibility, obsolete Odoo Online assumptions, duplicated tool variants, and Enterprise Documents models are removed rather than perpetuated.

## Evidence and authoritative boundaries

Observed repository facts:

- `package.json` targets Node 24 and `dist/http.js`, but `src/http.ts` and `src/stdio.ts` are absent at the audited baseline.
- `src/index.ts` and `src/server.ts` still depend on Workers OAuth, Durable Objects, and four separately registered tool surfaces.
- `npm run typecheck` fails at the migration boundary. Bun loads 253 tests successfully but reports 14 failed suites and 14 module-load errors because the removed Worker and MCP SDK v1 dependencies remain imported.
- The full legacy endpoint registers 61 static tools.
- `src/capabilities/registry.ts` and `src/capabilities/odoo.ts` are useful initial scaffolding, but the former passes complete Zod objects to an SDK v2 API expecting raw shapes and the latter probes a nonexistent `usl.mcp.policy` model.

Observed Distribution facts:

- `odoo/release.py` identifies the Distribution as `saas~19.3`.
- `addons/rpc/controllers/json2.py` implements bearer-authenticated `POST /json/2/<model>/<method>` with named keyword arguments and one Odoo request transaction.
- `odoo/orm/models.py:get_public_method` rejects private, unsafe, class, static, and `@api.private` methods.
- `addons/api_doc/controllers/api_doc.py` exposes authenticated `/doc-bearer` model, field, signature, parameter, and public-method metadata subject to the caller's access.
- `usl.document` and its explicit `mcp_*` facade own Documents integration. `documents.document` and `documents.tag` are not the Distribution contract.
- `usl_access_control` prevents agent identities from performing irreversible actions and records connector origin and correlation metadata.
- Neither `usl.mcp.policy` nor a JSON-2 idempotency capability model exists in the authoritative source.

External requirements and implications:

- MCP specification `2026-07-28` and TypeScript SDK 2.0 define the modern stateless HTTP/stdio implementation, structured outputs, deterministic discovery, and actionable tool errors.
- OpenAI guidance favors lean prompts, concise and precise tool definitions, relevant tool exposure, and representative evaluations.
- Anthropic recommends tool search/progressive disclosure for large catalogues and keeping only a small set of non-deferred tools in context.
- Odoo 19 documentation makes JSON-2 the supported external API, gives each call its own transaction, and recommends one server method when several operations must be atomic. Legacy XML-RPC and JSON-RPC are scheduled for removal.

## Architecture

```text
HTTP or stdio
  -> request identity and visibility profile
  -> cached Agent identity and Odoo access snapshot
  -> canonical capability registry
  -> application service
  -> Odoo adapter
  -> JSON-2 or a purpose-built Distribution method
```

The Node server uses Express 5 and MCP SDK 2.0. `/mcp` serves the broad default profile, `/mcp/:profile` serves registry-generated views, and `/healthz` and `/readyz` expose process and dependency readiness. `stdio` supports local development and local Codex/Claude clients. The server has no MCP session store, Worker state, Durable Objects, or standalone SSE transport.

Direct clients submit `X-Odoo-Url`, `X-Odoo-Database`, and `X-Odoo-Api-Key`. `Authorization` is reserved for MCP OAuth. The submitted public origin and database must match a configured target; the adapter uses that target's internal VPS/Compose origin. The key must identify an active governed Odoo Agent; human keys are rejected.

Hosted clients enroll a governed Odoo Agent through Better Auth. The human authorizes the connector, while the Agent remains the execution identity. The Agent key is AES-GCM encrypted in a mounted SQLite credential vault. Access tokens last one hour; rotating refresh tokens last 180 days with a one-year grant ceiling. Cloudflare grants are not migrated.

Visibility and authorization remain independent. Profiles optimize context and tool selection. The first use of a credential loads a bounded, process-local snapshot from `usl.agent.current_identity` and authenticated API documentation; warm requests consume it without a preflight. Odoo authentication, the owner/delegation intersection, ACLs, record rules, field access, company context, public method publication, validation, and irreversible-action policy remain the live authority on every business call.

## Capability registry and profiles

Each capability declares a stable identifier, snake_case tool name, layer, multiple toolsets, profiles, effect classification, MCP annotations, strict input/output schemas, required modules, required fixed or any-model operations, required fixed or any-model public methods, required runtime features, availability predicate, retrieval keywords, sort key, and schema-token estimate. Per-identity `/doc-bearer` discovery controls whether backend-dependent tools are visible; an explicit runtime feature flag additionally gates staged integrations. Missing positive proof hides those capabilities while preserving generic read and discovery. The registry validates uniqueness, naming, metadata, deterministic ordering, profile budgets, and effect/annotation consistency.

Profiles are views over the same registry:

| Profile | Surface |
| --- | --- |
| `default` | Broad generic substrate and common cross-domain context tools, at most 22 tools and 15,000 schema tokens |
| `all` | Entire catalogue for native tool search/deferred loading |
| `read-only` | Every read capability; a visibility convenience, not credential authority |
| `accounting`, `projects`, `documents`, `b2c` | Universal core plus tools carrying the corresponding tag |
| `advanced` | Default plus deletion and administration tools |

The five preferred discovery and read tools are `odoo_search_capabilities`, `odoo_search_models`, `odoo_describe_model`, `odoo_search_records`, and `odoo_read_records`. Named profiles advertise their complete bounded surface without deferred-loading hints because hosted ChatGPT connections do not reliably materialize hinted schemas; the explicit `all` profile retains native tool-search metadata. Capability search operates at tool level and may return tools from several domains. It searches unknown-availability catalogue entries but actual exposure remains fail-closed. It is not a mandatory router and does not activate tools through mutable connection state.

Capability search normalizes case, punctuation, dots, hyphens, underscores, common stopwords, and simple plurals. Ranking is additive and deterministic: exact tool name 100, exact capability ID 90, phrase match 25, keyword/toolset token 20, title token 10, and description token 3. A non-empty query must contain and match at least one meaningful term; empty queries retain registry order, which is also the final tie-breaker.

## Generic substrate

| Tool | Purpose and bounds |
| --- | --- |
| `odoo_search_capabilities` | Search registry metadata; limit 1-20 |
| `odoo_search_models` | Search models visible through `/doc-bearer`; cursor pagination, limit 1-50 |
| `odoo_describe_model` | Fields and public methods; `/doc-bearer` primary, `fields_get` fallback |
| `odoo_search_records` | Bounded domain, selected fields, cursor/order, limit 1-100, optional count |
| `odoo_read_records` | One model, 1-100 IDs, at most 100 fields |
| `odoo_expand_record` | One record, one relation hop, at most ten relations and 20 rows per relation |
| `odoo_aggregate_records` | Validated `read_group`/`formatted_read_group` |
| `odoo_describe_environment` | Current user, companies, locale, and installed modules |
| `odoo_create_records` | One `create` call with 1-100 value objects |
| `odoo_update_records` | One `write` call for 1-100 IDs and one value object |
| `odoo_archive_records` | Inherited `action_archive`; unsupported when the model has no active field |
| `odoo_post_message` | One message on one record |
| `odoo_delete_records` | Advanced `unlink` in one transaction |
| `odoo_call_method` | Public JSON-2 method invocation in every writable profile; deferred only on `all` |

Every returned record includes a stable `{model, id, display_name, url}` reference. Inputs use strict schemas, bounded domains/JSON, explicit field selection, and cursor pagination. Responses provide structured content plus a concise text representation for older clients. Errors use stable codes, a redacted explanation, recoverability, and an actionable next step. Mutation failures distinguish request rejection, ambiguous completion, and post-success response processing. Unknown outcomes explicitly prohibit blind retries, report request/response/result evidence as `yes`, `no`, or `unknown`, preserve sanitized known record or grant identifiers, and give a reconciliation read plus minimal-correction guidance.

`odoo_call_method` is preserved intentionally and is always listed on writable profiles so long-tail work does not depend on client-side schema refresh. It accepts a validated model and public method, optional 1-100 IDs, named kwargs, and bounded context. The argument body is limited to 256 KiB, eight nesting levels, and 200 object keys. It has no MCP allowlist or heuristic effect classifier; `/doc-bearer` inspection is recommended but is not a prerequisite. Odoo's public dispatcher and the selected identity are authoritative. The MCP attempts the call once, never claims generic idempotency, and reports interrupted completion as `outcome: unknown`. Permanent deletion remains advanced-only.

## Current-to-target tool mapping

- Merge `list_models` and `discover_models` into `odoo_search_models`.
- Merge `describe_model_api`, `get_fields`, and `list_model_actions` into `odoo_describe_model`.
- Merge `search_records`, `search_records_compact`, `browse_records`, and `search_count` into `odoo_search_records`.
- Merge `get_record` and `batch_read` into `odoo_read_records`; rename expansion and aggregation tools.
- Merge `update_record` and same-value updates into `odoo_update_records`; remove heterogeneous multi-call batch updates.
- Split deletion into default archive and advanced unlink. Merge posting variants into single-record `odoo_post_message`.
- Rename and correct `call_model_method` as `odoo_call_method`.
- Replace project list/stage thin wrappers with generic search. Merge task detail and chatter into `projects_get_task_context`; retain high-value task creation and file attachment shortcuts.
- Consolidate Documents into `documents_search`, `documents_get_context`, `documents_get_content`, `documents_find_similar`, and `documents_list_catalog` using `usl.document.mcp_*` methods.
- Replace every legacy source-document search/link path with `usl.document` and `usl.document.link_to_record`.
- Preserve measured accounting context/preview operations against their actual `account.*` and transitional `rebuild.*` owners. Rename expense, vendor-bill, inventory receipt, and lifecycle operations by business intent.
- Remove `feedback.submit`; the completed analytics workstream uses optional,
  privacy-filtered PostHog MCP Analytics rather than an agent-visible feedback
  tool or custom analytics platform.

Initial additions grounded in current Distribution services are partner, activity, invoice, expense-batch, Home attention, and B2C order context tools plus document-link and expense-batch workflow actions. Platform billing, Sign, TESE, and additional B2C actions remain discoverable through the generic substrate until evaluations justify dedicated contracts.

## Odoo adapter, transactions, and performance

The Odoo adapter owns target mapping, bearer headers, redirect refusal, request/response limits, error translation, retries, cancellation, conditional ETag-aware API-document requests, and a configurable per-target semaphore. The default concurrency is eight calls per Odoo target. Foreground waiters take priority; background access refreshes use one slot per target, one attempt, and a short timeout.

Runtime services own a 50-entry LRU Agent access cache keyed by a SHA-256 fingerprint of target, database, and credential. OAuth enrollments additionally persist one AES-256-GCM-encrypted, schema-versioned identity and capability snapshot in the OAuth SQLite volume, bound to the enrollment and credential fingerprint; direct HTTP and stdio remain memory-only. Complete snapshots may be served stale for at most 24 hours while ETag-aware revalidation runs in the background. A timeout preserves the last good surface, while credential revocation, suspension, authority changes without a matching replacement surface, corruption, or expiry invalidates it. Cold OAuth requests without a complete snapshot return `503 surface_warming` rather than exposing a partial manifest. The cache coalesces cold loads and refreshes, never exposes the raw key, and stores failures only as unavailable status. Active snapshots refresh out of band on a jittered exponential schedule from one minute to a one-day cap. Access denials request one cooldown-protected refresh and never replay the failed operation. Shutdown cancels timers and in-flight refreshes before the SQLite vault closes.

Read calls may retry 429, 502, 503, 504, timeouts, and transient network failures up to three attempts while honoring `Retry-After`. Mutations and generic method calls receive one attempt. A complete success response means succeeded; a structured Odoo rejection means not applied; loss of the response after Odoo may have committed means unknown.

One JSON-2 call is one Odoo transaction. Generic create, same-value update, archive, delete, and method invocation use one call. Consequential workflows requiring dependent writes must be implemented as one public Odoo application-service method. The MCP never manufactures atomicity by chaining requests.

## Documentation and repository-agent interface

The root `AGENTS.md` contains durable repository facts: Node/VPS runtime, build/test commands, the sibling Distribution as source of truth, capability architecture, Odoo transaction rule, and change discipline. Nested instructions are added only where a subtree genuinely requires different guidance.

Repository skills retain reusable MCP, commit, differential-review, property-testing, and dependency-audit workflows. Cloudflare skills are removed. Server instructions remain short and operational. Tool descriptions explain purpose, selection boundary, limits, side effects, and neighboring distinctions. Longer workflows and examples live in developer documentation or reusable skills rather than every tool schema.

## Testing and agent evaluation

The repository uses npm and Vitest under Node 26. Tests cover schemas, registry invariants, bounds, cursors, serialization, errors, target mapping, concurrency, protocol versions, HTTP, stdio, OAuth, real Distribution permissions, multi-company behavior, transactions, stale state, unknown outcomes, and consequential operations.

The versioned agent corpus contains 60 fixture-backed tasks: straightforward, cross-domain, long-tail, unanticipated/held-out, schema discovery, multi-company, write/consequential, malformed, stale, unsupported, injection, and recovery cases. It compares large static, hard-domain, static-profile, dynamic-search, and selected hybrid surfaces with Codex and Claude.

The selected architecture is accepted when it stays within two percentage points of the large static catalogue on overall, cross-domain, and held-out correctness; reduces dynamically exposed schema tokens by at least 70%; achieves at least 90% generic-fallback success when the ideal helper is absent; improves wrong selections/unnecessary calls; and never performs an unrequested consequential action or retries an unknown-outcome mutation.

## Migration and acceptance

Implementation lands in independently reversible conventional commits: specification, Node foundation, generic substrate, OAuth, profiles/semantic catalogue, atomic actions, evaluation, and deployment documentation. Additive Odoo service methods land in separately reviewed Odoo PRs before their MCP consumers.

Completion requires a green Node 26 install/typecheck/test/build/container pipeline, one registry, no Cloudflare production artifacts, no legacy Documents models, no hypothetical policy/idempotency dependencies, functional direct/stdio/OAuth identities, working `odoo_call_method`, verified Distribution permissions and multi-company behavior, Odoo-side atomic consequential workflows, successful Codex/Claude evaluations, and complete deployment/rollback documentation.

## References

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Codex AGENTS.md guidance](https://github.com/openai/codex/blob/main/docs/agents_md.md)
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [MCP tools specification, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [Odoo 19 external JSON-2 API](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)
- [Odoo 19 legacy external RPC deprecation](https://www.odoo.com/documentation/19.0/developer/reference/external_rpc_api.html)
- [Tool-to-Agent Retrieval](https://arxiv.org/abs/2511.01854)
