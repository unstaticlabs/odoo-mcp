# odoo-mcp

A standalone **Model Context Protocol (MCP) server for Odoo**, hosted on
Cloudflare Workers. It gives AI clients a clean, tool-based gateway to read
(and eventually write) Odoo data — starting with **projects/tasks** and growing
into **booking** and **billing**.

## What it is

`odoo-mcp` is a general-purpose Odoo gateway with many consumers. It exposes
Odoo functionality as MCP tools over **Streamable HTTP** at `/mcp`, so any
MCP-capable client can connect to a single URL and start calling tools.

It is a **separate component** from the autonomous-dev-pipeline
(`ai-pipelines-2`). That pipeline keeps its own direct Odoo access for its own
purposes; `odoo-mcp` does not replace it and is not coupled to it. Think of
`odoo-mcp` as shared infrastructure: one Odoo gateway that several independent
AI clients and projects can point at.

## Who uses it

- **Claude Code** — as a configured MCP server, for reading/creating Odoo tasks
  from the terminal.
- **Other Claude instances** — desktop/web Claude, or other agents, connecting
  to the hosted `/mcp` endpoint.
- **ChatGPT** (e.g. Valentin's use) — via ChatGPT's remote-connector support.
  See the ChatGPT caveat in [`auth.md`](./auth.md) — its connector auth may not
  pass a static API-key header, which is the one path that could later need a
  thin OAuth shim.
- **Other projects/apps** — anything that speaks MCP and needs Odoo data.

## The domains

Tools are grouped by **domain module**, and each domain ships **read-only
first**, with writes following once the reads are proven:

1. **`projects.*`** (v1) — read Odoo projects, tasks, stages, comments; later,
   create/update tasks.
2. **`booking.*`** (later) — read and eventually create bookings.
3. **`billing.*`** (later) — read invoices, and eventually create invoices and
   link records.

Writes are always **bounded by the caller's own Odoo permissions** (see auth,
below), so a read-only Odoo user simply cannot mutate anything even when a write
tool exists.

## The auth model in one paragraph

**Bring-your-own-key (BYO-key), no OAuth for v1.** Each user supplies their
*own* Odoo instance URL + Odoo API key. The server calls Odoo **as that user**,
so **Odoo's own per-user permissions and record-rules are the authorization** —
there are no scopes, no shared service account, and no user store. The server is
stateless and configless. Full detail in [`auth.md`](./auth.md).

## North star

**One small, stateless Odoo gateway that any AI client can point at, where
security is Odoo's problem, not ours.** We add tools domain by domain
(projects → booking → billing), read before write, and never accumulate a user
database or a scope system — the user's Odoo key already encodes exactly what
they're allowed to do.

## Documents

- [`overview.md`](./README.md) — this file.
- [`architecture.md`](./architecture.md) — Worker + Streamable HTTP + BYO-key +
  JSON-2 client + rate-limit Durable Object + tool-module structure + local dev.
- [`auth.md`](./auth.md) — the BYO-key model in depth, the header contract, the
  ChatGPT caveat, and the rejected OAuth-scopes alternative.
- [`roadmap.md`](./roadmap.md) — milestones M1–M4 and the "add OAuth only if
  ChatGPT needs it" branch.

## Hosting & dogfood note

Hosted on **Cloudflare, the Unstatic Labs account**. This repo will itself be a
project managed by the autonomous-dev-pipeline (Odoo board 17), so it will
eventually need a `.ci.json` gate (build + typecheck + `wrangler deploy
--dry-run`). See the roadmap.
