# Architecture

`odoo-mcp` is a single Cloudflare Worker (TypeScript) that exposes Odoo as MCP
tools. It is stateless and configless: it holds no user database, no Odoo
credentials of its own, and no per-user state. The only stateful component is a
Durable Object used purely as a per-Odoo-origin rate limiter.

```
  MCP client (Claude Code, Claude, ChatGPT, other app)
        │  Streamable HTTP  (POST/GET /mcp)
        │  Authorization: Bearer <odoo-api-key>
        │  X-Odoo-Url: https://acme.odoo.com
        │  X-Odoo-Db:  acme-prod
        ▼
  ┌─────────────────────────────────────────────┐
  │  Cloudflare Worker  (McpAgent, TypeScript)   │
  │                                              │
  │   tools:  projects.*  booking.*  billing.*   │
  │            │                                 │
  │            ▼                                 │
  │   OdooClient (thin JSON-2 client)            │
  │            │                                 │
  │            ▼                                 │
  │   RateLimiter Durable Object (1 per origin)  │  ← token bucket, ~1 req/s
  └────────────┼─────────────────────────────────┘
               │  POST /json/2/{model}/{method}
               │  Authorization: Bearer <odoo-api-key>
               │  X-Odoo-Database: <db>
               ▼
        User's Odoo instance
```

## Runtime & transport

- **Runtime:** Cloudflare Worker, TypeScript.
- **MCP framework:** `McpAgent` from the Cloudflare **`agents`** SDK.
- **Transport:** **Streamable HTTP** served at `/mcp`. This is the recommended
  remote MCP transport and what modern MCP clients (Claude, MCP Inspector)
  speak. A single endpoint handles the POST (client→server requests) and the
  streamed responses.
- **SSE:** only added if a legacy client requires the older HTTP+SSE transport.
  Not a v1 goal.

`McpAgent` is itself backed by a Durable Object for session/agent state, which
is why the `agents` SDK is used rather than a bare `fetch` handler — it gives us
the MCP session plumbing for free. Our *own* stateful component (the rate
limiter) is a second, separate Durable Object.

## BYO-key: credentials arrive per request

The Worker has **no Odoo credentials baked in**. Every MCP request carries the
caller's own Odoo URL, database, and API key (see [`auth.md`](./auth.md) for the
exact header contract). The Worker:

1. Reads `Authorization: Bearer <odoo-api-key>`, `X-Odoo-Url`, `X-Odoo-Db` from
   the incoming request.
2. Constructs an `OdooClient` bound to that origin/db/key for the lifetime of
   the request.
3. Calls Odoo **as that user**. Odoo's per-user permissions/record-rules decide
   what succeeds.

Because the key is per-request, two different users hitting the same Worker are
fully isolated — the Worker never mixes credentials and never persists them.

## The Odoo JSON-2 client

A thin TypeScript client, reimplementing the behavior of the Python `OdooClient`
in the sibling pipeline repo
(`ai-pipelines-2/src/agent_pipeline/tracker/odoo.py`) — read that for the JSON-2
shape, but do not port it literally.

- **Endpoint:** `POST {origin}/json/2/{model}/{method}`.
- **Headers:**
  - `Authorization: Bearer <odoo-api-key>`
  - `X-Odoo-Database: <db>`
  - `Content-Type: application/json`, `Accept: application/json`
- **Body:** method arguments at the JSON root (Odoo 19 JSON-2 does **not** nest
  them under `kwargs`). Examples:
  - Read: `search_read` with `{ "domain": [...], "fields": [...], "limit": N }`.
  - Create: **batched** — `create` with `{ "vals_list": [ {...}, ... ] }`,
    returning `[id, ...]`. The non-batched `{ "vals": ... }` shape was removed in
    Odoo 19 and returns 422 (`missing a required argument: 'vals_list'`).
  - Write: `write` with `{ "ids": [...], "vals": {...} }`.
  - x2many edits use command tuples, e.g. `tag_ids: [[6, 0, ids]]` (replace),
    `[[4, id]]` (link), `[[3, id]]` (unlink).
- **Response:** unwrap the top-level `result` field when present; otherwise
  return the raw JSON.
- **Errors:** `401 → auth error` (surface clearly, the caller's key is bad);
  `429/502/503/504 → transient`, retried with exponential backoff + full jitter,
  honoring `Retry-After`; other `4xx/5xx → terminal`.
- **m2o fields** come back as `[id, name]` (or `false`); normalize to a small
  `{ id, name }` ref.

The client is deliberately minimal: one `call(model, method, body)` primitive,
with typed helpers per tool layered on top.

## Rate limiting

Odoo's cloud AUP is roughly **1 request/second, no parallel calls** per Odoo
instance. Two regimes:

- **Hosted / multi-user (the Worker):** a single **Durable Object token-bucket
  limiter, one instance per Odoo origin** (`scheme://host[:port]`). Every Odoo
  call from every user of a given Odoo instance funnels through that origin's DO,
  which enforces single-flight + minimum spacing. Using the origin as the DO name
  (`env.RATE_LIMITER.idFromName(origin)`) means all Worker isolates and all
  concurrent requests to the same Odoo server serialize against one coordinator —
  Durable Objects give us exactly one authoritative instance per name across the
  whole account. Different Odoo instances get different DOs and never contend.
- **Local / single-user:** client-side pacing in-process is enough; a full DO
  round-trip per call is unnecessary overhead. The limiter is abstracted so local
  dev can use a simple in-memory pacer while production uses the DO. (Miniflare
  runs the DO locally too, so you *can* exercise the real path — see below.)

The limiter's job is spacing and single-flight, not fairness across users; if two
users share one Odoo instance they share its ~1 req/s budget, which matches
Odoo's own per-instance limit.

## Tool-module structure

Tools are grouped by **domain module**, registered on the `McpAgent`:

- **`projects.*`** — v1. e.g. `projects.list_projects`, `projects.list_tasks`,
  `projects.list_chatter`, `projects.get_task`, `projects.list_stages` (read); later
  `projects.create_task`, `projects.update_task`, `projects.move_task` (write).
- **`booking.*`** — later. Read bookings first, then create.
- **`billing.*`** — later. Read invoices first, then create invoice / link
  records.

Conventions:

- Every tool **declares whether it is read or write** in its metadata/description
  so clients and reviewers can see the blast radius at a glance.
- **Read-only ships first per domain.** Writes are added only after the reads for
  that domain are proven, and writes are automatically constrained by the
  caller's Odoo permissions.
- Tool names are namespaced by domain (`projects.`, `booking.`, `billing.`) to
  keep the surface legible as it grows.

## Local development

- **`wrangler dev`** — Miniflare runs the Worker **and the Durable Object(s)**
  locally, so the real rate-limiter path is exercisable without deploying.
- **MCP Inspector** — `npx @modelcontextprotocol/inspector`, pointed at
  `http://localhost:8787/mcp`, to list and call tools interactively.
- **Secrets** — put dev values in **`.dev.vars`** (gitignored). Never commit Odoo
  URLs/keys.
- **Dev-only auth bypass** — a dev flag that injects a fixed Odoo URL/db/key
  (from `.dev.vars`) when no auth header is present, so you don't re-enter
  credentials on every Miniflare reload. This bypass is strictly gated to local
  dev and must be off in production.
- **`wrangler deploy`** — ship to Cloudflare (**Unstatic Labs** account).

## Hosting & CI note (dogfood)

Deployed on **Cloudflare / Unstatic Labs**. This repo is itself managed by the
autonomous-dev-pipeline (Odoo board 17), so it will need a **`.ci.json`** gate:
**build + typecheck + `wrangler deploy --dry-run`**. That gives the pipeline a
real pass/fail signal on this repo without shipping. (Not present yet — see the
roadmap.)
