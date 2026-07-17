# Roadmap

Milestones ship **read-only first per domain**, then writes. Each domain's
writes are automatically bounded by the caller's Odoo permissions (see
[`auth.md`](./auth.md)), so "add writes" is mostly about tool surface, not a new
authorization system.

## M1 — Projects, read-only

**Goal: prove the whole spine end to end.** Transport + BYO-key + a real Odoo
read + client connectivity.

- Cloudflare Worker with `McpAgent` serving **Streamable HTTP at `/mcp`**.
- Thin JSON-2 `OdooClient` (read path only).
- Per-request BYO-key: read `Authorization: Bearer`, `X-Odoo-Url`, `X-Odoo-Db`;
  call Odoo as that user.
- Per-origin **rate-limiter Durable Object** (token bucket, ~1 req/s).
- `projects.*` **read** tools: e.g. `list_projects`, `list_tasks`, `list_chatter`,
  `get_task`, `list_stages`.
- **Local dev proven:** `wrangler dev` + MCP **Inspector** against
  `http://localhost:8787/mcp`, secrets in `.dev.vars`, dev auth bypass working.
- **Clients connect:** Claude Code and Claude connect to the hosted endpoint and
  list/call tools. First real ChatGPT connection attempt happens here — this is
  where we learn whether the ChatGPT auth caveat bites (see the branch below).
- **Deployed** to Cloudflare / **Unstatic Labs** via `wrangler deploy`.

**Exit criteria:** a client with a real Odoo key can list projects and tasks
through the hosted `/mcp`, and the rate limiter demonstrably spaces calls.

## M2 — Projects, write

- `projects.*` **write** tools: `create_task`, `update_task`, `move_task`
  (stage change), comments, tags — using the batched `create` (`vals_list`) and
  `write` (`ids` + `vals`) shapes.
- Each write tool tagged as write in its metadata.
- Writes rely entirely on the caller's Odoo permissions — no scope logic added.
- Harden error surfaces (Odoo 4xx → actionable messages; redaction verified).

**Exit criteria:** a client can create and move a task and see it reflected in
Odoo, and a read-only Odoo key is correctly refused the write by Odoo itself.

## M3 — Booking

- `booking.*` **read** tools first (list/get bookings).
- Then `booking.*` **write** (create booking).
- Reuses the same client, rate limiter, and BYO-key flow; only new tools.

## M4 — Billing

- **First write slice (shipped):** draft expense + draft vendor-bill (`in_invoice`)
  pre-configuration via `billing.update_draft_expense` /
  `billing.configure_draft_vendor_bill` (draft-only allowlists; no validate/post).
- `billing.*` **read** tools still future (list/get invoices).
- Later `billing.*` **write**: create invoice, link records (e.g. invoice ↔ task/
  project/booking).
- Same infra; billing is just more Odoo models behind the same gateway.

## Branch — OAuth only if ChatGPT needs it ✅ (shipped)

The condition fired: ChatGPT's Developer-Mode connector UI only takes a name +
URL — no static headers — so the shim was built. What shipped:

- OAuth 2.1 authorization-code + PKCE flow via
  `@cloudflare/workers-oauth-provider`: `/authorize`, `/token`, `/register`
  (dynamic client registration), and `/.well-known/*` discovery metadata.
- `/authorize` is a hosted form where the user pastes their own Odoo
  URL/db/API key; the shim verifies them with a real `res.users` `fields_get`
  call before completing the grant.
- Credentials are stored **end-to-end encrypted** as grant props in a new
  `OAUTH_KV` namespace; token-authenticated `/mcp` requests resolve back to
  the exact same `Props` object the header path builds. Access tokens live
  1 hour, refresh tokens 30 days. See [`auth.md`](./auth.md) for the security
  model and revocation.
- The raw header path is untouched: any `/mcp` request with an `X-Odoo-*`
  header bypasses the shim entirely. Tools remain auth-path-agnostic.
- **Non-goal held:** no user store, no scopes/permissions model, no session
  system — the shim maps one OAuth grant to one Odoo credential set, nothing
  more.

## Cross-cutting — CI gate (dogfood)

This repo is managed by the autonomous-dev-pipeline (Odoo board 17), so it needs
a **`.ci.json`** gate: **build + typecheck + `wrangler deploy --dry-run`**. Land
this early (alongside/after M1) so the pipeline gets a real pass/fail signal on
changes to `odoo-mcp` without deploying.
