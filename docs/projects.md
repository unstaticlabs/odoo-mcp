# Project-management writes and chatter reads

Canonical routing guide for **project-management (PM) lane** tools in odoo-mcp. The connector
classifies writes by **structured intent** — target model, method, and field names — never by
free-text keywords in notes or chatter.

See also:

- [Write lanes (PM vs accounting)](bookkeeping.md#write-lanes) in the bookkeeping guide
- [Bulk chatter reads (anti-pattern)](bookkeeping.md#7-project-management-chatter-reads-anti-pattern)
- [Testing §g — `projects.list_chatter`](testing.md#g-projectslist_chatter-hermetic-coverage)
- [README tools table](../README.md#tools)

---

## Two lanes (quick reference)

| Lane | Tools | Models / scope | Keyword policy |
|---|---|---|---|
| **Project management** | `create_record`, `update_record`, `post_message`, `batch_post_message`, `call_model_method` | `project.task`, `project.project`, `mail.activity` with `res_model` ∈ `{project.task, project.project}`; chatter via `message_post` | **Allowed** — `description` / `note` / `summary` / `body` may mention banking, B2C exports, VAT handoffs, payroll ops, deadlines |
| **Bookkeeping / tax-close** | `bookkeeping.plan_safe_write` **only** (validate-only; four operations) | `account.report.external.value`, `account.return`, `account.return.type`, `account.lock_exception` | PM-shaped `values` rejected **structurally** — never `project.task` / `mail.activity` |

Accounting mutations never go through generic write tools. PM notes never go through
`bookkeeping.plan_safe_write`.

---

## PM write tools

All generic write tools pass through `assessWriteOperation` in [`src/write-safety.ts`](../src/write-safety.ts),
which delegates PM classification to `classifyPmWriteIntent` in [`src/safety.ts`](../src/safety.ts).

| Tool | Typical use |
|---|---|
| `create_record` | New `project.task`, `mail.activity`, or `project.project` row |
| `update_record` | Stage, assignee, deadline, description on an existing PM record |
| `post_message` | Single chatter comment on a task or project (`message_post`) |
| `batch_post_message` | Same as `post_message`, multiple records of one model |
| `call_model_method` | Gated lifecycle calls (e.g. `mail.activity` → `action_feedback`) |

### Example: activity with finance-keyword note

```json
{
  "model": "mail.activity",
  "values": {
    "res_model": "project.task",
    "res_id": 990,
    "activity_type_id": 4,
    "summary": "B2C bank export",
    "note": "Remind Valentin: B2C bank export deadline Friday",
    "date_deadline": "2026-07-18",
    "user_id": 42
  }
}
```

Use `create_record` — **not** `bookkeeping.plan_safe_write`. The word "bank" in `note` does not
change the lane.

### Example: chatter on a task

```json
{
  "model": "project.task",
  "record_id": 990,
  "body": "Follow up on VAT handoff with accounting before payroll close."
}
```

Use `post_message`.

### Example: complete an activity

```json
{
  "model": "mail.activity",
  "method": "action_feedback",
  "ids": [12345],
  "kwargs": { "feedback": "Export sent to Valentin." }
}
```

Use `call_model_method` when the method is gated as mutating.

---

## Field allowlist behavior

The gate inspects **field names**, not prose content.

- **Prose fields** (`description`, `note`, `summary`, `body`) are never keyword-scanned —
  finance terms in text are explicitly allowed on PM records.
- **Non-allowlisted field names** that match financial patterns (e.g. `account_id`, `amount_total`)
  on PM models are blocked as `financial_mutation`.
- Canonical PM models: `project.task`, `mail.activity` (with `res_model` = `project.task` or
  `project.project`). Additional compat allowlists cover `project.project` and project metadata
  models — see `COMPAT_*` sets in [`src/write-safety.ts`](../src/write-safety.ts).

Writable field sets in code:

- `PROJECT_TASK_PM_FIELDS` — [`src/safety.ts`](../src/safety.ts)
- `PM_TEXT_FIELDS` — `description`, `note`, `summary`, `body`
- `COMPAT_MAIL_ACTIVITY_FIELDS`, `COMPAT_PROJECT_PROJECT_FIELDS` — compat layer in write-safety

---

## PM chatter reads

### Single task

```json
{
  "model": "project.task",
  "record_id": 990,
  "include_chatter": true,
  "include_attachments": false
}
```

Use `expand_record`. One scoped `mail.message` query per invocation (8-call budget shared with
relations/attachments).

### Multiple tasks

```json
{
  "task_ids": [990, 954, 991],
  "limit_per_task": 20,
  "order": "date desc"
}
```

Use `projects.list_chatter`. Each task id gets its own scoped `mail.message` query — never
`res_id in [...]` with `body` / `preview` / `email_body`.

When the 8-call budget is exhausted, the response includes `metadata.truncated_task_ids`.
Re-invoke with those ids (and/or reduce `task_ids` per call).

### Anti-pattern — do not do this

```json
{
  "model": "mail.message",
  "domain": [["model", "=", "project.task"], ["res_id", "in", [990, 954, 991]]],
  "fields": ["body", "preview"]
}
```

Reasons:

1. MCP hosts may block bulk message-body fetches (especially with finance keywords).
2. Odoo rate limit (~1 req/s) makes wide scans slow.
3. Per-task tools return normalized, bounded payloads.

Full workflow and hermetic test coverage: [docs/testing.md §g](testing.md#g-projectslist_chatter-hermetic-coverage).

---

## Bookkeeping lane (out of scope here)

Tax-close and ledger mutations use **`bookkeeping.plan_safe_write` only** — four `operation`
values, validate-only, structural PM rejection. See
[§4.7 in docs/bookkeeping.md](bookkeeping.md#47-bookkeepingplan_safe_write).

The bookkeeping planner in [`src/safety.ts`](../src/safety.ts) (lock dates, HMAC tokens) is the
validate-only companion; it does not handle PM models.
