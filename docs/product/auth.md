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
- **No persistence:** the server keeps no user store and writes no credential to
  KV/D1/DO storage. The only DO is the rate limiter, which is keyed by Odoo
  *origin* (not by key) and stores no secrets.

## The ChatGPT caveat (the one edge case)

Claude clients (Claude Code, Claude desktop/web) can pass a static API-key
header, so BYO-key works for them directly.

**ChatGPT's remote-connector auth may not support a static API-key header.** Its
connector model leans on OAuth. If ChatGPT cannot pass the `Authorization: Bearer
<odoo-api-key>` header we require, then — and *only* then — we add a **thin OAuth
shim on that path**: a minimal OAuth front that, after the user authorizes,
resolves back to a specific Odoo key/instance and injects it into the same
per-request BYO-key flow. Everything downstream of the shim is unchanged.

This OAuth shim is **explicitly out of scope for v1** and is only built if
ChatGPT compatibility actually requires it. See the branch in
[`roadmap.md`](./roadmap.md).

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
