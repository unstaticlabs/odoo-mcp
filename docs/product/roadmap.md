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
- `projects.*` **read** tools: e.g. `list_projects`, `list_tasks`, `get_task`,
  `list_stages`.
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

- `billing.*` **read** tools first (list/get invoices).
- Then `billing.*` **write**: create invoice, link records (e.g. invoice ↔ task/
  project/booking).
- Same infra; billing is just more Odoo models behind the same gateway.

## Branch — OAuth only if ChatGPT needs it

Not a numbered milestone; a **conditional** branch triggered by M1's ChatGPT
connection attempt.

- **Condition:** ChatGPT's remote connector cannot pass a static API-key header,
  so BYO-key-over-header doesn't work for it.
- **Action:** add a **thin OAuth shim on the ChatGPT path only**. After OAuth,
  resolve back to a specific Odoo key/instance and inject it into the existing
  per-request BYO-key flow. No other client is affected; the core stays
  stateless/BYO-key.
- **Non-goal:** a general OAuth + scopes system. We do not build a user store or
  scope model. The shim is the minimum needed to satisfy one client's transport
  auth.

## Cross-cutting — CI gate (dogfood)

This repo is managed by the autonomous-dev-pipeline (Odoo board 17), so it needs
a **`.ci.json`** gate: **build + typecheck + `wrangler deploy --dry-run`**. Land
this early (alongside/after M1) so the pipeline gets a real pass/fail signal on
changes to `odoo-mcp` without deploying.
