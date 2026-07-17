# odoo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Odoo**, running on
Cloudflare Workers. It lets AI clients (Claude Code, Claude Desktop, ChatGPT, and any other
MCP client) read and write Odoo data over a single remote endpoint.

- **Transport:** Streamable HTTP at `/mcp` (via the Cloudflare Agents `McpAgent`).
- **Auth:** **bring-your-own-key (BYO-key)** — each caller supplies their *own* Odoo URL +
  API key, so Odoo's own per-user permissions are the authorization. Clients that can set
  static headers (Claude Code, Claude Desktop) send them per request; ChatGPT connects via a
  built-in **OAuth shim** that collects the same credentials once and stores them encrypted
  (see [docs/product/auth.md](docs/product/auth.md)). No shared service account, no scopes
  model.
- **API:** Odoo JSON-2 (`POST {url}/json/2/{model}/{method}`).

> Status: Milestone 1+ — projects read core, model/field discovery, smart field selection,
> timeout+retry, record CRUD, and `odoo://` resources.

## Connection: BYO-key headers

For clients that can set static headers, every request to `/mcp` carries three headers
(missing/malformed → `401`). Requests without any `X-Odoo-*` header are treated as OAuth
(see [Connect ChatGPT](#connect-chatgpt-oauth) below).

| Header | Value |
|---|---|
| `Authorization` | `Bearer <your-odoo-api-key>` |
| `X-Odoo-Url` | your Odoo base URL, e.g. `https://your-org.odoo.com` |
| `X-Odoo-Db` | your Odoo database name |

The server never logs, stores, or echoes your key.

## Tools

| Tool | Kind | Parameters |
|---|---|---|
| `search_records` | read | `model` (string), `domain` (array, default `[]`), `fields` (string[] \| null → curated preset), `limit` (1–100, default 10), `order` (string, optional, e.g. `"name desc"`), `offset` (int ≥ 0, default 0) → includes `returned_fields`, `omitted_fields`, `warnings` |
| `search_records_compact` | read | `model` (string), `domain` (array, default `[]`), `field_preset` (`minimal` \| `tracking_minimal` \| `financial_minimal`, default `minimal`), `fields` (string[] \| null — explicit override; mutually exclusive with non-default preset), `limit` (1–100, default 25), `offset` (int ≥ 0, default 0), `order` (string, optional), `search_count` (boolean, default `true`) → `CompactReadEnvelope`: nested `fields` manifest (`resolved_fields`, `returned_fields`, `omitted_fields`, `resolution`) and `page` (`offset`, `limit`, `count`, `returned`, `has_more`) |
| `browse_records` | read | `model` (string), `domain` (array, default `[]`), `field_preset` (`minimal` \| `tracking_minimal` \| `financial_minimal`, default `minimal`), `fields` (string[] \| null — explicit override; mutually exclusive with non-default preset), `limit` (1–100, default 25), `offset` (int ≥ 0, default 0), `cursor` (string \| null, optional — stable continuation token), `order` (string, optional) → compact rows with `page`, `field_preset`, `fields_resolution`, `returned_fields`, `omitted_fields`, `warnings`, optional `safeguard_applied` |
| `search_count` | read | `model` (string), `domain` (array, default `[]`) → `{ count }` via `search_count`, without fetching records |
| `get_record` | read | `model` (string), `record_id` (positive int), `fields` (string[] \| null → curated preset) → includes field reporting |
| `batch_read` | read | `model` (string), `ids` (positive int[], min 1, capped at 100), `fields` (string[] \| null → curated preset) → rows via `search_read` + field reporting |
| `list_models` | read | — |
| `get_fields` | read | `model` (string) → field name/type/label schema |
| `expand_record` | read | `model` (string), `record_id` (positive int), `relations` (string[]), `include_chatter` (bool, default true), `include_attachments` (bool, default true), `relation_limit` (1–50, default 10) — record + optional x2many relations, chatter, attachments; caps at 8 Odoo calls |
| `projects.list_tasks` | read | `domain` (array), `fields` (string[]) — convenience wrapper over `project.task`; includes field reporting |
| `projects.list_chatter` | read | `task_ids` (positive int[], 1–25), `limit_per_task` (1–50, default 20), `order` (string, default `"date desc"`) — canonical multi-task PM chatter; one scoped `mail.message` query per task; caps at 8 Odoo calls |
| [`aggregate_records`](#aggregate_records--grouped-summaries) | read | `model` (string), `domain` (array), `groupby` (string[], Odoo `field:agg` syntax e.g. `invoice_date:month`), `aggregates` (string[], e.g. `amount_total:sum`, `__count`), `lazy` (bool, default true), `orderby` (string, optional), `limit` (1–100, default 100, fallback scan cap), `offset` (int ≥ 0, default 0) — native `read_group` with bounded connector fallback |
| `create_record` | write | `model` (string), `values` (object) |
| `update_record` | write | `model` (string), `record_id` (positive int), `values` (object; x2many use Odoo command tuples, e.g. `[[6,0,ids]]`, `[[4,id]]`, `[[3,id]]`) |
| `delete_record` | write | `model` (string), `record_id` (positive int) |
| `batch_update` | write | `model` (string), `updates` (array of `{ record_id, values }`; x2many use Odoo command tuples) — one `write` per entry, fail-fast |
| `batch_post_message` | write | `model` (string), `messages` (array of `{ record_id, body, subtype?, body_is_html? }`) — one `message_post` per entry, HTML-escaped unless `body_is_html` |
| `bookkeeping.get_snapshot` | read | `company` (string), `date_from`/`date_to` (string), `scopes` (enum[] min 1: `tax_report`, `tax_returns`, `return_types`, `external_values`, `key_accounts`), `key_account_codes` (string[], optional) — batched tax-close snapshot |
| `bookkeeping.review_key_accounts` | read | `company` (string), `date_to` (string), `account_codes` (string[]) — per-account balance, open items, and a factual closure-blocker severity |
| `bookkeeping.explain_report_line` | read | `company` (string), `report_name` (string), `line_code` (string), `date_from`/`date_to` (string) — fact-only diagnosis of why a tax-report line reads its value (e.g. CA12 `box_22` carryover) |
| `bookkeeping.list_source_documents` | read | `model` (string, default `account.move`), `record_id` (positive int) — `ir.attachment` source docs tagged `original_source`/`official_pdf`/`other` |
| `bookkeeping.fetch_attachment` | read | `attachment_id` (positive int), `max_bytes` (positive int, default `10485760`) — attachment metadata + base64 content unless URL-type or over `max_bytes` |
| `bookkeeping.preview_returns` | read | `company` (positive int), `from`/`to` (string), `return_type_xmlids` (string[] min 1) — which `account.return` cards should exist; blank periodicity → `configuration_issues` |
| `bookkeeping.plan_safe_write` | validate-only | `operation` (enum: `create_or_update_report_external_value`, `create_manual_tax_return`, `update_return_type_periodicity`, `create_lock_exception`), `company` (string), `values` (object) — dry-run write plan + HMAC confirmation token; never writes |
| `billing.update_draft_expense` | write | `record_id` (positive int), `values` (allowlisted draft `hr.expense` prep fields: date/name/description/product/account/analytics/qty/price/tax/reference) — draft-only; no validate/post |
| `billing.configure_draft_vendor_bill` | write | `record_id` (positive int), `values` (allowlisted draft `account.move` `in_invoice` header + `invoice_line_ids`) — draft vendor bills only; no validate/post/reconcile |

**`aggregate_records` validation.** Before calling Odoo `read_group`, the server validates `groupby` and
`aggregates` against cached `fields_get` metadata:

- **Groupby:** `many2one`, `selection`, `date`, and `datetime` fields (stored only). Date/datetime fields
  may use an optional granularity bucket: `day`, `week`, `month`, `quarter`, or `year`
  (e.g. `invoice_date:month`). Bare date/datetime fields are allowed (Odoo default grouping).
- **Aggregates:** `__count`, or `field:sum` on `integer`, `float`, or `monetary` fields.
- **Pre-flight errors** (returned as JSON envelopes, no `read_group` call): `invalid_groupby`,
  `unsupported_aggregate`.

Writes are gated by *your* Odoo user's access rights and record rules (BYO-key), so a caller
can only do what their Odoo account permits.

> **Bookkeeping safety.** The `bookkeeping.*` tools are **read-only by default**. Writes are
> **two-phase**: `bookkeeping.plan_safe_write` only *validates* and returns a would-write
> plan plus an HMAC confirmation token — it **never writes**, and the actual write happens
> only after explicit human confirmation. These tools **never auto-reconcile** and **never
> guess tax treatment**; they report facts and leave judgment to the human. See
> [docs/bookkeeping.md](docs/bookkeeping.md) for the snapshot-first workflow, rate-limit and
> cache model, full tool reference, and worked CA12 walkthroughs.

### Project-management writes vs bookkeeping vs billing

- **PM task notes, chatter, and activities** — use `create_record`, `update_record`, `post_message`,
  `batch_post_message`, or `call_model_method` on `project.task`, `project.project`, or `mail.activity`
  with `res_model` ∈ `{project.task, project.project}`.
- **Operational text** may reference banking, B2C exports, VAT, payroll handoffs, deadlines — the
  connector classifies by **model + method + field names**, not free-text keywords.
- **Draft vendor-bill / expense prep** — use `billing.update_draft_expense` /
  `billing.configure_draft_vendor_bill` (draft-only allowlisted fields; no validate/post).
- **Tax-close / report / return / lock-exception mutations** — **`bookkeeping.plan_safe_write` only**
  (four operations documented in [docs/bookkeeping.md](docs/bookkeeping.md)). It never handles PM
  models or draft bill/expense prep.
- **Multi-task chatter** — see [docs/testing.md](docs/testing.md) § bulk chatter reads.

### Field selection

For `search_records`, `get_record`, `batch_read`, and `projects.list_tasks`:

- **`fields` omitted / `null`** → a **curated per-model preset** from `MODEL_FIELD_PRESETS` (no extra Odoo call):
  - `project.task` → `id`, `name`, `stage_id`, `project_id`
  - `project.project` → `id`, `name`, `partner_id`, `user_id`, `stage_id`
  - `res.partner` → `id`, `name`, `email`, `phone`
  - `res.users` → `id`, `name`, `login`, `email`
  - unknown models → `id`, `display_name`
- **Explicit string array** → exactly those fields (passed verbatim to Odoo).
- **`["__all__"]` sentinel** → all Odoo fields (token-heavy; discouraged).

Tool responses include structured field reporting alongside the records:

- `returned_fields` — fields present in the Odoo rows
- `omitted_fields` — `{ field, reason }` where `reason` is `absent-from-rows` or `unknown-field` (the latter only when a cached `fields_get` result is already available)
- `warnings` — when an **explicitly requested** field is omitted

Use `get_fields` when you need the full field schema; the default read path does **not** call `fields_get`.

### `aggregate_records` — grouped summaries

Uses Odoo `read_group` when the model supports it. When native `read_group` returns
`model_or_method_not_found` (HTTP 404) but `search_read` works, the connector performs a
**bounded fallback**: one `search_count` + one `search_read` page (max **100** records per
call), then groups in memory. Check `metadata.fallback` and `warnings` in the response.

**Pagination (fallback only).** `limit` (default 100, max 100) and `offset` (default 0) control
which slice of matching records is scanned. When `metadata.has_more` is true, increase `offset`
and call again — the connector never auto-fetches additional pages.

**Groupby matrix (fallback supports single-level only).**

| Field type | Native `read_group` | Fallback |
|---|---|---|
| `many2one`, `selection`, `char`, `boolean`, `integer` | yes | yes |
| `date`, `datetime` (+ `:day`/`:week`/`:month`/`:quarter`/`:year`) | yes | yes (UTC buckets) |
| `one2many`, `many2many`, `binary`, `html`, `text`, `reference` | — | rejected at validation |

**Aggregates.**

| Token | Native | Fallback |
|---|---|---|
| `__count` | yes | yes |
| `field:sum` | yes | yes |
| `field:avg`, `:min`, `:max`, `:count` | yes | no (`unsupported_aggregate`) |

Multi-level `groupby` (length > 1) is native-only; fallback refuses with `unsupported_aggregate`.

**Error diagnosis** (JSON error envelope field `diagnosis`, alongside `error` / `details`):

| `diagnosis` | When | Fallback attempted? |
|---|---|---|
| `permission_denied` | HTTP 401 / 403 | never |
| `unsupported_model` | Unknown model or no `fields_get` / `search_read` | no |
| `invalid_groupby` | Unknown or non-groupable groupby field | no (pre-native) |
| `unsupported_aggregate` | Unsupported operator in fallback, or multi-level groupby | no |
| `connector_bug` | Unexpected connector failure | no |

Transient Odoo errors (`timeout`, `rate_limited`, 5xx, etc.) keep the standard `OdooErrorCode`
in `error` with `recoverable: true` — no fallback. An HTTP 200 response with a JSON `{error: ...}`
body (e.g. some Odoo builds rejecting `read_group` without 404) surfaces as `error: "unknown"` —
also no fallback.

For compact paginated triage, use `search_records_compact` or `browse_records` — see
[Compact browse](#compact-browse-search_records_compact-vs-browse_records) below.

**Browse workflow:** `search_records_compact` or `browse_records` → scan compact rows and note `id` values →
`batch_read({ model, ids: [...], fields: null })` or `get_record` for full detail
on selected records only.

### Compact browse (`search_records_compact` vs `browse_records`)

Use **`search_records_compact`** when you want a nested `CompactReadEnvelope` with a `fields`
manifest (`resolved_fields`, `returned_fields`, `omitted_fields`, `resolution`) and offset/limit
paging only. Set `search_count: false` to skip the `search_count` round-trip (page `has_more`
becomes heuristic when the page is full).

Use **`browse_records`** when you need a flat response with cursor continuation (`cursor` /
`page.next_cursor`), mandatory total `count`, and automatic payload-size safeguards.

Both tools share named **field presets** (compact, no `fields_get` round-trip):
- `minimal` — curated core columns for known models (`project.task`, `project.project`,
  `res.partner`, `res.users`); generic `id` + `display_name` fallback for unknown models.
- `tracking_minimal` — workflow/triage fields (stage, assignees, deadlines, state, …).
- `financial_minimal` — amount/partner/account oriented subsets where curated.

When both `field_preset` and explicit `fields` are supplied, **explicit `fields` win**.
`search_records_compact` nests field provenance under `fields`; `browse_records` flattens it
as `field_preset`, `fields_resolution`, `returned_fields`, and `omitted_fields`.

**Paging:** pass a stable `order` when scanning multiple pages. `search_records_compact`
uses offset/limit only. `browse_records` also supports `cursor` / `page.next_cursor` and
shrinks oversized pages automatically (`safeguard_applied`).

**Drill-down:** ids from compact rows can be fetched in full with `batch_read` or
`get_record` for field data. For chatter on a single task use
`expand_record({ model: "project.task", record_id, include_chatter: true })`; for
multiple tasks use `projects.list_chatter({ task_ids: [...] })`.

### Project-management chatter

**Triage:** `projects.list_tasks`, `browse_records`, or `search_records_compact` on
`project.task` to collect task ids.

**Single-task detail + chatter:**
`expand_record({ model: "project.task", record_id, include_chatter: true, include_attachments: false })`.

**Multi-task chatter:** `projects.list_chatter({ task_ids: [...] })`. Each task id
triggers one scoped `mail.message` query (never `res_id in [...]` with `body`/`preview`).
Re-invoke with remaining ids when `metadata.truncated_task_ids` is set (8 Odoo calls max
per invocation) or when you have more than 8 tasks.

**Do not** bulk-fetch PM chatter via `search_records` on `mail.message` with
`[["model","=","project.task"],["res_id","in",ids]]` and `body`/`preview` — MCP hosts may
block finance-keyword message bodies. Accounting chatter on invoices/journals is still
blocked on `account.move` / `hr.expense`; draft bill/expense prep uses `billing.*`, and
tax-close mutations use `bookkeeping.plan_safe_write` — not generic `mail.message` reads.

## Resources

In addition to tools, the server exposes read-only Odoo data as **MCP resources** via URI
templates. Any MCP client can discover them with `resources/templates/list` (handled
automatically by the SDK) and read them with `resources/read`.

| URI template | Description | Example |
|---|---|---|
| `odoo://{model}/record/{id}` | Fetch a single record by id | `odoo://project.task/record/42` |
| `odoo://{model}/search` | List records for a model. Optional `?domain=<JSON array>&fields=<comma-separated>&limit=<1-100>` query params (defaults: `domain=[]`, smart fields, `limit=10`) | `odoo://project.task/search?domain=%5B%5B%22active%22%2C%22%3D%22%2Ctrue%5D%5D&limit=5` |
| `odoo://{model}/count` | Count records matching a domain via `search_count`. Optional `?domain=<JSON array>` query param (default `[]`) | `odoo://project.task/count?domain=%5B%5B%22active%22%2C%22%3D%22%2Ctrue%5D%5D` |
| `odoo://{model}/fields` | Field schema (name, type, string label) for a model | `odoo://project.task/fields` |

All four resources are strictly read-only (`read` / `search_read` / `search_count` / `fields_get`
only) and use the same BYO-key connection headers as the tools above.

## Quick start

See **[docs/testing.md](docs/testing.md)** for the full local + deployed testing guide. In short:

```bash
npm ci
npx wrangler dev        # serves http://localhost:8787/mcp

# connect Claude Code to the local server:
claude mcp add --transport http odoo http://localhost:8787/mcp \
  --header "Authorization: Bearer $ODOO_API_KEY" \
  --header "X-Odoo-Url: https://your-org.odoo.com" \
  --header "X-Odoo-Db: your-db"
```

## Connect ChatGPT (OAuth)

ChatGPT's connector UI can't set custom headers, so the Worker ships an OAuth 2.1 shim
(authorization code + PKCE + dynamic client registration) on the same `/mcp` endpoint:

1. Deploy the Worker (see below — the `OAUTH_KV` namespace must exist).
2. In ChatGPT: **Settings → Apps & Connectors → Advanced settings → enable Developer Mode**,
   then **Create connector**: give it a name and the server URL
   `https://<worker>.workers.dev/mcp`, auth **OAuth**.
3. ChatGPT redirects you to the Worker's hosted `/authorize` page. Paste your Odoo URL,
   database, and API key — the shim verifies them against your Odoo before accepting.
4. Back in ChatGPT, the connector shows the tool list; try a read tool (e.g. ask it to
   search `project.task`).

Your credentials are stored end-to-end encrypted in Workers KV and resolved per request —
tools behave exactly as on the header path, limited by your own Odoo permissions. Token
lifetime is 1 h (refresh 30 days). Revocation: delete the `grant:*` key via
`npx wrangler kv key list/delete --binding OAUTH_KV --remote` (details in
[docs/product/auth.md](docs/product/auth.md)).

## Deploy

```bash
npm ci                # required — node_modules must actually be installed before bundling
npx wrangler deploy
```

- `wrangler` must already be logged in (`npx wrangler whoami`; if not, `npx wrangler login`).
- The header path is stateless/BYO-key, so there are no secrets or `.dev.vars` to set for a
  deploy. The ChatGPT OAuth shim needs one resource: the **`OAUTH_KV`** KV namespace bound in
  `wrangler.jsonc`. Deploying to a new account? Create it once with
  `npx wrangler kv namespace create OAUTH_KV` and put the printed `id` into the
  `kv_namespaces` entry.
- If your Cloudflare login can reach **multiple accounts**, `wrangler deploy` needs to know
  which one to use. `wrangler deploy` has no `--account-id` flag — set the account via the
  `CLOUDFLARE_ACCOUNT_ID` env var instead (or add `"account_id"` to `wrangler.jsonc`):
  ```bash
  CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy
  ```
  Run `npx wrangler whoami` to list the account IDs your login can reach.
- `wrangler.jsonc` declares the `McpAgent` Durable Object; the first deploy provisions it
  automatically — no manual setup needed.
- On success, wrangler prints the public URL: `https://<worker-name>.<subdomain>.workers.dev`.
  The MCP endpoint is that URL + `/mcp`.

## Development

- `npm run typecheck` — `tsc --noEmit`
- `npx wrangler deploy --dry-run` — bundle check
- `bun test` — hermetic unit/integration tests
- CI gate: `.ci.json` (install → typecheck → test → deploy dry-run)

## License

MIT (see repository).
