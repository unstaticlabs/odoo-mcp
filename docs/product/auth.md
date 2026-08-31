# Authentication and Odoo authority

Every MCP call ultimately uses one Odoo user's API key. Odoo authentication,
ACLs, record rules, field access, company scope, workflow checks, and action
policy are authoritative. The Worker has no shared Odoo service account and no
parallel scope/permission model.

## Two ingress paths, one identity

### Header/BYO-key path

```text
Authorization: Bearer <odoo-api-key>
X-Odoo-Url: https://acme.odoo.com
X-Odoo-Db: acme-prod
```

Any `X-Odoo-*` header selects this path. All three values must be present and
valid. Credentials arrive on each request, remain in memory, and are not stored
in KV or Durable Object storage.

Before the MCP session can call arbitrary Odoo models/methods, it performs one
fixed, bounded `res.users.fields_get` handshake through the origin coordinator.
A successful tuple is cached for five minutes in that session. Failure returns
a standard redacted diagnostic rather than an arbitrary internal response.

### OAuth compatibility shim

Clients unable to set static headers use authorization code + PKCE:

1. The client discovers OAuth metadata and dynamically registers.
2. `/authorize` shows a hosted form for Odoo origin, database, and API key.
3. The Worker validates and normalizes the target, then performs the same fixed
   Odoo credential call through the origin coordinator.
4. `@cloudflare/workers-oauth-provider` stores encrypted grant props in
   `OAUTH_KV` and issues access/refresh tokens.
5. On MCP requests, the provider decrypts the grant into the same connection
   props used by the header path.

Access tokens live one hour. Refresh grants live one year from initial
authorization; client registrations live two years. Reauthorization is required
after grant expiry or revocation.

## Authorization behavior

- A read-only Odoo user remains read-only.
- A record rule continues to hide or deny the same records.
- An Odoo AI Agent identity remains subject to `usl_access_control` and cannot
  perform actions classified as irreversible there.
- A human identity with Irreversible Actions permission may exercise it through
  the MCP.
- An installation without the USL add-on behaves according to its own Odoo
  policy.

Focused endpoint membership is a usability choice, not an authorization
boundary. Tokens are not endpoint-scoped; every endpoint calls Odoo using the
same resolved user identity.

## Target validation

Both paths use the same validator:

- root HTTPS origin required in hosted use;
- explicit local-development flag plus loopback required for HTTP;
- URL credentials, paths, queries, fragments, malformed hosts, and the Worker's
  own origin rejected;
- database non-empty, at most 128 characters, and control-character free;
- redirects refused for credential-bearing calls.

Arbitrary private/internal HTTPS origins are accepted by product decision. This
means target risk is constrained rather than eliminated. Operators can impose a
hostname policy or public-only Cloudflare routing if their deployment does not
need private Odoo instances.

## Credential storage and redaction

Header credentials are never persisted. OAuth grant props are encrypted by the
provider in KV; token secrets are stored as hashes. Plaintext credentials exist
only while processing the authorization form or an authenticated call.

The implementation does not log authorization headers, Odoo API keys, request
bodies, or response bodies. Error details scrub bearer tokens and Odoo-key-like
values. The origin coordinator stores nothing and retains a `Request` only while
it is queued or in flight.

## Revocation

Revoking the Odoo API key invalidates both paths at Odoo. For OAuth, deleting the
grant from `OAUTH_KV` also makes outstanding tokens unusable because their grant
props can no longer be recovered. Reconnect the client to establish a new grant
or refresh the Odoo target/database/key.

## Rejected design: service account plus MCP scopes

A shared Odoo service identity would require the MCP to recreate Odoo's evolving
authorization and company rules. That duplicated policy would drift and create
an over-privileged credential. Per-user credentials reuse the actual Odoo
authority and preserve ordinary audit attribution.
