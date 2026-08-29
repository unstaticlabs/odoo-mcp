# odoo-mcp

A Cloudflare Workers MCP server that exposes Odoo as a general agent gateway.
The authenticated Odoo user is the authority for access rights, record rules,
field access, company scope, workflows, and irreversible-action policy. The MCP
does not maintain a second authorization policy.

Server/tool-surface version: **1.0.0**.

## What changed in 1.0

This is a breaking safety and reliability redesign:

- `create_record`, `update_record`, `batch_update`, `delete_record`, chatter
  tools, and `call_model_method` are available for every valid Odoo model and
  public JSON-2 method on `/mcp`.
- MCP confirmation tokens, model/field authorization lists, lifecycle gates,
  inferred-risk denials, mandatory state preflights, and the runtime secret for
  signing confirmations are removed.
- Mutation inputs use optional `reason`, `odoo_context`, and
  `idempotency_key`. The former audit-only context string is removed.
- Every attempted mutation reports `idempotency_key`, `idempotency_mode`,
  `replayed`, `correlation_id`, and `outcome`.
- All physical Odoo requests are globally single-flight per normalized Odoo
  origin through `OdooOriginCoordinator`.
- Odoo target URLs and payloads are bounded and validated. Credential-bearing
  redirects are never followed.
- Authenticated `/doc-bearer` discovery exposes visible models, fields, and
  public methods, with ORM/view fallback.
- `bookkeeping.preview_write` is advisory. Dry-run helpers never authorize a
  later operation.

Existing focused endpoint composition is unchanged:

| Endpoint | Surface |
| --- | --- |
| `/mcp` | Full generic and domain tool surface |
| `/accounting/mcp` | Accounting, billing, inventory, feedback, and advisory accounting tools |
| `/projects/mcp` | Project and feedback tools |
| `/documents/mcp` | Governed Documents facade |

Clients must reconnect after deployment so they refresh the 1.0 tool schemas.

## Authority and safety boundary

For a valid credential, the MCP sends what Odoo permits. An Odoo AI Agent
identity remains subject to `usl_access_control`; a human identity with
Irreversible Actions permission can exercise that permission through this MCP.
On installations without that add-on, the MCP honors the installation's native
policy.

The MCP still owns its boundary:

- input and identifier shape validation;
- HTTPS/origin validation and redirect refusal;
- request, response, attachment, PDF, pagination, and queue bounds;
- per-origin physical-request serialization;
- idempotency protocol negotiation and truthful ambiguity;
- reserved audit-context attribution;
- credential redaction and non-persistence on the header path;
- stable Odoo error classification and observability.

Odoo records, chatter, documents, and API documentation are untrusted data.
They are never treated as authorization or as instructions that override the
user's request.

See [Safety design](docs/safety-design.md) for the full trust model.

## Authentication

### Header/BYO-key

Send these headers on every MCP request:

```text
Authorization: Bearer <odoo-api-key>
X-Odoo-Url: https://acme.odoo.com
X-Odoo-Db: acme-prod
```

Before a header-authenticated session makes Odoo calls, the server performs a
fixed, bounded, redacted `res.users.fields_get` handshake. Credentials are not
persisted or logged.

### OAuth shim

Clients that cannot supply static headers use the built-in authorization-code
and PKCE flow. The hosted form collects and verifies the same Odoo URL, database,
and API key. Grant props are encrypted by
`@cloudflare/workers-oauth-provider` in `OAUTH_KV`.

Both paths become the same in-memory connection props and call Odoo as the same
user. See [Authentication](docs/product/auth.md).

## Odoo target rules

- Hosted deployments require HTTPS.
- HTTP is allowed only when `ALLOW_LOCAL_HTTP_ODOO=true` and the target is
  loopback (`localhost`, `127.0.0.0/8`, or `::1`).
- The configured value must be a root origin. Credentials, paths, queries, and
  fragments are rejected.
- The target cannot equal the Worker's own public origin.
- Redirects are not followed.
- Private/internal HTTPS origins are intentionally supported. This is a product
  decision: SSRF risk is constrained, not eliminated. Operators that need a
  public-only boundary must add an operator hostname policy or Cloudflare's
  strict-public routing control.

## Generic JSON-2 operations

Use discovery before calling generic operations:

1. `discover_models` searches and paginates the authenticated model catalog.
2. `describe_model_api` returns fields and all documented public methods,
   signatures, parameters, and docs.
3. `get_fields` and `list_model_actions` provide ORM/schema and supplementary UI
   hints.
4. Call generic CRUD or `call_model_method` with exact named arguments.

`call_model_method` is JSON-2-native: it accepts `model`, `method`, optional
`ids`, named `kwargs`, optional `odoo_context`, `reason`, and
`idempotency_key`. Positional `args` are not supported.

Each JSON-2 request is its own SQL transaction. When several related changes
must be atomic, expose or call one Odoo public method that performs the whole
workflow.

For x2many fields, use Odoo command triples:

```text
[0, 0, values]  create related record
[1, id, values] update related record
[2, id, 0]      delete related record
[3, id, 0]      unlink relation
[4, id, 0]      link existing record
[5, 0, 0]       clear relations
[6, 0, ids]     replace relations
```

Generic read results carry `_web_url`; generic create/update results carry
`web_url` or `web_urls`. Cite those links rather than bare record IDs.

## Mutation reliability

Every mutating tool accepts an optional opaque `idempotency_key`. Omit it for a
new UUID. Reuse a key only for the exact same logical mutation and identical
business arguments.

```json
{
  "idempotency_key": "expense-submit-2026-08-29-42",
  "idempotency_mode": "odoo_atomic",
  "replayed": false,
  "correlation_id": "mcp-...",
  "outcome": "succeeded",
  "expires_at": "..."
}
```

`odoo_atomic` requires the separately governed Odoo add-on described in
[Odoo idempotency protocol](docs/idempotency-protocol.md). Without that
capability the MCP makes exactly one mutation attempt, reports
`idempotency_mode: "unavailable"`, and never pretends a timeout or lost response
is safe. An ambiguous failure returns `outcome_unknown`; reconcile in Odoo, then
retry only with the returned key and identical arguments.

Composite and batch tools derive deterministic child keys from the root key and
stable step/index names. This makes retries stable but does not make several
independent Odoo transactions atomic.

## Agent guidance

All endpoint servers publish concise initialization instructions plus:

- resource `odoo://guide/operations`;
- prompt `plan_odoo_operation`;
- compact per-tool descriptions.

The guide teaches discovery, untrusted-data handling, read-before-write,
multi-company context, x2many commands, one-method atomicity, idempotency,
ambiguity reconciliation, Odoo denial handling, and record-link citation.

Dedicated helpers remain useful when their fixed intent reduces calls. They may
validate promises in their names—for example, a tool named “configure draft
vendor bill” may require a draft vendor bill—but generic `/mcp` operations are
never blocked merely because a dedicated helper is narrower.

## Development

```bash
npm ci
npm run typecheck
bun test
npm run test:miniflare
npx wrangler deploy --dry-run
npx wrangler dev
```

Miniflare exercises the Durable Object bindings declared in `wrangler.jsonc`.
Use MCP Inspector against `http://localhost:8787/mcp`. Local HTTP Odoo targets
need the explicit loopback flag; external targets still require HTTPS.

Before release, run the checks in [Testing](docs/testing.md), including
multi-session origin serialization and an end-to-end forced-response-loss test
against an Odoo deployment with the idempotency add-on.

## Odoo-side dependency

This repository does **not** modify or bundle Odoo. The sibling Odoo checkout
was inspected read-only to confirm the native JSON-2 dispatcher and
`/doc-bearer` document shapes. Exact replay semantics require
`usl_json2_idempotency` to land through the Odoo repository's own review,
action-risk, and deployment process before this MCP can report `odoo_atomic`.

## Further documentation

- [Safety design](docs/safety-design.md)
- [Odoo idempotency protocol](docs/idempotency-protocol.md)
- [Architecture](docs/product/architecture.md)
- [Authentication](docs/product/auth.md)
- [Accounting and advisory previews](docs/bookkeeping.md)
- [Testing](docs/testing.md)
- [Documents facade](docs/product/documents.md)
