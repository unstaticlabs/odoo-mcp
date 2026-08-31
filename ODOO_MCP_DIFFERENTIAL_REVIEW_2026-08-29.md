# Odoo-authoritative safety redesign: differential security review

Date: 2026-08-29

Branch: `codex/odoo-authoritative-safety-refactor`

Baseline: `main`

## Outcome

No unresolved High-severity MCP finding remains in this differential. The
review found two reliability issues at the outbound-response boundary and one
diagnostic classification issue; all three were fixed and covered by tests
before this report was finalized.

The Odoo atomic-idempotency add-on is intentionally not part of this
repository change. Until that separately reviewed add-on is deployed, the MCP
reports `idempotency_mode: "unavailable"`, attempts each mutation once, and
reports ambiguous transport failures as `outcome_unknown`.

## Scope and blast radius

The review covered every changed production TypeScript file, Worker routing
and bindings, generic and dedicated mutation tools, authentication paths,
dynamic API discovery, error serialization, new tests, and operator/agent
documentation.

The largest intentional blast-radius change is `/mcp`: generic CRUD and
`call_model_method` now reach arbitrary Odoo models and public methods. This is
not an unauthenticated expansion. Every request still uses the supplied Odoo
identity, and native Odoo authentication, ACLs, record rules, field access,
company scope, method publication, workflow validation, and irreversible-action
policy remain authoritative.

Every physical Odoo call now passes through the origin-keyed Durable Object in
production. Every mutating tool uses the shared mutation execution contract or
receives not-applied metadata for a local fixed-intent refusal.

## Findings resolved during review

### High — origin serialization ended before the response body completed

The first coordinator implementation released its per-origin slot as soon as
`fetch()` returned response headers. A slow response body could therefore
overlap the next physical request, falling short of full-call single-flight.

Resolution: the coordinator now consumes and bounds the complete response
inside the slot before releasing the next request. A regression test holds the
first response stream open and proves the second fetch does not start.

### High — interrupted response streams could be reported as not applied

A response-body stream error escaped `readBoundedText` as a plain runtime
exception. In a mutation with no completed scope call, that could be reduced to
`not_applied` even though Odoo might already have committed before the response
was interrupted.

Resolution: interrupted streams are now typed `network_error` failures with
`mutationOutcome: "unknown"`. The mutation envelope therefore requires
reconciliation and same-key retry rather than inviting a fresh write.

### Medium — an ordinary ACL message could be labeled as a record rule

The fallback diagnostic heuristic treated every “not allowed to access” phrase
as a record-rule denial. Odoo uses similar wording for ordinary model ACLs.

Resolution: record-rule classification now requires explicit record-rule or
security-restriction evidence; generic access messages remain ACL denials.

## Security properties verified

- Hosted targets require HTTPS. HTTP is restricted to explicitly enabled
  loopback development.
- Targets are normalized to an origin and reject URL credentials, path, query,
  fragment, malformed database names, and the Worker origin.
- Credential-bearing requests use `redirect: "manual"`.
- Header credentials receive a fixed, redacted, briefly cached handshake.
- The coordinator accepts only exact JSON-2 POST and authenticated API-document
  GET routes, enforces the named origin, holds at most 50 waiting requests, and
  limits waits to 60 seconds.
- Incoming MCP bodies, Odoo requests, Odoo responses, API documentation, base64
  attachments, PDFs, pagination, and batch widths are bounded.
- API keys, full request bodies, and full responses are not logged or persisted
  by the coordinator.
- Caller-provided context cannot spoof connector origin, correlation, reason,
  or idempotency attribution.
- Atomic-mode mutation retries retain one root key; composite children derive
  stable keys from step names or indices.
- Without negotiated Odoo atomic idempotency, mutations receive one attempt and
  ambiguous failures remain unknown.
- Odoo ACL, record-rule, validation, and irreversible-policy refusals retain
  structured Odoo-derived diagnostics; the MCP does not suggest a bypass.
- Optional previews return advice and suggested calls but never grant authority
  or become a prerequisite.

## Accepted boundaries and residual risks

- Arbitrary private/internal HTTPS Odoo origins remain supported. This is an
  explicit SSRF-risk acceptance; eliminating it requires strict-public routing
  or an operator hostname allowlist.
- A non-Agent Odoo user may perform any operation Odoo grants, including an
  irreversible action if that user has the corresponding Odoo permission. This
  is the intended authorization model.
- On installations without the USL irreversible-action policy, the MCP honors
  the installation's native behavior.
- Several JSON-2 calls are separate SQL transactions. Deterministic child keys
  make replay safer but do not create rollback across calls; atomic workflows
  require one Odoo public method.
- Exact replay remains unavailable until `usl_json2_idempotency` lands through
  the sibling Odoo repository's separate review and deployment workflow.
- Mutation error enrichment currently wraps registered SDK tools through the
  SDK registry/update surface. Tests pin the behavior, but an SDK upgrade must
  rerun the tool-schema and error-envelope contract suite.

## Verification evidence

- `npm run typecheck`
- `bun test` (full suite)
- `npm run test:miniflare`
- `npx wrangler deploy --dry-run`
- `git diff --check`
- focused tests for target validation, response bounds, stream interruption,
  mutation retries, capability negotiation, credential handshake, discovery
  fallback, coordinator queueing, and Odoo refusal diagnostics

The sibling `/Users/roger/projects/odoo` repository was inspected read-only and
was not modified.
