# Bookkeeping & tax-close tools

The `bookkeeping.*` tools are a purpose-built layer over Odoo's accounting models for
bookkeeping and tax-close work (French CA12 VAT, key-account review, fiscal-return
tracking, and validate-only writes). They exist because raw Odoo CRUD is the wrong tool
for an LLM assistant here: Odoo Online rate-limits hard, accounting reads span many
related models, and any write to a locked period is dangerous. These tools batch the
reads, normalize the shapes, and refuse to write until a human confirms.

### Routing

| Intent | Tool surface |
|---|---|
| Expense population **audit** (account/VAT/payment/attachments/duplicates/totals) | `billing.audit_expenses` (read-only) |
| Draft vendor-bill / expense **preparatory** fields (draft-only) | `billing.update_draft_expense`, `billing.configure_draft_vendor_bill` |
| Reversible expense / vendor-bill **lifecycle** (reset→edit→resubmit/reapprove) | `call_model_method` on allowlisted methods only (`list_model_actions` → `executable:true`), with required write `context` + compatible record `state`; a transition that leaves `posted` additionally needs `confirmation_token` |
| Tax-close / report external value / return / lock-exception | `bookkeeping.plan_safe_write` (validate-only + human confirm) |
| Reversible CRUD / lifecycle on `account.*` / `hr.*` / etc. | Allowed via generic write tools — Odoo ACLs/workflow/locks are authority (not model-prefix denial) |
| Irreversible ledger ops (post / pay / reconcile / delete non-PM / lock) | Generic writes with `confirmation_token` (preflight → confirm → execute) |

#### Capability-gated reversible lifecycle (no orchestrator)

Reversible CRUD on `hr.expense` / `hr.expense.sheet` / `account.move` is **not** prefix-forbidden; Odoo validates. Prefer dedicated billing tools / allowlisted lifecycle when available. Operators compose:

1. **Reset to draft** — `billing.reset_expense` (dedicated tool, available on `/accounting/mcp`), or
   `call_model_method` on an allowlisted reset method (`action_reset` /
   `action_reset_expense_sheets` / vendor-bill `button_draft`) on the full `/mcp` surface.
2. `billing.update_draft_expense` / `billing.configure_draft_vendor_bill` — draft preparatory fields only.
3. **Submit / approve** — `billing.submit_expense` / `billing.approve_expense`, or the equivalent
   allowlisted `call_model_method` call on `/mcp`.

Both entry points run the same gate ([`src/lifecycle-gate.ts`](../src/lifecycle-gate.ts)) over the
same policy table ([`src/lifecycle-allowlist.ts`](../src/lifecycle-allowlist.ts)):

- non-empty write `context` (audit-only; never sent to Odoo),
- every requested id returned by a live pre-read — a partial read refuses the whole call,
- ids must be positive integers; anything else refuses the call rather than being skipped,
- current `state` compatible with the rule (and `move_type` for vendor bills),
- Odoo's own record-level flags (`can_reset`, `can_approve`) truthy where the version exposes them;
  a flag absent on the running version is skipped, never treated as a refusal.

**The fence — irreversible needs confirmation, not a flat deny.** High-risk methods require a
`confirmation_token` round-trip on generic MCP writes (preflight → confirm → execute). That class is:

- **posting**, under every alias — `action_post`, the ORM-internal `_post`, and per-model variants
  such as `button_validate` on bank statements. Matching only the public button name would let the
  same mutation through under a different label;
- **payment** post/register, **reconcile**, and non-PM **delete**;
- **lock-sensitive** writes — both `account.lock_exception` CRUD and any write that sets a
  lock-boundary field (`fiscalyear_lock_date`, `tax_lock_date`, `hard_lock_date`, …) on a reachable
  model. Note these fields live on `res.company` in Odoo 18/19, which the connector still
  default-denies, so that escalation is currently load-bearing only for `account.*`;
- **un-posting** — `button_draft` from state `posted`. Resetting a posted move to draft removes an
  accounting record that exists; it is the reverse of `action_post` and carries the same gate. From
  `cancel` there is no live entry to remove, so that direction executes in one call.

**Every** mutating write tool enforces this — `create_record`, `update_record`, `batch_update`,
`delete_record` and `call_model_method` all route through one guard, and all accept
`confirmation_token`. `batch_update` validates the whole batch before applying any update, so a
policy refusal can never cause a partial write.
`bookkeeping.plan_safe_write` is only for its four tax/lock operations (never post/pay). There is
**no** end-to-end billing orchestrator tool.

Dedicated expense lifecycle tools (also the only lifecycle path on `/accounting/mcp`):

| Tool | Transition | Guard |
|---|---|---|
| `billing.reset_expense` | submitted / approved / refused → draft | `can_reset` |
| `billing.submit_expense` | draft → submitted | — |
| `billing.approve_expense` | submitted → approved | `can_approve` |

Each takes `record_ids` (1–50) plus a **required** `context`, is all-or-nothing across the batch, and
returns `state_before` / `state_after` per record as evidence the transition landed.

Method names for the generic path (aligned with curated `actions-map` + upstream Odoo 17–19 `hr_expense`):

| Model | Allowlisted methods | Compatible `from_states` | Version note |
|---|---|---|---|
| `hr.expense` | `action_reset`, `action_submit`, `action_approve` | reset: submitted/approved/refused (+ legacy `reported`); submit: draft; approve: submitted | Primary on Odoo 19+ (sheet removed). `reported` is 17–18 line vocab only. |
| `hr.expense.sheet` | `action_reset_expense_sheets`, `action_submit_sheet`, `action_approve_expense_sheets` | reset: submit/approve/cancel; submit: draft; approve: submit | **Pre-19 only** — model removed in Odoo 19. |
| `account.move` | `button_draft` only | `cancel` (single call) or `posted` (**confirmation_token required**) | Cross-version. Not restricted by `move_type`: #2201's case is a manual entry, and Odoo's hash/lock checks are the authority on which moves may be reset. |

Draft bill/expense prep is **not** part of `plan_safe_write`. Generic writes are action-classified
(reversible → Odoo; irreversible → confirmation). Deny envelopes carry `refusing_layer` /
`policy_rule` / `risk_class` / `next_step` and route agents to the matching next step.

Registered on the MCP server in [`src/server.ts`](../src/server.ts) (`registerBookkeepingTools`,
`registerReturnPreviewTools`, `registerReportLineTools`, `registerSourceDocumentTools`,
`registerSafeWritePlannerTools`). Implementations live in
[`src/tools/bookkeeping.ts`](../src/tools/bookkeeping.ts). Billing draft writes live in
[`src/tools/billing.ts`](../src/tools/billing.ts)
(`registerBillingReadTools` + `registerBillingWriteTools`).

---

## 1. Snapshot-first philosophy

Assistants must **not** drive bookkeeping through raw Odoo CRUD (`search_records`,
`update_record`, …). `plan_safe_write` does not cover `project.task`, chatter, or
`mail.activity` — those are generic write tools. Instead the flow is:

1. **Few batched Odoo calls** — one tool call assembles everything needed (lock dates,
   report structure, return types, external values, key-account balances) in a handful of
   serialized reads, not dozens of ad-hoc round trips.
2. **Normalized snapshot** — the tool returns one JSON document with consistent shapes
   (many2one collapsed, `false` → `null`), so the model reasons over stable data.
3. **LLM reasons over the snapshot** — all interpretation happens against the returned
   JSON, offline from Odoo. No extra calls to "check one more thing."
4. **Dry-run write plan** — any proposed change goes through `bookkeeping.plan_safe_write`,
   which is **validate-only** and returns a *would-write* plan plus an HMAC confirmation
   token. It never writes.
5. **Explicit human confirmation** — the plan is shown to a human; the confirmation token
   is the gate.
6. **Validated write** — only a confirmed token authorizes the actual write (a separate,
   out-of-band step), so the LLM can never silently mutate the ledger.
7. **Audit trail** — every tool response carries `metadata` (Odoo call count, cache
   hits/misses, duration) and `warnings[]`, so the reasoning and cost are traceable.

Why this shape:

| Concern | How snapshot-first addresses it |
|---|---|
| **Rate limits** | Odoo Online tolerates ~1 req/sec with no parallelism; batching into few calls keeps within budget (see §2). |
| **Determinism** | The model reasons over one frozen JSON document, not a live, shifting Odoo state fetched call-by-call. |
| **Safety** | Writes are two-phase (validate → confirm → write); reads are read-only by default; nothing auto-reconciles or guesses tax treatment. |

> **Rule for assistants:** reach for `bookkeeping.*` tools for any bookkeeping/tax-close
> task. Use raw Odoo CRUD only for data these tools do not cover.

---

## 2. Rate-limit model

Every Odoo call — from these tools and from the generic read/write tools — is funneled
through a single [`OdooQueue`](../src/odoo-queue.ts) per `McpAgent`/Durable Object.

| Property | Value | Source |
|---|---|---|
| Minimum delay between call *starts* | **1000 ms → 1 call/sec** | `DEFAULT_MIN_DELAY_MS = 1000` (`src/odoo-queue.ts:24`) |
| Concurrency | **None** — a single serialized FIFO queue | `OdooQueue.drain()` |
| Parallelism | **Not allowed** — calls never overlap | class doc comment (`src/odoo-queue.ts`) |

> Odoo Online behaves as roughly 1 req/sec with no parallelism, so the queue enforces a
> minimum spacing between call starts and drains strictly in order. This is exactly why the
> tools batch: fewer, wider calls beat many narrow ones. Snapshot-first keeps a typical
> close review to a small handful of serialized reads.

---

## 3. Cache TTLs

Stable metadata is cached in an in-memory [`TtlCache`](../src/cache.ts) (one per Durable
Object, reset on eviction), so repeated lookups within the TTL skip the serialized queue
entirely.

| Cache class | What it covers | TTL | Constant (`src/cache.ts`) |
|---|---|---|---|
| Metadata | `fields_get` results, XML-ID resolution | **6 h** | `TTL_METADATA_MS = 6 * 60 * 60 * 1000` |
| Structure | chart of accounts, taxes, report structure | **1 h** | `TTL_STRUCTURE_MS = 60 * 60 * 1000` |
| Balances | account balances | **60 s** | `TTL_BALANCE_MS = 60 * 1000` |

`getFieldsCached` and `resolveXmlIdCached` use the 6 h metadata TTL; balances are the
freshest (60 s) because they move as journal entries post.

---

## 4. Tool reference

All eight tools are read-only or validate-only (none writes to Odoo). Field types below are
the Zod input schema in `src/tools/bookkeeping.ts`.

### 4.1 `bookkeeping.get_snapshot`

Assemble a bookkeeping/tax-close snapshot for a company over a period — lock dates, tax
report structure, tax return types/instances, external (manually-entered) report values,
and key-account balances. Sections are selected via `scopes`; optional sub-models that may
not exist on a given Odoo version degrade into `warnings[]` rather than aborting.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `company` | string | yes | — | company **name** (matched on `res.company.name`) |
| `date_from` | string | yes | — | `YYYY-MM-DD` |
| `date_to` | string | yes | — | `YYYY-MM-DD` |
| `scopes` | string[] (enum, min 1) | yes | — | any of `tax_report`, `tax_returns`, `return_types`, `external_values`, `key_accounts` |
| `key_account_codes` | string[] | no | — | required *in practice* when `key_accounts` is requested, else that scope is skipped with a warning |

> `external_values` requires `tax_report` in the same call (it needs the report expression
> ids to resolve values); otherwise it is skipped with a warning.

**Input**

```json
{
  "company": "Ma Société SARL",
  "date_from": "2025-10-01",
  "date_to": "2026-09-30",
  "scopes": ["tax_report", "external_values", "key_accounts"],
  "key_account_codes": ["471000", "445670"]
}
```

**Output (abridged)**

```json
{
  "company": {
    "id": 1,
    "name": "Ma Société SARL",
    "country": [75, "France"],
    "lock_dates": { "fiscalyear_lock_date": "2025-09-30", "tax_lock_date": "2025-09-30" }
  },
  "period": { "date_from": "2025-10-01", "date_to": "2026-09-30" },
  "tax_report": {
    "reports": { "model": "account.report", "records": [ /* … */ ] },
    "lines": { "model": "account.report.line", "records": [ /* … */ ] },
    "expressions": { "model": "account.report.expression", "records": [ /* … */ ] }
  },
  "external_values": {
    "values": {
      "model": "account.report.external.value",
      "records": [
        { "id": 88, "date": "2025-09-30", "value": 942.0, "in_period": false }
      ]
    }
  },
  "key_accounts": {
    "balances": { "model": "account.move.line", "records": [ /* per-account balance */ ] },
    "top_open_lines": { "model": "account.move.line", "by_account_id": { "…": [] } }
  },
  "warnings": [],
  "metadata": { "odoo_calls": 9, "cache_hits": 4, "cache_misses": 5, "duration_seconds": 10.2 }
}
```

### 4.2 `bookkeeping.review_key_accounts`

Review key balance-sheet accounts (e.g. suspense `471000`, internal transfers `580000`,
compte courant d'associé `455100`, VAT credit `445670`) and flag closure blockers. Returns
per-account balance, open-item count, top open lines, and a **factual** severity heuristic
(`attention` / `ok` / `info` / `unknown`). Unknown codes surface in `warnings[]`.

`balance` / `debit` / `credit` are nullable: when the balances `read_group` fails they are
`null` and `severity` is `"unknown"` (plus a balances-unavailable warning). A successful
query with no grouped rows still defaults missing accounts to `0` and runs `computeSeverity`
(empty aggregate → `"ok"`). Do not treat `null` as zero.

| Field | Type | Required | Default |
|---|---|---|---|
| `company` | string | yes | — |
| `date_to` | string | yes | — |
| `account_codes` | string[] | yes | — |

**Input**

```json
{ "company": "Ma Société SARL", "date_to": "2026-09-30", "account_codes": ["471000", "580000"] }
```

**Output (abridged)**

```json
{
  "accounts": [
    {
      "code": "471000", "name": "Compte d'attente", "id": 812,
      "balance": 1240.5, "debit": 1240.5, "credit": 0.0,
      "account_type": "asset_current", "reconcile": false,
      "severity": "attention", "open_item_count": 3, "top_lines": [ /* … */ ]
    }
  ],
  "warnings": [],
  "metadata": { "odoo_calls": 4, "cache_hits": 2, "duration_seconds": 4.8 }
}
```

> Severity is factual only: a suspense/clearing account carrying any balance or open item
> is `attention`; a fully-empty account is `ok`; anything else is `info`; balances (or
> open-lines needed for a clean `ok`) that could not be fetched yield `unknown`. The tool
> never judges whether a line *should* be reconciled.

**Odoo version compatibility (balance aggregation).** Move-line balances use
`readGroupCompat` ([`src/aggregation.ts`](../src/aggregation.ts)): Odoo **19+** calls
`formatted_read_group` (aggregates keyed as `field:agg`, no `lazy`/`fields` body keys);
Odoo **≤18** falls back to legacy `read_group`. The resolved method is cached per database
(same TTL as metadata). When both APIs fail, `balance` / `debit` / `credit` are `null` and
`severity` is `"unknown"` — same semantics as a single-method failure above. A successful
query with no grouped rows still defaults missing accounts to `0` and runs `computeSeverity`.

### 4.3 `bookkeeping.explain_report_line`

Explain **why** a tax-report line shows its value, from facts only — never guessing tax
treatment. Resolves the line, dumps its `account.report.expression` records, and per engine
(`external` / `tax_tags` / `aggregation`) fetches the supporting Odoo data, then assembles a
fact-only `diagnosis`. Surfaces the French CA12 `box_22` carryover trap (see §5).

| Field | Type | Required | Default |
|---|---|---|---|
| `company` | string | yes | — |
| `report_name` | string | yes | — |
| `line_code` | string | yes | — |
| `date_from` | string | yes | — |
| `date_to` | string | yes | — |

**Input**

```json
{
  "company": "Ma Société SARL",
  "report_name": "Déclaration de TVA (CA12)",
  "line_code": "box_22",
  "date_from": "2025-10-01",
  "date_to": "2026-09-30"
}
```

**Output (abridged)** — see §5 for the interpreted walkthrough.

```json
{
  "line": { "id": 5501, "code": "box_22", "name": "Crédit de TVA à reporter" },
  "expressions": [
    {
      "id": 9001, "label": "_applied_carryover_balance", "engine": "external",
      "formula": null, "subformula": null, "date_scope": "previous_return_period",
      "included_external_values": [ { "id": 88, "date": "2025-09-30", "value": 942.0 } ],
      "excluded_external_values": []
    }
  ],
  "formula_trace": [],
  "diagnosis": "expression _applied_carryover_balance (engine=external, date_scope=previous_return_period) has 1 external value(s) dated within 2024-10-01..2025-09-30",
  "warnings": []
}
```

### 4.4 `bookkeeping.list_source_documents`

List the `ir.attachment` source documents on a record (e.g. `account.move`), tagging each
as `original_source`, `official_pdf`, or `other`.

| Field | Type | Required | Default |
|---|---|---|---|
| `model` | string | no | `"account.move"` |
| `record_id` | int (positive) | yes | — |

**Input**

```json
{ "model": "account.move", "record_id": 34021 }
```

**Output (abridged)**

```json
{
  "documents": [
    { "id": 77, "name": "facture.pdf", "mimetype": "application/pdf", "res_field": false, "tag": "original_source" },
    { "id": 78, "name": "INV-2026-001.pdf", "mimetype": "application/pdf", "res_field": "invoice_pdf_report_file", "tag": "official_pdf" }
  ],
  "warnings": [],
  "metadata": { "odoo_calls": 2, "cache_hits": 0, "duration_seconds": 2.1 }
}
```

### 4.5 `bookkeeping.search_source_documents`

Search the Odoo **Documents** repository (`documents.document`) — the app where scanned
invoices, receipts and statements are filed — by filename, folder, tags, owner, upload
window, or linked record. Complements §4.4: `list_source_documents` answers *"what is
attached to this journal entry?"*, this one answers *"where is that PDF, and is it filed
against anything?"*.

Metadata only: the binary payload (`datas`) is never read. Take `attachment.id` from a
result and pass it to §4.6 `fetch_attachment` when you actually need the bytes.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `filename` | string | no | — | case-insensitive substring (`ilike`) on `name` |
| `folder_id` | int (positive) | no | — | Documents folder id |
| `tag_ids` | int[] (positive) | no | — | matches documents carrying **any** of these tags (`in`) |
| `owner_id` | int (positive) | no | — | `res.users` id of the document owner |
| `date_from` | string | no | — | `create_date >=` (ISO date or `YYYY-MM-DD HH:MM:SS`) |
| `date_to` | string | no | — | `create_date <=` |
| `res_model` | string | no | — | linked model, e.g. `account.move`, `project.task` |
| `res_id` | int (positive) | no | — | linked record id |
| `limit` | int | no | `80` | 1–200 |

Every supplied filter is ANDed; omitting all of them searches the whole repository (capped
by `limit`). Results are ordered `create_date desc, id desc`, so repeated calls page
deterministically.

**Cost.** One `search_read` on `documents.document`, plus at most **one** batched
`documents.tag` read to resolve tag names for the whole result set — never one call per
document. A tag id the read does not return (deleted or unreadable) is reported as
`{ id, name: "<id>" }` rather than dropped.

**Input**

```json
{ "filename": "facture", "res_model": "account.move", "date_from": "2026-01-01", "limit": 25 }
```

**Output (abridged)**

```json
{
  "documents": [
    {
      "id": 11,
      "name": "facture.pdf",
      "folder": { "id": 3, "name": "Invoices" },
      "tags": [{ "id": 7, "name": "Vendor Bill" }],
      "owner": { "id": 2, "name": "Mitchell Admin" },
      "res_model": "account.move",
      "res_id": 42,
      "create_date": "2026-01-15 09:00:00",
      "write_date": "2026-01-16 10:00:00",
      "mimetype": "application/pdf",
      "file_size": 51234,
      "checksum": "abc123",
      "attachment": { "id": 77, "name": "facture.pdf" }
    }
  ],
  "warnings": []
}
```

Many2one fields are normalized to `{ id, name }`, and Odoo's `false` becomes `null`
throughout.

**Graceful degradation.** Odoo Documents is a separate (Enterprise) app, so it may simply
not be there. When `documents.document` is missing or ACLs/record rules deny it, the tool
returns an empty list plus a warning instead of an error envelope — an audit that cannot
reach the repository still gets a usable answer:

```json
{
  "documents": [],
  "warnings": ["Odoo Documents module (documents.document) is not installed or access was denied by ACLs."]
}
```

Degradation is deliberately narrow: only a missing `documents.document` model or an ACL
denial **on that model** produces the warning. Everything else — a rejected session (401),
timeout, rate limit, invalid domain, or a field this Odoo version does not expose — still
surfaces as the standard error envelope with `isError: true`, because an empty
`documents: []` is indistinguishable from "the audit found nothing" and must never stand in
for a failure the caller could fix or retry.

### 4.6 `bookkeeping.fetch_attachment`

Fetch an `ir.attachment`'s metadata and, unless it is a URL-type attachment or exceeds
`max_bytes`, its base64-encoded content.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `attachment_id` | int (positive) | yes | — | |
| `max_bytes` | int (positive) | no | `10485760` (10 MiB) | over-size files return an error, not content — base64 inflates ~1.37× against Worker memory limits |

**Input**

```json
{ "attachment_id": 77, "max_bytes": 10485760 }
```

**Output (abridged)**

```json
{ "name": "facture.pdf", "mimetype": "application/pdf", "file_size": 51234, "base64": "JVBERi0xLjQ…" }
```

> A `type: "url"` attachment returns `{ name, mimetype, file_size, url }` with no `base64`.

### 4.7 `bookkeeping.preview_returns`

> **Naming note:** the task brief referred to this tool as `return_type_preview`. The
> **registered name in code is `bookkeeping.preview_returns`** — that is what this document
> uses, and the discrepancy is resolved in favor of the code.

Preview which `account.return` (fiscal return) cards *should* exist for a company over a
date window, based on `account.return.type` configuration resolved from XML IDs. Flags each
expected return as existing or missing. When a return type's periodicity is blank or
unrecognized, it reports a `configuration_issues` entry instead of guessing periods.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `company` | int (positive) | yes | — | company **id** (not name) |
| `from` | string | yes | — | `YYYY-MM-DD` |
| `to` | string | yes | — | `YYYY-MM-DD` |
| `return_type_xmlids` | string[] (min 1) | yes | — | e.g. `["l10n_fr_reports.vat_return_type"]` |

**Input**

```json
{
  "company": 1,
  "from": "2025-10-01",
  "to": "2026-09-30",
  "return_type_xmlids": ["l10n_fr_reports.vat_return_type"]
}
```

**Output (abridged)** — see §6 for the interpreted walkthrough.

```json
{
  "return_types": [ { "id": 12, "name": "TVA (CA12)" } ],
  "existing_returns": [],
  "expected_returns": [],
  "configuration_issues": [
    "account.return.type 12 (TVA (CA12)): periodicity/deadline_periodicity is blank or unrecognized; cannot preview periods; manual creation of the return may be required."
  ],
  "warnings": []
}
```

### 4.8 `bookkeeping.plan_safe_write`

**Validate-only — NEVER writes to Odoo.** Runs read-only checks (company/field existence,
record state, period consistency, duplicates, lock dates) for a proposed bookkeeping write
and returns a *would-write* plan plus an HMAC confirmation token. A `confirmation_token` is
issued only when `status` is `safe` (or a `duplicate_found` that resolves to an in-place
update); never for `blocked` or `needs_lock_exception`.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `operation` | enum | yes | — | one of the four operations below |
| `company` | string | yes | — | company **name** |
| `values` | object (`Record<string, unknown>`) | yes | — | operation-specific payload |

Supported `operation` values (exact enum in code):

| Operation | Purpose |
|---|---|
| `create_or_update_report_external_value` | Set a manual external value on a report expression (e.g. a CA12 carryover). |
| `create_manual_tax_return` | Create a missing `account.return` card manually. |
| `update_return_type_periodicity` | Fix a blank/incorrect `account.return.type` periodicity field. |
| `create_lock_exception` | Request a lock-date exception for a locked period. |

**Input**

```json
{
  "operation": "create_or_update_report_external_value",
  "company": "Ma Société SARL",
  "values": {
    "report_line_code": "box_22",
    "expression_label": "_applied_carryover_balance",
    "date": "2025-09-30",
    "value": 942.0,
    "name": "Crédit de TVA reporté N-1"
  }
}
```

**Output (abridged)**

```json
{
  "status": "safe",
  "resolved_target": { /* line + expression resolved */ },
  "existing_records": [],
  "lock_dates": { "tax_lock_date": "2025-09-30" },
  "warnings": [],
  "would_write": { "model": "account.report.external.value", "method": "create", "values": { /* … */ } },
  "confirmation_required": true,
  "confirmation_token": "<hmac-token>"
}
```

> The token is issued only when `CONFIRMATION_SECRET` is configured **and** the plan is
> safe. No token ⇒ no authorized write.

---

## 5. Worked walkthrough #1 — French CA12 VAT carryover (`box_22`)

**Symptom.** An accountant runs the CA12 and sees line `box_22` ("Crédit de TVA à reporter")
reading **0**, even though last year closed with a **942 €** VAT credit carried forward. The
external value clearly exists — dated **2025-09-30**, the last day of the previous fiscal
year — so why does the line read zero?

**The trap.** `box_22`'s expression `_applied_carryover_balance` uses
`engine=external` with **`date_scope=previous_return_period`**. The tool computes the
*effective* window for that expression via `effectiveDateWindow` →
`previousPeriod(date_from, date_to)`, which is the period immediately preceding the
requested one (ends the day before `date_from`, same length). An external value only counts
toward the line when `isInPeriod(value.date, effectiveWindow.from, effectiveWindow.to)` is
true. So the requested window matters twice over — and picking the *wrong preset period*
silently pushes the 2025-09-30 value out of scope.

**Diagnose the wrong-period case.** Suppose the report was run over the **calendar year**
2025-01-01..2025-12-31 (a plausible but wrong preset for an Oct→Sep fiscal filer):

```json
{
  "company": "Ma Société SARL",
  "report_name": "Déclaration de TVA (CA12)",
  "line_code": "box_22",
  "date_from": "2025-01-01",
  "date_to": "2025-12-31"
}
```

`effectiveDateWindow("previous_return_period", "2025-01-01", "2025-12-31")` →
`previousPeriod` → **2024-01-01..2024-12-31**. The 942 € value dated **2025-09-30** is *after*
that window, so it lands in `excluded_external_values`:

```json
{
  "line": { "id": 5501, "code": "box_22", "name": "Crédit de TVA à reporter" },
  "expressions": [
    {
      "id": 9001, "label": "_applied_carryover_balance", "engine": "external",
      "date_scope": "previous_return_period",
      "included_external_values": [],
      "excluded_external_values": [ { "id": 88, "date": "2025-09-30", "value": 942.0 } ]
    }
  ],
  "diagnosis": "expression _applied_carryover_balance (engine=external, date_scope=previous_return_period) has 0 external value(s) dated within 2024-01-01..2024-12-31; 1 external value(s) exist dated 2025-09-30 (out of scope)",
  "warnings": []
}
```

**Interpretation.** The `diagnosis` says it plainly: *the 942 € value exists, but it is dated
2025-09-30 — out of scope for the effective window 2024-01-01..2024-12-31.* The line is not
missing data; the report was run over the wrong period.

**The fix — run the correct fiscal period** 2025-10-01..2026-09-30. Now
`previousPeriod` → **2024-10-01..2025-09-30**, and 2025-09-30 falls *inside* it:

```json
{
  "expressions": [
    {
      "label": "_applied_carryover_balance", "engine": "external",
      "date_scope": "previous_return_period",
      "included_external_values": [ { "id": 88, "date": "2025-09-30", "value": 942.0 } ],
      "excluded_external_values": []
    }
  ],
  "diagnosis": "expression _applied_carryover_balance (engine=external, date_scope=previous_return_period) has 1 external value(s) dated within 2024-10-01..2025-09-30"
}
```

`box_22` now correctly reflects the 942 € carryover — no data changed, only the reporting
window. The tool only ever reports facts (which values are in/out of scope); it never
invents or reclassifies the carryover.

---

## 6. Worked walkthrough #2 — the missing "TVA oct. 2025 – sept. 2026" return card

**Symptom.** The fiscal-return dashboard is missing the expected **"TVA oct. 2025 – sept.
2026"** CA12 card. It never auto-generated, so nothing tells the accountant a filing is due.

**Root cause.** The `account.return.type` behind French VAT
(`l10n_fr_reports.vat_return_type`) has a **blank `periodicity`** (and blank
`deadline_periodicity`). With no cadence, Odoo cannot auto-generate the period's return, and
neither can this tool — it refuses to guess.

**Detect it with `preview_returns`:**

```json
{
  "company": 1,
  "from": "2025-10-01",
  "to": "2026-09-30",
  "return_type_xmlids": ["l10n_fr_reports.vat_return_type"]
}
```

Internally the tool calls `normalizePeriodicity(selectionRawValue(...))`. A blank value
trims to `""` and returns **`null`**, which short-circuits period generation and pushes a
`configuration_issues` entry instead of fabricating periods:

```json
{
  "return_types": [ { "id": 12, "name": "TVA (CA12)" } ],
  "existing_returns": [],
  "expected_returns": [],
  "configuration_issues": [
    "account.return.type 12 (TVA (CA12)): periodicity/deadline_periodicity is blank or unrecognized; cannot preview periods; manual creation of the return may be required."
  ],
  "warnings": []
}
```

**Interpretation.** `expected_returns` is empty **not** because nothing is due, but because
the return type is misconfigured — the `configuration_issues` entry names the exact record
(`account.return.type 12 (TVA (CA12))`) and the blank periodicity. This is the actionable
signal: either fix the periodicity on the return type, or create the missing card manually.

**Remediation path (still validate-only).** Both fixes go through
`bookkeeping.plan_safe_write`, never a raw write:

- `update_return_type_periodicity` — set the return type's periodicity so future cards
  auto-generate; or
- `create_manual_tax_return` — create the single missing "TVA oct. 2025 – sept. 2026" card
  for this period.

Each returns a *would-write* plan and (when safe) an HMAC confirmation token; the actual
write happens only after explicit human confirmation.
