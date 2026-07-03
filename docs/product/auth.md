# Auth: bring-your-own-key (BYO-key)

**v1 has no OAuth.** Authentication and authorization are both delegated to
Odoo: each user supplies their **own Odoo instance URL + Odoo API key**, and the
server calls Odoo **as that user**. Odoo's per-user permissions and record-rules
*are* the authorization layer.

## The core idea

There is no shared service account, no scope system, no user store, and no
per-user config in `odoo-mcp`. The server is **stateless and configless**.

- A user's Odoo API key already encodes exactly what that user may do in Odoo.
- When `odoo-mcp` calls Odoo with that key, Odoo applies the user's groups,
  access-control lists, and record-rules automatically.
- Therefore: **if a user can't do it in Odoo, they can't do it through
  `odoo-mcp`.** A read-only Odoo user cannot write even when a write tool exists;
  a user who can't see a project simply gets nothing back for it.

This makes authorization Odoo's problem, which is exactly where the source of
truth already lives.

## How the key reaches the server

### Hosted HTTP (the Cloudflare Worker)

The user's Odoo credentials arrive on **each request** via headers. Proposed
contract:

| Header                    | Value                              | Purpose                        |
| ------------------------- | ---------------------------------- | ------------------------------ |
| `Authorization`           | `Bearer <odoo-api-key>`            | The caller's Odoo API key      |
| `X-Odoo-Url`              | `https://acme.odoo.com`            | The Odoo origin to call        |
| `X-Odoo-Db`               | `acme-prod`                        | The Odoo database name         |

The Worker reads these, builds a per-request `OdooClient`, and forwards to Odoo
as:

```
POST https://acme.odoo.com/json/2/{model}/{method}
Authorization: Bearer <odoo-api-key>
X-Odoo-Database: acme-prod
```

Notes:
- `Authorization: Bearer` is reused for the Odoo key because it is the header
  MCP HTTP clients most reliably let you set, and it maps 1:1 onto what Odoo's
  JSON-2 API itself expects. `X-Odoo-Url` / `X-Odoo-Db` are custom headers for
  the two remaining pieces of connection info.
- This contract is a **proposal** — if a target client can only set one custom
  header, we can fold URL+db into a single structured header or into the
  `Authorization` value. The header names above are the current default.

### Local / stdio-style clients

For a client that launches `odoo-mcp` as a local process (stdio), the credentials
come from the **environment / client config** (e.g. `.dev.vars` in dev, or the
client's MCP server env block), not from an HTTP header. In this mode the key
**never leaves the machine**.

## Security tradeoffs

- **Over HTTP**, the Odoo key transits the Worker **transiently** — it lives only
  for the duration of the request, is used to construct the outbound Odoo call,
  and is never persisted or logged. Because the Worker runs on the user's own
  Cloudflare hosting (Unstatic Labs), this is an acceptable trust boundary: the
  key passes through infrastructure the operator already controls, over TLS, and
  is never written down.
- **Over stdio**, the key never leaves the user's machine at all — strictly
  better.
- **Redaction:** the key (and any Odoo secrets) must be redacted from all logs
  and error surfaces. Never echo the `Authorization` header or a raw Odoo key
  into observability, tool output, or error messages.
- **No persistence on the header path:** the server keeps no user store and
  writes no credential to KV/D1/DO storage for header-authenticated requests.
  The one exception is the ChatGPT OAuth shim below, which stores credentials
  **encrypted** in KV because ChatGPT cannot send headers.

## The ChatGPT OAuth shim (implemented)

Claude clients (Claude Code, Claude desktop/web) can pass a static API-key
header, so BYO-key works for them directly.

ChatGPT's remote-connector UI (Settings → Apps & Connectors → Developer Mode)
cannot set static headers — its auth model is OAuth-only. Since Odoo has no
OAuth endpoint we can delegate to, the Worker now carries a **thin OAuth 2.1
shim scoped to that path**: a credential vault behind an OAuth-shaped front
door, built on
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).

How it works:

1. ChatGPT discovers the server via `/.well-known/oauth-authorization-server`,
   registers itself dynamically (`/register`, RFC 7591), and starts the
   authorization-code + PKCE flow.
2. `/authorize` is a hosted form (served by the Worker, no frontend build)
   where the user pastes **their own** Odoo URL, database, and API key — the
   same three values the header contract carries.
3. The shim validates the credentials with a real lightweight Odoo call
   (`res.users` `fields_get`) before accepting them; Odoo rejections fail the
   flow with a clear, redacted error.
4. On success the credentials become the grant's `props` and the standard code
   exchange completes at `/token`. Access tokens expire after **1 hour**;
   refresh tokens (30 days) let ChatGPT renew silently.
5. On each token-authenticated `/mcp` request, the provider resolves the token
   back to the stored credentials and injects them as the **same `Props`
   object** the header path builds. Everything downstream — `McpAgent`, every
   tool — is identical and cannot tell the two auth paths apart.

Requests to `/mcp` that carry any `X-Odoo-*` header take the raw BYO-key path
exactly as before; requests without them are treated as OAuth. Both paths
coexist on the same endpoint.

### Stored-credential security

The OAuth path is the *only* place `odoo-mcp` persists a credential, and it is
never stored in plaintext:

- **Encryption at rest:** `workers-oauth-provider` end-to-end encrypts grant
  `props` (the Odoo URL/db/key) in the `OAUTH_KV` namespace. The AES key
  material is wrapped by the access/refresh token itself, so the stored blob
  can only be decrypted by a request that presents the actual token — neither
  a KV dump nor the Worker at rest can recover the key. Token secrets
  themselves are stored only as hashes.
- **Scope discipline:** one grant maps to exactly one Odoo credential set.
  There is still no user store, no scopes/permissions model, no session system
  — Odoo's per-user permissions remain the entire authorization layer.
- **Redaction:** the plaintext key exists only inside the `/authorize` form
  POST → validation call → grant creation. It is never logged, echoed into
  error pages, or re-filled into the form after a failed attempt.
- **Revocation:** delete the grant from KV and the tokens die with it (their
  decryption key material is gone). Manual path:
  `npx wrangler kv key list --binding OAUTH_KV --remote --prefix grant:` then
  `npx wrangler kv key delete --binding OAUTH_KV --remote "<grant key>"`.
  Programmatic path: `env.OAUTH_PROVIDER.listGrants(userId)` /
  `revokeGrant(grantId)`. Re-authorizing from ChatGPT also revokes prior
  grants for the same user+client automatically.

## Rejected alternative: one service account + OAuth scopes

The alternative we considered and rejected was:

- One **restricted Odoo service account** shared by all users.
- **OAuth with scopes** in `odoo-mcp` deciding who may call which tools.

Why BYO-key won:

- **Simpler.** No user store, no scope definitions, no consent screens, no OAuth
  provider to run and secure for v1.
- **Stateless.** Nothing to persist; the server is a pure pass-through.
- **Odoo enforces per-user authz.** With a shared service account we would have
  to *re-implement* Odoo's permission model as scopes and keep it in sync forever
  — a second, weaker copy of authorization that would inevitably drift from
  Odoo's real record-rules. BYO-key reuses the real thing.
- **Least privilege for free.** Each caller acts as exactly themselves; there is
  no over-privileged shared account whose key, if leaked, exposes everyone's
  data.

The only thing the service-account approach bought was a single credential to
manage — which is precisely the thing that made it a weaker security and
maintenance story. BYO-key trades that away deliberately.
