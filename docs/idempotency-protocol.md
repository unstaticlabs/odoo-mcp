# Odoo JSON-2 idempotency protocol

Status: MCP client implementation present; Odoo implementation is a separately
governed deployment dependency and is not bundled in this repository.

## Capability contract

The MCP probes this authenticated public JSON-2 method:

```text
model:  usl.json2.idempotency
method: get_capabilities
body:   {}
```

Protocol version 1 requires a result shaped as:

```json
{
  "protocol_version": "1",
  "retention_seconds": 604800,
  "result_size_limit": 2097152
}
```

An absent method, denial, timeout, malformed result, or another protocol version
means `idempotency_mode: "unavailable"`. Capability success is cached briefly
per Odoo origin/database in the MCP session.

## Required Odoo add-on

The separately reviewed add-on is named `usl_json2_idempotency`. It must:

1. Accept `Idempotency-Key` at the JSON-2 controller boundary without changing
   model public-method signatures.
2. Resolve the authenticated user and database, then invoke the same native
   JSON-2 public-method dispatcher used by ordinary requests.
3. Preserve authentication, ACLs, record rules, field access, action-risk
   guards, audit hooks, and the native transaction boundary.
4. Add no new callable mutation sink, `sudo()` bypass, or alternate public
   dispatcher.

The local Odoo sources confirm the native route is
`/json/2/<model>/<method>` and that it calls `get_public_method`, binds named
parameters, browses supplied `ids`, and invokes the method in the request's SQL
transaction. The add-on must wrap this path rather than reimplement those
rules.

## Key scope and fingerprint

A key is scoped by Odoo database and authenticated user. The reservation table
has a unique `(user_id, key)` constraint within the database.

The canonical request fingerprint covers:

- model;
- method;
- ordered record IDs;
- named business arguments;
- business-relevant Odoo context.

Canonicalization must be deterministic for JSON-compatible values and preserve
semantically meaningful list order. It must exclude transport/audit-only keys:

- `usl_agent_origin`;
- `usl_correlation_id`;
- `usl_agent_reason`;
- `usl_idempotency_key`;
- `usl_idempotency_mode`;
- any future explicitly versioned transport-only metadata.

The add-on stores the fingerprint, not the full request payload.

## Transaction algorithm

For `(user, key)`:

1. Atomically reserve a row under the unique constraint.
2. If a completed row exists with the same fingerprint, return its stored
   serializable result without invoking the method.
3. If the fingerprint differs, return HTTP 409 with code
   `idempotency_conflict`.
4. For the first request, invoke the native public-method dispatcher.
5. Serialize and size-check the result.
6. Store the result and completion/expiry evidence in the **same SQL
   transaction** as the business mutation.
7. Commit once. A business exception, serialization failure, or stored-result
   overflow rolls back the business mutation and reservation together.

Concurrent identical requests must serialize on the reservation so the public
method executes once. They must not spin or invoke the method optimistically.

Only successful, replayable results are retained. Failed business transactions
leave no committed reservation. This allows a corrected request to use a fresh
key and prevents a failure cache from becoming an authorization oracle.

## Result and retention bounds

- Maximum stored serialized result: 2 MiB.
- Retention: seven days from successful completion.
- Cleanup: daily internal scheduled job.
- Cleanup and internal row maintenance are not public agent operations.
- Rows are immutable and inaccessible to ordinary ORM users.
- Rows are excluded from recursive Agent mutation auditing.
- API keys and full request payloads are never stored.

If a result is larger than 2 MiB, the request fails and the whole business
transaction rolls back. Committing without replay evidence is prohibited.

## Response headers

Every successful first execution returns:

```text
Idempotency-Status: created
Idempotency-Expires-At: <RFC 3339 timestamp>
```

An identical replay returns the same result with:

```text
Idempotency-Status: replayed
Idempotency-Expires-At: <same expiry>
```

The MCP maps those headers to `replayed` and `expires_at`.

## MCP behavior

- Every logical mutation gets a root key. An omitted key becomes a UUID.
- The correlation ID is a domain-separated SHA-256 derivative of the root key.
- Batch/composite steps get deterministic child keys derived from the root key
  and stable step/index text.
- Reserved context metadata is MCP-authored and cannot be spoofed.
- Capability available: ambiguous attempts retry at most three times with the
  same key; `Retry-After`, exponential backoff, and jitter apply.
- Capability unavailable: exactly one mutation attempt; the key is still sent,
  but no atomic guarantee is claimed.
- Reads retain bounded retry independent of mutation capability.

Execution outcomes:

| Outcome | Meaning |
| --- | --- |
| `succeeded` | The MCP received a successful Odoo response (created or replayed). |
| `not_applied` | Odoo explicitly refused before commit, or local validation prevented an attempt. |
| `unknown` | A timeout, network loss, redirect, oversized response, or ambiguous gateway failure prevents commit determination. |

For `unknown`, inspect Odoo by business identity/correlation. Retry only the same
logical operation, same arguments, and same returned key. A new key could apply
the mutation twice.

## Odoo audit/action-risk requirements

The Odoo pull request must classify the controller behavior as transport over
the existing dispatcher. Evidence must show:

- Agent protected actions remain denied, including attempted `sudo()` paths;
- an authorized human can perform protected actions once;
- a replay creates no second business mutation and no second Agent audit event;
- correlation and bounded reason reach immutable audit evidence;
- internal rows cannot be read, written, unlinked, or invoked by ordinary ORM
  users;
- no credential or full payload is stored or logged.

## Required Odoo tests

- first execution and identical replay;
- concurrent same-key requests execute once;
- changed fingerprint conflicts;
- two users can independently use the same key;
- business failure rolls back reservation;
- commit followed by response loss replays the committed result;
- stored-result overflow rolls back;
- seven-day expiry and cleanup;
- Agent protected-action denial and authorized-human success;
- correlation/reason audit propagation;
- credential/payload non-storage.

## Deployment order

1. Land the add-on through the Odoo repository's own coding-agent/PR and
   action-risk gates.
2. Deploy and verify capability version 1.
3. Deploy MCP 1.0.
4. Reconnect clients to refresh schemas.
5. Monitor created/replayed counts, conflicts, unknown outcomes, coordinator
   overload, Odoo denials, and target-validation failures.
