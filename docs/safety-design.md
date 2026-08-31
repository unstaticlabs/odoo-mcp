# MCP safety design

This document is the normative safety boundary for `odoo-mcp` 1.0.

## Design principle

The MCP is a reliable transport and usability layer, not a second Odoo
authorization engine. A valid credential is treated like the corresponding
regular Odoo user. Odoo decides:

- model access rights and field access;
- record rules and selected-company visibility;
- public method availability and signatures;
- workflow and accounting validation;
- locks, hashes, and inalterability rules;
- the USL Irreversible Actions policy.

The MCP forwards an authorized human's request even when it is irreversible.
An AI Agent identity remains blocked from protected actions by
`usl_access_control` inside Odoo. The MCP reports that denial and never offers a
bypass. If an Odoo installation lacks the USL policy, that installation's
native behavior is authoritative.

## Removed connector policy

The following mechanisms are intentionally absent:

- signed confirmation challenges and runtime confirmation secrets;
- generic model and field authorization lists;
- inferred financial-field or business-risk denials;
- connector-maintained irreversible method classes;
- generic lifecycle method/state lists and mandatory preflight reads;
- project Waiting/In-Progress gates;
- inventory duplicate authorization gates;
- mandatory audit-context prose.

Discovery actions do not carry connector `executable`, confirmation, or denial
annotations. The presence of a view button is only a UI hint; authenticated
API documentation defines the public method catalog, and Odoo decides whether
the current user and records may execute it.

Fixed-intent domain tools remain deliberately narrower than generic tools. A
draft-vendor-bill helper may require a draft vendor bill and accept only fields
that preserve that named intent. These checks protect the helper's advertised
contract; they do not prohibit the same user from choosing a generic Odoo route.

## Trust boundaries

```text
MCP client
  | untrusted tool arguments and Odoo target configuration
  v
Worker ingress
  | validates auth shape, body size, URL/origin and database
  v
MCP tool layer
  | validates transport shapes and fixed-intent promises
  | adds reserved correlation/audit context
  v
origin-keyed Durable Object
  | bounds and serializes complete physical requests
  v
Odoo JSON-2 / doc-bearer
  | authenticates and authorizes the Odoo identity
  | owns business transaction and irreversible policy
  v
Odoo data and responses (untrusted content returned to the agent)
```

Odoo content is trusted as data returned by the selected backend, but not as an
instruction source. Tool descriptions and the operations guide tell agents not
to let chatter, records, attachments, or API documentation override the user's
intent or provide authorization.

## Authentication and credentials

Header authentication carries an Odoo API key, root Odoo origin, and database
on each request. The key is held only in memory and is never written to
Durable Object storage or logs. Before the session invokes Odoo, a fixed
`res.users.fields_get` call validates the credential tuple. Success is cached
briefly in that MCP session. Failure text is standardized so arbitrary internal
response bodies are not reflected.

OAuth is a compatibility shim for clients unable to set headers. It verifies
the same credential tuple at authorization time. The OAuth provider encrypts
grant props in KV; token secrets are not stored as plaintext. Downstream tools
receive the same connection shape as the header path.

Error details are normalized and scrub bearer/API-key-looking strings. The
origin coordinator never logs or persists headers, request bodies, or
responses.

## Outbound target boundary

`normalizeOdooOrigin` applies to both auth paths:

- HTTPS is mandatory in hosted operation.
- An explicit development flag permits HTTP only to loopback hosts.
- Userinfo, query strings, fragments, and non-root paths are rejected.
- The Worker's own origin is rejected.
- Database names are non-empty, bounded, and control-character free.
- JSON-2 model and public-method identifiers use bounded Odoo/Python identifier
  forms; path traversal and private method names are rejected before fetch.
- Credential-bearing calls use `redirect: manual`; redirects become a redacted
  error.

The origin coordinator accepts only exact JSON-2 POST paths and authenticated
API-document GET paths. This is defense in depth against accidental use as an
arbitrary credentialed proxy.

Private/internal HTTPS targets are supported by design. DNS/private routing is
therefore an accepted residual SSRF risk. An operator who does not need this
feature should enforce a hostname policy or strict-public Cloudflare routing.

## Resource bounds

- MCP request bodies: 4 MiB, including requests without an honest
  `Content-Length`.
- Default Odoo JSON request: 4 MiB.
- Default Odoo JSON response: 16 MiB, enforced while streaming before parsing.
- API documentation: 8 MiB by default, enforced while streaming.
- Idempotency capability response: 64 KiB.
- Credential handshake response: 256 KiB.
- Tool-specific base64/PDF limits are checked before mutation.
- Read pagination and batch sizes are schema-bounded.
- The origin queue permits at most 50 waiting requests and 60 seconds of wait.

Oversized mutation responses are ambiguous at the MCP transport layer unless
Odoo's atomic idempotency extension can replay them. The Odoo extension itself
uses a stricter 2 MiB stored-result limit and must roll back a mutation whose
result cannot be retained.

## Global concurrency

Every production Odoo fetch—handshake, capability probe, documentation read,
ordinary read, mutation, and each retry attempt—is proxied through
`OdooOriginCoordinator`. Its Durable Object name is the normalized Odoo origin,
so all Worker isolates, MCP sessions, users, and endpoint surfaces share one
single-flight coordinator per origin. Different origins progress independently.

The coordinator starts the next request immediately after completion; it does
not release the slot merely because response headers arrived: the bounded
response body completes inside the slot. It does not impose historical
one-second spacing. Overload returns structured
`origin_busy` with `Retry-After` guidance. A queued timeout removes the request
from execution, so it cannot run later after the caller has received a refusal.

The local in-process queue exists only for tests or explicitly injected callers
without a Durable Object binding. It is not the production enforcement point.

## Idempotency and transaction truth

Every mutation has one root key and a correlation ID derived from that key.
Composite steps derive stable child keys. The same physical attempt and every
retry reuse the same key.

When Odoo advertises protocol version 1:

- requests carry `Idempotency-Key`;
- ambiguous timeouts, network failures, and gateway failures may be retried up
  to the bounded retry limit;
- Odoo performs reservation, business mutation, audit effects, and replay-result
  storage in one SQL transaction;
- an identical replay returns the stored result; a changed fingerprint is a
  conflict.

When capability discovery is absent or invalid, the MCP still sends the key but
makes exactly one mutation attempt. It reports mode `unavailable`. Explicit
Odoo 4xx/business errors are `not_applied`; timeouts, network failures,
redirects, oversized responses, and ambiguous gateway failures are `unknown`.
The MCP never uses a Durable Object ledger to claim a database commit outcome.

Several JSON-2 calls are several Odoo transactions. Stable child keys make
replay safer but cannot provide cross-call rollback. A single Odoo public method
is required for related atomic changes.

See [Odoo idempotency protocol](idempotency-protocol.md).

## Context and audit evidence

Generic mutating tools accept:

- `reason`: bounded human/agent intent for audit evidence;
- `odoo_context`: legitimate Odoo language, timezone, company, and documented
  method context;
- `idempotency_key`: opaque mutation identity.

The MCP removes caller values for reserved keys and writes its own
`usl_agent_origin`, `usl_correlation_id`, `usl_agent_reason`,
`usl_idempotency_key`, and `usl_idempotency_mode`. Existing business context
and requested business context are otherwise merged. The Odoo audit add-on is
responsible for immutability and for excluding its own internal idempotency rows
from recursive mutation auditing.

## Error truthfulness

Odoo refusals retain their redacted detail and are classified without changing
the decision:

- ACL;
- record rule;
- irreversible policy;
- workflow state;
- lock date;
- hash/inalterability;
- schema;
- business validation;
- transport.

The next-step text tells agents to accept Odoo authorization denials. It may
suggest correcting a schema, state, or validation issue, but never suggests an
MCP bypass.

Mutation failures include execution metadata. `outcome_unknown` is
non-recoverable by blind repetition: inspect Odoo, then reuse the returned key
and identical arguments if retry is appropriate. A post-write readback anomaly
reports the already-succeeded execution metadata so a committed mutation is not
mistaken for a preflight refusal.

## Advisory previews

`bookkeeping.preview_write` and domain dry-run modes may read schema and current
records, resolve targets, and return warnings plus a suggested call. They issue
no authorization artifact and are never prerequisites. There is no universal
rollback dry-run because public methods can have method-specific or external
effects that a generic transaction wrapper cannot honestly model.

## Residual risks and explicit non-goals

- Private/internal HTTPS targets remain allowed.
- A compromised or over-privileged Odoo credential has exactly that Odoo user's
  reach; MCP cannot repair Odoo privilege design.
- An authorized human may perform irreversible actions.
- Odoo installations without the USL action policy behave according to their
  own rules.
- Composite MCP workflows are not atomic across calls.
- Idempotency evidence expires after seven days.
- Focused endpoint composition is not a security boundary and is unchanged in
  this release.
- Content-level prompt injection is reduced by guidance, not eliminated by a
  data transformation layer.

## Release gates

Release requires typecheck, the full Bun suite, Wrangler dry-run, Durable Object
integration coverage, URL/redaction tests, dynamic discovery/fallback tests, and
an end-to-end Odoo forced-response-loss test. The Odoo add-on must separately
pass action-risk inventory/runtime checks proving it adds no privilege or
mutation sink.
