# Architecture

`odoo-mcp` is one TypeScript Cloudflare Worker exposing four Streamable HTTP MCP
surfaces. Odoo is the business/authorization authority; the Worker owns
transport reliability and interface quality.

```text
MCP client
  -> Worker ingress (headers or OAuth, 4 MiB body cap, target validation)
  -> endpoint McpAgent Durable Object (tools, session caches, metrics)
  -> OdooQueue (handshake, capability, retry/outcome contract)
  -> OdooOriginCoordinator Durable Object (one per normalized origin)
  -> Odoo /json/2/{model}/{public_method} or /doc-bearer/*.json
```

## Components

### Worker ingress

`src/index.ts` routes the four sibling endpoints, bounds request bodies even
without `Content-Length`, normalizes both auth paths, rejects unsupported GET
streams, and exports all Durable Object classes. Entry-module exports remain
limited to runtime handlers/classes as required by Workers.

### Endpoint agents

Each MCP endpoint is a separate `McpAgent` Durable Object class. They share:

- one Odoo connection props contract;
- one queue implementation;
- concise server instructions;
- the fixed operations-guide resource and planning prompt.

The endpoint tool composition is intentionally unchanged in 1.0. `/mcp` is the
full generic surface; focused endpoints reduce client tool-selection cost.

### OdooQueue

`OdooQueue` is a per-agent facade for:

- fixed header-credential handshake caching;
- idempotency capability caching;
- mutation execution metadata and deterministic child keys;
- per-tool metrics;
- read retry policy.

It is not the production concurrency authority. Its local FIFO exists for
tests/injected operation only.

### Origin coordinator

`OdooOriginCoordinator` is named with the normalized `scheme://host[:port]`.
Every physical fetch, including every retry, is proxied through it. The
coordinator holds the complete outbound request until it can execute it, making
single-flight cover the entire network call rather than only permit issuance.

It allows 50 waiters and 60 seconds of queue wait. The next request starts
immediately after the previous one ends. Different Odoo origins use different
Durable Objects and do not contend.

No coordinator storage API is used. Headers, bodies, and responses are neither
persisted nor logged.

### JSON-2 transport

`callOdoo` constructs only exact public JSON-2 targets, sends named arguments at
the JSON root, and adds Odoo's bearer/database headers. Create uses
`vals_list`; write uses `ids` and `vals`. Redirects are manual. Request and
response bodies are byte-bounded.

Reads retry bounded transient statuses/timeouts with exponential backoff,
jitter, and `Retry-After`. Mutations retry ambiguous failures only when the Odoo
idempotency capability is available. Each retry re-enters the origin
coordinator.

### Dynamic discovery

`discover_models` reads `/doc-bearer/index.json`; `describe_model_api` reads the
model document. These endpoints are authenticated and reflect readable models,
field access, and public methods for the current user. If unavailable, the MCP
falls back to `ir.model`, `fields_get`, and form view actions. View actions are
supplementary hints rather than a complete method catalog.

The implementation was checked against the local Odoo `api_doc` and JSON-2
controllers without modifying the Odoo checkout.

## Transaction model

Odoo creates one SQL transaction per JSON-2 request. A batch/composite MCP tool
can therefore span several independent transactions. Deterministic child
idempotency keys make each step replayable, but do not add rollback between
steps. Business workflows requiring atomicity belong in one public Odoo method.

The optional `usl_json2_idempotency` add-on stores the mutation result in the
same transaction as the business change. The Worker never substitutes a
Durable Object commit ledger for database truth.

## Context flow

Generic mutating tools accept legitimate `odoo_context`. Before transport, the
MCP merges it with any method context and overwrites reserved attribution:

- `usl_agent_origin`;
- `usl_correlation_id`;
- `usl_agent_reason`;
- `usl_idempotency_key`;
- `usl_idempotency_mode`.

The caller cannot spoof these fields. The Odoo add-ons decide how to persist
them as immutable audit evidence.

## Error flow

Transport produces typed `OdooError` values. Mutation scope wraps failures with
execution metadata and calculates `succeeded`, `not_applied`, or `unknown`.
Tool adapters add Odoo refusal-layer diagnostics without changing the refusal.
Credentials and request values are not reflected.

## Bindings and migration

`wrangler.jsonc` declares:

- `McpAgent`;
- `AccountingAgent`;
- `ProjectsAgent`;
- `DocumentsAgent`;
- `OdooOriginCoordinator` (migration `v4`);
- `OAUTH_KV`.

The deployment intentionally does not enable strict-public global fetch because
private/internal HTTPS Odoo origins are supported.

## Adding tools

- Generic functionality should use the universal primitives and Odoo discovery.
- A dedicated tool should justify its fixed intent by reducing calls or
  producing clearer structured evidence.
- Mutation tools use `runMutation`, accept `reason` and `idempotency_key`, and
  return execution metadata.
- Composite step names must be stable across exact retries.
- Post-write readback failures must not imply the write was absent; return the
  succeeded execution metadata and a warning/error that says the record may
  already be changed.
- Record results should carry canonical Odoo URLs.
- Bump `SERVER_VERSION` for any tool-surface schema change.
