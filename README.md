# odoo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Odoo**, running on
Cloudflare Workers. It lets AI clients (Claude Code, Claude Desktop, ChatGPT, and any other
MCP client) read and write Odoo data over a single remote endpoint.

- **Transport:** Streamable HTTP (via the Cloudflare Agents `McpAgent`), on three sibling
  endpoints sharing one auth front door:
  - `/mcp` — the **full tool surface** (back-compat: existing connectors keep working);
  - `/accounting/mcp` — bookkeeping + billing tools only;
  - `/projects/mcp` — projects tools only.

  The domain endpoints exist for clients with small tool budgets (ChatGPT): connect the one
  you need and the model sees a focused tool list instead of everything.
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

For clients that can set static headers, every request to an MCP endpoint (`/mcp`,
`/accounting/mcp`, or `/projects/mcp`) carries three headers (missing/malformed → `401`).
Requests without any `X-Odoo-*` header are treated as OAuth (see
[Connect ChatGPT](#connect-chatgpt-oauth) below).

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
| `projects.list_projects` | read | `domain` (array), `fields` (string[]), `limit` (1–100, default 100) — list `project.project` records with field reporting |
| `projects.list_tasks` | read | `domain` (array), `fields` (string[]), `limit` (1–100, default 100) — convenience wrapper over `project.task`; includes field reporting |
| `projects.get_task` | read | `task_id` (positive int), `fields` (string[] \| null → curated preset) — single task + optional `_workflow_status` |
| `projects.list_stages` | read | `project_id` (positive int, optional), `domain` (array), `fields` (string[]), `limit` (1–100) — `project.task.type` stages for a project |
| `projects.list_chatter` | read | `task_ids` (positive int[], 1–25), `limit_per_task` (1–50, default 20), `order` (string, default `"date desc"`) — canonical multi-task PM chatter; one scoped `mail.message` query per task; caps at 8 Odoo calls |
| `projects.create_task` | write | `name` (string), `project_id` (positive int), `description` / `stage_id` / `tag_ids` (optional), `values` (optional extra vals), `context` (optional) — Odoo 19 `vals_list` create + provenance `trace_token` |
| [`aggregate_records`](#aggregate_records--grouped-summaries) | read | `model` (string), `domain` (array), `groupby` (string[], Odoo `field:agg` syntax e.g. `invoice_date:month`), `aggregates` (string[], e.g. `amount_total:sum`, `__count`), `lazy` (bool, default true), `orderby` (string, optional), `limit` (1–100, default 100, fallback scan cap), `offset` (int ≥ 0, default 0) — native `read_group` with bounded connector fallback |
| `create_record` | write | `model` (string), `values` (object), `context` (string ≤ 500, optional — see [Write context](#write-context-audit-only)) |
| `update_record` | write | `model` (string), `record_id` (positive int), `values` (object; x2many use Odoo command tuples, e.g. `[[6,0,ids]]`, `[[4,id]]`, `[[3,id]]`), `context` (optional) |
| `delete_record` | write | `model` (string), `record_id` (positive int), `context` (optional) |
| `batch_update` | write | `model` (string), `updates` (array of `{ record_id, values }`; x2many use Odoo command tuples), `context` (optional) — one `write` per entry, fail-fast |
| `batch_post_message` | write | `model` (string), `messages` (array of `{ record_id, body, subtype?, body_is_html? }`), `context` (optional) — one `message_post` per entry, HTML-escaped unless `body_is_html` |
| `bookkeeping.get_snapshot` | read | `company` (string), `date_from`/`date_to` (string), `scopes` (enum[] min 1: `tax_report`, `tax_returns`, `return_types`, `external_values`, `key_accounts`), `key_account_codes` (string[], optional) — batched tax-close snapshot |
| `bookkeeping.review_key_accounts` | read | `company` (string), `date_to` (string), `account_codes` (string[]) — per-account balance/debit/credit (nullable on query failure), open items, and factual severity (`attention`/`ok`/`info`/`unknown`) |
| `bookkeeping.explain_report_line` | read | `company` (string), `report_name` (string), `line_code` (string), `date_from`/`date_to` (string) — fact-only diagnosis of why a tax-report line reads its value (e.g. CA12 `box_22` carryover) |
| `bookkeeping.list_source_documents` | read | `model` (string, default `account.move`), `record_id` (positive int) — `ir.attachment` source docs tagged `original_source`/`official_pdf`/`other` |
| `bookkeeping.search_source_documents` | read | `filename` (string, `ilike`), `folder_id` / `owner_id` / `res_id` (positive int), `tag_ids` (positive int[]), `date_from`/`date_to` (`create_date` bounds), `res_model` (string), `limit` (1–200, default 80) — searches the Odoo Documents repository (`documents.document`), metadata only (never `datas`); degrades to `documents: []` + a warning when the module is absent or ACLs deny it |
| `bookkeeping.fetch_attachment` | read | `attachment_id` (positive int), `max_bytes` (positive int, default `10485760`) — attachment metadata + base64 content unless URL-type or over `max_bytes` |
| `bookkeeping.preview_returns` | read | `company` (positive int), `from`/`to` (string), `return_type_xmlids` (string[] min 1) — which `account.return` cards should exist; blank periodicity → `configuration_issues` |
| `bookkeeping.plan_safe_write` | validate-only | `operation` (enum: `create_or_update_report_external_value`, `create_manual_tax_return`, `update_return_type_periodicity`, `create_lock_exception`), `company` (string), `values` (object) — dry-run write plan + HMAC confirmation token; never writes |
| `billing.audit_expenses` | read | `state` / `product_id` / `analytic_account_id` (optional; analytic post-filters `analytic_distribution` keys), `date_from`/`date_to`, `company_id`, `limit` (1–100, default 50), `offset`, `order` — population audit with account/taxes/payment_mode/attachments, in-page duplicate candidates, and totals |
| `billing.update_draft_expense` | write | `record_id` (positive int), `values` (allowlisted draft `hr.expense` prep fields: date/name/description/product/account/analytics/qty/price/**total_amount**/tax/reference; `total_amount_currency` is not writable), `context` (optional) — draft-only; lifecycle via `billing.reset_expense` / `billing.submit_expense` / `billing.approve_expense` |
| `billing.reset_expense` | write | `record_ids` (1–50 positive ints), `context` (**required**) — `hr.expense` submitted/approved/refused → draft. All-or-nothing; validated against live state and `can_reset` first |
| `billing.submit_expense` | write | `record_ids` (1–50 positive ints), `context` (**required**) — `hr.expense` draft → submitted |
| `billing.approve_expense` | write | `record_ids` (1–50 positive ints), `context` (**required**) — `hr.expense` submitted → approved; refuses when Odoo's `can_approve` is false. Never posts or pays |
| `billing.configure_draft_vendor_bill` | write | `record_id` (positive int), `values` (allowlisted draft `account.move` `in_invoice` header: `partner_id`, dates, `ref`, `fiscal_position_id`, `currency_id`, `narration`, `payment_reference`, plus `invoice_line_ids`), `context` (optional) — draft vendor bills only; reset via `call_model_method` `button_draft` |
| `billing.attach_source_pdf` | write | `bill_id` (positive int), `source_attachment_id` (positive int), `page_from`/`page_to` (positive ints, optional — 1-based inclusive; omit both to copy the whole PDF), `max_bytes` (positive int, default `10485760`), `name` (1–255 chars, optional), `context` (**required**) — copies or page-extracts a source PDF in-Worker onto a draft `in_invoice` as a new `ir.attachment`. Draft vendor bills only; never posts, never touches the source, not generic attachment CRUD |
| `bookkeeping.link_source_document` | write | `document_id` (positive int), `target_model` (enum `account.move`\|`project.task`), `target_id` (positive int), `context` (**required**) — links an existing Documents file to a business record via `res_model`/`res_id`; never copies bytes or creates `ir.attachment`; hard-fails when the Documents app is absent |
| `feedback.submit` | write | `title` (5–120 chars), `message` (20–4000 chars; concrete details, no secrets), `category` (`bug` \| `documentation_gap` \| `missing_feature` \| `dx_friction`), `tool_name` (string, optional) — files an `[agent-feedback]` card in the maintainers' tracker; see [Agent feedback](#agent-feedback) |

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

- **PM task notes and history → the chatter.** Use `post_message` / `batch_post_message`
  (or `projects.create_task` to lodge a new card). `update_record` / `batch_update` /
  `call_model_method` are for changing the task's *own* fields (stage, assignee, dates,
  tags) — not for recording what happened. Activities go via `create_record` /
  `call_model_method` on `mail.activity` with `res_model` ∈ `{project.task, project.project}`.
- **Operational text** may reference banking, B2C exports, VAT, payroll handoffs, deadlines — the
  connector classifies by **model + method + field names**, not free-text keywords.
- **Draft vendor-bill / expense prep** — use `billing.update_draft_expense` /
  `billing.configure_draft_vendor_bill` (draft-only allowlisted fields; no validate/post).
  Expense monetary prep uses `total_amount`; `total_amount_currency` is audit-only and refused on write.
  When one supplier PDF holds several vendors' invoices, `billing.attach_source_pdf` copies or
  page-extracts it onto each draft bill in-Worker — no generic `ir.attachment` CRUD needed.
  For a **new French vendor**, create/update `res.partner` via generic `create_record` /
  `update_record` with VAT/registry identity (`vat`, and often `siret` / `company_registry`,
  plus name / `country_id` / contact), then set `partner_id` on the draft bill. Banks,
  receivable/payable property accounts, payment terms, and credit/debit limits stay
  MCP-blocked; partner identity is not a `bookkeeping.plan_safe_write` path.
- **Reversible expense lifecycle** — prefer the dedicated tools `billing.reset_expense` /
  `billing.submit_expense` / `billing.approve_expense`. They are the **only** lifecycle path on
  `/accounting/mcp`, which ships no generic write tools. On the full `/mcp` surface the same
  transitions are also reachable through `call_model_method` on allowlisted methods
  (`list_model_actions` marks `executable:true`), including the Odoo 17–18 `hr.expense.sheet`
  equivalents and vendor-bill `button_draft`. Every path runs the same gate: required write
  `context`, all ids validated against a live read, compatible state, and Odoo's own
  `can_reset` / `can_approve` flags. Compose reset → draft edit → submit → approve; there is no
  single orchestrator tool.
- **The fence: nothing at or past the journal entry.** Posting, paying, reconciling, deleting and
  lock-exception writes stay blocked on every generic tool, and no lifecycle rule transitions *out*
  of `posted` / `in_payment` / `paid`. That includes un-posting: `button_draft` is allowlisted only
  for **cancelled** vendor bills, never posted ones, because resetting a posted move to draft
  removes its journal entry. Those are Odoo-UI / human operations
  (`bookkeeping.plan_safe_write` is tax/lock ops only, never posting).
- **Tax-close / report / return / lock-exception mutations** — **`bookkeeping.plan_safe_write` only**
  (four operations documented in [docs/bookkeeping.md](docs/bookkeeping.md)). It never handles PM
  models, draft bill/expense prep, or journal posting.
- **Multi-task chatter** — see [docs/testing.md](docs/testing.md) § bulk chatter reads.

### Chatter vs business fields

The **chatter is the record's chronological, auditable journal**: entries are append-only,
timestamped and attributed. Free-text fields (`description`, Terms & Conditions, Internal
Notes, …) are **not versioned** — a write replaces the previous value, and nothing records
that it ever existed.

- Follow-up notes, explanations, decisions, justifications, analysis results, action
  history → **`post_message` / `batch_post_message`**.
- Business fields → only when the value is **durable, structuring data describing the
  record's current state** (a scope statement, the contract terms actually in force).
- **Never** use a non-versioned text field as a substitute for the chatter.
- Before replacing existing text, confirm you are updating the business data itself, not
  appending context. **When in doubt, post to the chatter** — it preserves history.

**Correct** — log an observation without touching the record's data:

    post_message({ model: "project.task", record_id: 42,
      body: "Client confirmed the March deadline; VAT export rerun after the fix." })

**Incorrect** — silently destroys whatever `description` held:

    update_record({ model: "project.task", record_id: 42,
      values: { description: "Client confirmed the March deadline; VAT export rerun." } })

This is about *where notes live*, not *what is writable*: the PM-vs-bookkeeping fences,
`billing.*` draft helpers and `bookkeeping.plan_safe_write` boundaries are unchanged.

### Task state vs stage vs assignee vs dates vs Blocked By

On Odoo 19, `project.task.state` is **not** a free-form status field. `04_waiting_normal`
("Waiting") is **computed** from the task's `stage_id` and its open `depend_on_ids` (Blocked By):
a successor enters Waiting on its own the moment a predecessor is open, and leaves it on its own
when every predecessor is closed. Writing that value by hand produces a task the Odoo UI can only
move to Done or Cancelled. These are five different things and only the last one is derived:

| Concept | Field | Meaning |
|---|---|---|
| Stage | `stage_id` | Kanban column — where the work sits in *your* process |
| Assignee | `user_ids` | Who owns it |
| Scheduling | `date_start` / `date_deadline` / `mail.activity` | When it is due or planned |
| Blocked By | `depend_on_ids` | Which tasks must close first |
| Waiting | `state` | **Derived** by Odoo from stage + open Blocked By |

The connector enforces this:

1. **Waiting is never written.** `state = "04_waiting_normal"` is refused on every write path
   (`projects.create_task`, `create_record`, `update_record`, `batch_update`, `call_model_method`)
   with `policy_rule: "waiting_state_forbidden"`. No Odoo call is made.
2. **To express blocking, set `depend_on_ids`** and let Odoo compute Waiting.
3. **To voluntarily defer / park work, move the card via `stage_id`** to the board's On Hold
   (or equivalent park column) and keep an ordinary open `state` — do **not** set Waiting.
   Optional supporting signals: assignees, activities, or dates. Waiting stays Odoo-derived;
   the UI On Hold column plus an open state (e.g. In Progress / Changes Requested) is the
   intentional deferral signal.

   **Incorrect** (writes Waiting — refused, zero Odoo write):

   ```
   update_record({ model: "project.task", record_id: …,
     values: { stage_id: <On Hold>, state: "04_waiting_normal", … } })
   ```

   → `write_blocked` / `connector_policy` / `waiting_state_forbidden` (`recoverable: true`).

   **Correct** (park via stage only):

   ```
   update_record({ model: "project.task", record_id: …,
     values: { stage_id: <On Hold> } })
   ```

   → stage moves; open `state` is unchanged.
4. **In Progress requires no open blockers.** Setting `state = "01_in_progress"` while open
   `depend_on_ids` remain is refused with `policy_rule: "in_progress_blocked_by_dependencies"` and
   the blocker ids in `relevant_state`; Odoo would recompute Waiting and the write would be a
   silent no-op. A blocker counts as closed only in `03_approved`, `1_done` or `1_canceled`.
5. **Everything else stays editable while Waiting** — stage, assignees, dates, `depend_on_ids`,
   chatter and activities are never refused by these rules. Only payloads that set `state` are
   checked, so ordinary PM writes cost no extra Odoo call.
6. **Dates never imply Waiting.** A future `date_start` or planned date is not a Waiting trigger;
   the connector does not infer Waiting from dates, stages or assignees, and neither does Odoo.
7. **Reads explain it.** `projects.get_task` and `get_record` on a Waiting `project.task` return
   `_waiting_derived`, `_open_blocker_ids` and `_waiting_explanation` alongside `_workflow_status`.
8. **Stale Waiting is repairable one task at a time.** When the annotation shows no open blockers,
   the Waiting state is stale — write `state = "01_in_progress"`, which the gate allows precisely
   because it found nothing blocking. There is deliberately no batch "fix all Waiting tasks" tool.

### Write context (audit only)

Every write tool accepts an optional `context` string (≤ 500 chars): one sentence of
agent-declared intent, e.g. `"user asked to move task 42 to Review"`. It is **audit-only** —
logged server-side as a structured `write_context` line (visible in Workers Logs /
`wrangler tail`), **never sent to Odoo**, and **never consulted by the write-safety gate**,
which continues to classify purely by model + method + field structure. **Exception:**
allowlisted reversible lifecycle via `call_model_method` **requires** non-empty `context`
(still audit-only — never a keyword authz bypass). Do not put credentials or sensitive
personal data in it.

### Agent feedback

`feedback.submit` lets agents report connector problems — bugs, documentation gaps, missing
features, DX friction — instead of silently working around them. Reports are filed as
`[agent-feedback]`-prefixed `project.task` cards in the maintainers' tracker Inbox, tagged by
category, with the server version and client name stamped into the description.

Feedback cards are **deliberately low-trust**: the chatter marker uses the distinct
`[agent-feedback]` prefix (never a trusted `[agent-source]` provenance token), so
downstream triage treats them as untrusted input from arbitrary conversations. Submitting
feedback never changes server behavior — humans triage the cards.

### Field selection

For `search_records`, `get_record`, `batch_read`, `projects.list_tasks`, and `projects.get_task`:

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
blocked on `account.move` / `hr.expense`; draft bill/expense prep uses `billing.*`, reversible
lifecycle uses allowlisted `call_model_method` (see [docs/bookkeeping.md](docs/bookkeeping.md)), and
tax-close mutations use `bookkeeping.plan_safe_write` — not generic `mail.message` reads.
Reads use `expand_record` / `projects.list_chatter`; writes go through `post_message` /
`batch_post_message` (see *Chatter vs business fields*).

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
(authorization code + PKCE + dynamic client registration) shared by all three MCP endpoints:

1. Deploy the Worker (see below — the `OAUTH_KV` namespace must exist).
2. In ChatGPT: **Settings → Apps & Connectors → Advanced settings → enable Developer Mode**,
   then **Create connector**: give it a name and the server URL — usually a focused domain
   endpoint like `https://<worker>.workers.dev/accounting/mcp` or `…/projects/mcp`
   (`…/mcp` serves the full surface) — auth **OAuth**. Each endpoint is a separate
   connector with its own authorize flow.
3. ChatGPT redirects you to the Worker's hosted `/authorize` page. Paste your Odoo URL,
   database, and API key — the shim verifies them against your Odoo before accepting.
4. Back in ChatGPT, the connector shows the tool list; try a read tool (e.g. ask it to
   search `project.task`).

After any tool-surface change (`SERVER_VERSION` bump), ChatGPT keeps serving its cached
tool list — open the connector's settings and refresh it so the new/removed tools appear;
new connectors are unaffected.

Your credentials are stored end-to-end encrypted in Workers KV and resolved per request —
tools behave exactly as on the header path, limited by your own Odoo permissions. Token
lifetime is 1 h (refresh 1 year, fixed at connect time — re-authorize after that). Revocation: delete the `grant:*` key via
`npx wrangler kv key list/delete --binding OAUTH_KV --remote` (details in
[docs/product/auth.md](docs/product/auth.md)).

## Deploy

**Pushes to `main` deploy automatically** via GitHub Actions
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) using the
`CLOUDFLARE_ACCOUNT_ID` repo variable and `CLOUDFLARE_API_TOKEN` secret. Durable Object
migrations in `wrangler.jsonc` apply as part of the deploy. Manual deploys still work:

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
- `wrangler.jsonc` declares the `McpAgent`, `AccountingAgent`, and `ProjectsAgent` Durable
  Objects; the first deploy provisions them automatically — no manual setup needed.
- On success, wrangler prints the public URL: `https://<worker-name>.<subdomain>.workers.dev`.
  The MCP endpoints are that URL + `/mcp`, `/accounting/mcp`, and `/projects/mcp`.

## Development

- `npm run typecheck` — `tsc --noEmit`
- `npx wrangler deploy --dry-run` — bundle check
- `bun test` — hermetic unit/integration tests
- CI gate: `.ci.json` (install → typecheck → test → deploy dry-run)

## License

MIT (see repository).
