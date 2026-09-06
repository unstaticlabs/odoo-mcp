# ORM-first MCP redesign

Status: proposal, not accepted

Baseline: `e9a7652` (`main`)

Analysed: 2026-09-06

This document analyses the current MCP interface and proposes a smaller, more
reliable one built directly on the Odoo 19 ORM. It supersedes the tool-surface
sections of [`refactor-spec.md`](refactor-spec.md) if accepted; the runtime,
identity, transport, and transaction invariants in that document are unchanged
and are assumed throughout.

Every claim about the Odoo surface below was verified live against the
Distribution through `/json/2` during the analysis, not inferred from
documentation.

## 1. Where the current design stands

Measured from the registry at the baseline commit:

| Profile | Tools | Estimated schema tokens |
| --- | ---: | ---: |
| `default` | 31 | 14,988 |
| `all` | 50 | 21,963 |
| `read-only` | 25 | 9,732 |
| `accounting` | 32 | 14,404 |
| `advanced` | 32 | 15,370 |
| `documents` | 30 | 12,622 |
| `projects` | 19 | 8,488 |
| `b2c` | 16 | 7,202 |

Of the 50 registered capabilities, 14 are generic and 36 are domain shortcuts.
`src/capabilities/` is 3,090 lines, of which `semantic.ts` (968),
`operational.ts` (776), and `accounting.ts` (221) are almost entirely
hand-written joins over `read` and `search_read`.

The default profile sits at 14,988 of a 15,000-token budget. There are twelve
tokens of headroom. Every new capability now requires evicting an existing one,
and `docs/tool-catalogue.md` already documents which workflows were *not*
promoted for lack of room. The surface has reached its design limit.

## 2. What is actually wrong

### 2.1 The shortcuts freeze joins that Odoo expresses natively

`contacts_get_partner_context`, `projects_get_task_context`,
`accounting_get_invoice_context`, `expenses_get_context`,
`expense_batches_get_context`, `b2c_get_order_context`, `home_get_attention`,
and the accounting overview/report family are all the same shape: read one
record with a hardcoded field list, fan out two to four more `search_read`
calls, and merge the results into an untyped `{context: {...}}` blob.

`projects_get_task_context` issues four round trips and hardcodes seventeen
`project.task` field names. Its output schema is `z.record(z.string(),
z.unknown())` — the agent gets no contract, and the field list can only change
by deploying the MCP.

Odoo 19 does this in one call. Verified live:

```
res.partner.web_search_read(
  domain=[["is_company","=",true]],
  specification={
    "display_name": {},
    "country_id": {"fields": {"display_name": {}, "code": {}}},
    "child_ids":  {"fields": {"display_name": {}, "email": {}}, "limit": 3}
  },
  limit=2, count_limit=1000)

-> {"length": 84,
    "records": [{"id": 100, "display_name": "ADA",
                 "country_id": {"id": 75, "code": "FR", "display_name": "France"},
                 "child_ids": []}, ...]}
```

The `specification` nests to arbitrary depth, takes per-relation `limit`,
`order`, and `context`, returns relational values as `{id, display_name}`
objects rather than `[id, name]` tuples, and returns the total in `length`.

That single method subsumes `odoo_search_records`, `odoo_read_records`,
`odoo_expand_record` (which is capped at *one* hop, ten relations, and performs
an N+1 read per relation), the `include_count` flag, and the read half of every
`*_get_context` tool.

### 2.2 The ORM surface the MCP exposes is a small subset of what Odoo offers

`res.partner` publishes 65 methods over JSON-2. The MCP's generic substrate
uses six of them. The unused ones are not obscure:

| Odoo method | What it gives an agent | Current MCP substitute |
| --- | --- | --- |
| `web_search_read(domain, specification, ...)` | nested relational read, any depth, one call | 3 tools + N+1 reads |
| `web_save(vals, specification, next_id)` | create **or** update **and** read back, one transaction | `create` then `read` |
| `web_save_multi(vals_list, specification)` | heterogeneous multi-record write, one transaction | *nothing* — explicitly refused |
| `onchange(values, field_names, fields_spec)` | Odoo-computed defaults and derived values | bespoke `*_configure_draft_*` tools |
| `name_search(name, domain, operator, limit)` | resolve a label to an id the way Odoo does | agent guesses an `ilike` domain |
| `has_access(operation)` / `has_field_access(field, op)` | preflight authorization | attempt and fail |
| `formatted_read_grouping_sets(...)` | multi-dimensional aggregation, one query | N separate `aggregate` calls |
| `formatted_read_group(..., having=...)` | filter on aggregates | *nothing* — `having` is not exposed |
| `get_external_id` / `get_metadata` | xmlid resolution, audit fields | *nothing* |
| `copy(default)` | duplicate a record | *nothing* |

Two of these are decisive.

**`web_save_multi` removes a documented limitation.** `odoo_update_records`
states that "heterogeneous updates and multi-step workflow transitions are
intentionally not bundled here" — it applies one values object to many ids.
Odoo's own method takes a `vals_list` of different values for different records
and commits them in one transaction, which is exactly what the "one MCP action
maps to one Odoo transaction" invariant asks for.

**`onchange` removes the reason most bespoke write tools exist.** Verified
live on `account.move`:

```
onchange(values={"move_type":"in_invoice","partner_id":100},
         field_names=["partner_id"],
         fields_spec={... "fiscal_position_id": {"fields": {"display_name": {}}} ...})

-> {"value": {"fiscal_position_id": {"id": 4, "display_name": "Domestique - France"}}}
```

Odoo derived the fiscal position from the partner. `expenses_configure_draft_vendor_bill`
is the single largest schema in the catalogue at 1,838 tokens — 12% of the
entire default budget — because it reimplements this class of derivation in
TypeScript. Any Distribution change to that logic silently desynchronises the
MCP copy. Calling `onchange` cannot desynchronise, because Odoo is computing it.

`name_search` matters for a subtler reason. Verified live, `name_search("ADA")`
on `res.partner` returned both `ADA` and `Perrin Calzada` — the second matches
on a field the model folds into its name search. A `[["name","ilike","ADA"]]`
domain, which is what an agent writes today, misses it. Label resolution is the
most common first step in any real task and the MCP currently offers no
ORM-correct way to do it.

### 2.3 `odoo_describe_model` cannot be used on the models that matter

It is one of the five `alwaysLoad` primitives and the documented entry point
for "inspect models instead of guessing". Measured live:

- `res.partner`, methods only, no fields: **68,671 characters** (~17k tokens)
- `account.move`, fields only, no methods: **156,100 characters** (~39k tokens), 258 fields at ~602 bytes each

A single `describe_model` call on `account.move` costs more than twice the
entire tool-schema budget for the whole server. There is no field filter, no
pagination, and no attribute projection. The per-field payload carries
`allow_hierachy_operators`, `change_default`, `default_export_compatible`,
`depends`, `exportable`, `manual`, `module`, and a raw Python `domain` string —
none of which an agent can act on.

The tool's own `fields_get` fallback path already projects down to seven
attributes. The primary `/doc-bearer` path applies no projection at all. The
fallback is strictly better behaved than the primary.

### 2.4 The escape hatch cannot tell a read from a write

`odoo_call_method` is classified `effect: "consequential"` with
`destructiveHint: true`, gets exactly one transport attempt, and returns a
mutation-reconciliation envelope. That contract is correct for `action_post`.
It is wrong for `web_search_read`, `name_search`, `onchange`, and `has_access`
— every advanced ORM read in this document was executed through it during this
analysis, and each one was annotated to the client as destructive and denied
the retry policy that `odoo_search_records` gets for the same underlying work.

The information needed to fix this already exists. `/doc-bearer` reports
`"api": ["model", "readonly"]` per method — the analysis read it directly from
the cached document. But `discoverSurfaceStrict` in `src/odoo/client.ts:~400`
flattens `candidate.methods` into a `Set<string>` of names and discards the
`api` array. The signal is fetched, then thrown away.

### 2.5 Inputs that should be typed are not

- **Domains** are `z.array(z.unknown())`. `assertBoundedDomain` checks nesting
  depth and node count and nothing else. A malformed domain reaches Odoo and
  comes back as an opaque error the model cannot self-correct from.
- **x2many command tuples** pass through `z.record(z.string(), z.unknown())`.
  `(0,0,vals)`, `(4,id)`, `(6,0,ids)` are the most error-prone construct in the
  ORM and the MCP offers no validation, no naming, and no guidance.
- **Company context** is untyped. `AGENTS.md` requires "preserve company
  context", but `allowed_company_ids` is just a key in a free-form
  `OdooContextSchema` dict. Nothing in any schema enforces or even hints at the
  invariant. The same is true of `lang`, `tz`, and `active_test`.

### 2.6 Pagination is offset-based over live tables

`encodeCursor`/`decodeCursor` bind an offset to a query fingerprint. The
fingerprint proves the *query* did not change; it says nothing about the table.
Inserts and deletes between pages cause skipped and duplicated rows. For an
agent paging an invoice list while the business is operating, this is a
correctness bug, not a nicety.

### 2.7 The registry carries more machinery than 50 tools justify

Visibility is decided by six independent axes — `layer`, `toolsets[]`,
`profiles[]`, `defaultVisible`, `alwaysLoad`, `sortOrder` — resolved by a
`includedInProfile` method with special cases for `all`, `read-only`,
`default`, and `advanced` before falling through to tag matching.

On top of that, `registry.ts` contains a hand-rolled retrieval engine:
a stopword list, a singulariser, phrase normalisation, and an additive scoring
function (name 100, id 90, phrase 25, keyword 20, title 10, description 3),
plus `recommendFallback`, a ~60-line heuristic router that decides which tool
to suggest when search fails. That is roughly 150 lines of search infrastructure
whose entire purpose is to help a model navigate a catalogue that is too large
to hold in context.

`/mcp` and `/mcp/all` differ only in `defer_loading` metadata, and
`docs/tool-catalogue.md` carries a section explaining which hosts do and do not
materialise deferred schemas. That documentation exists solely because the
surface does not fit.

### 2.8 Smaller items

- `decorateRecords` clones every returned row to inject a four-field `_ref`.
  `web_search_read` returns `display_name` and nested `{id, display_name}`
  natively; the public origin is already in the envelope `meta`.
- `odoo_search_models` fetches the entire API document and filters it in
  JavaScript on every call.
- `decorateRecords` is applied to `formatted_read_group` output, where rows have
  no `id` and the decoration is meaningless.
- `ODOO_MCP_DIFFERENTIAL_REVIEW_2026-08-29.md` sits in the repository root and
  describes the superseded Cloudflare Worker architecture (Durable Objects,
  origin-keyed coordinators). It should move under `docs/` or be deleted.

## 3. Proposed design

### Principle

**The MCP is a thin, well-typed, well-guarded projection of the Odoo ORM.**

Odoo already publishes a stable, documented, permission-checked, transactional
API. Every hand-written semantic tool is a frozen snapshot of a join Odoo can
express natively and more generally. Removing them makes the surface smaller
*and* more capable at the same time — that is the whole argument.

### The tool set

Twelve tools replace fifty, and cover strictly more of Odoo.

**Discovery**

1. `odoo_find_models` — search accessible models. Must not re-fetch and re-filter
   the whole API document per call.
2. `odoo_inspect_model` — **projected** field and method metadata. Defaults to a
   compact per-field summary (`name`, `type`, `string`, `relation`, `required`,
   `readonly`, `selection`, `store`), a field cap with `has_more`, and a
   substring filter. Methods return name + signature only; full documentation
   for explicitly named methods. Fixes §2.3.
3. `odoo_resolve` — `name_search` plus xmlid resolution via `ir.model.data` and
   `get_external_id`. Label → `{id, display_name}`, the Odoo-correct way.
   Fixes the largest class of agent error (§2.2).

**Read**

4. `odoo_search` — `web_search_read` with a nested `specification`, typed
   `domain`, `order`, `limit`, keyset cursor, and `count_limit`. Subsumes
   `odoo_search_records`, `odoo_read_records` (as `[["id","in",ids]]`), and
   `odoo_expand_record`, at arbitrary depth instead of one hop.
5. `odoo_group` — `formatted_read_group` with `having`, plus
   `formatted_read_grouping_sets` for multi-dimensional aggregation.
6. `odoo_describe_environment` — kept as is. Cheap, high-value, no ORM equivalent.

**Write**

7. `odoo_save` — `web_save` / `web_save_multi`. One call creates and/or
   heterogeneously updates and reads back, in one Odoo transaction. Subsumes
   `odoo_create_records` and `odoo_update_records` and removes the documented
   heterogeneous-update limitation. The read-back `specification` eliminates the
   follow-up read.
8. `odoo_prepare` — `onchange`. Returns Odoo-computed defaults, derived values,
   warnings, and domains for a would-be record. The reliability keystone: the
   agent stops guessing which fields Odoo derives. Replaces the bespoke
   `*_configure_draft_*` family.
9. `odoo_remove` — `mode: "archive" | "delete"`. Archive by default; `delete`
   remains advanced-tier and irreversible. Merges `odoo_archive_records` and
   `odoo_delete_records`.

**Collaboration**

10. `odoo_post_message` — kept. HTML escaping and subtype handling are real
    value that the raw method does not provide. `odoo_set_self_following` folds
    in as an optional flag.

**Authorization**

11. `odoo_check_access` — `has_access` and `has_field_access` for a model,
    operation, and field set. Turns "find out when it fails" into a cheap
    answer, and makes multi-company and ACL boundaries legible before a write.

**Escape hatch**

12. `odoo_call_method` — kept, but **split read from write** using the
    `/doc-bearer` `api: [..., "readonly"]` metadata that §2.4 shows is already
    fetched and discarded. A `readonly` method is executed under the read
    contract: retries permitted, `readOnlyHint: true`, no reconciliation
    envelope. Everything else keeps today's one-attempt / `outcome: unknown`
    contract unchanged. This is a strict safety and honesty improvement.

### What stays a business action

Only operations that are genuinely one Odoo transaction spanning dependent
writes, or that are not ORM operations at all:

- `documents_create_download_url` / `documents_revoke_download_url` — issue and
  revoke a bearer capability. Security-critical, not ORM.
- `documents_get_content` — bounded text extraction. Not ORM.
- `odoo_submit_feedback` — privileged path into a fixed inbox for agents with no
  Project access. Not ORM.
- Expense and vendor-bill lifecycle transitions — **only** where the MCP asserts
  a pre- or post-condition Odoo does not. Where it does not, these are already
  `odoo_call_method` on a public method underneath, and should say so.

### What becomes a recipe instead of a tool

Every `*_get_context`, `*_get_overview`, `documents_search`,
`documents_find_similar`, `home_get_attention`, and `b2c_get_order_context`
becomes a **`specification` recipe** shipped as an MCP resource or in the server
instructions — not a registered tool.

Same round-trip count (one, via `web_search_read`, versus today's three or
four), zero schema tokens, and editable without a deployment. A recipe that
turns out to be wrong is a text change, not a release.

### Reliability fixes, independent of consolidation

| | Fix | Addresses |
| --- | --- | --- |
| R1 | Recursive typed domain schema: leaf triples plus `&` / `\|` / `!`, enumerated operators. Keep the size bounds. | §2.5 |
| R2 | Named x2many commands — `{link, create, set, unlink, delete, update}` lowered to `(4,id)` / `(0,0,v)` / `(6,0,ids)` / `(3,id)` / `(2,id)` / `(1,id,v)`. Raw tuples still accepted. | §2.5 |
| R3 | Promote `company_ids` → `allowed_company_ids`, `lang`, `tz`, `active_test` to named typed parameters. Free-form `context` kept for the long tail. | §2.5 |
| R4 | Keyset pagination on `id` when the order permits; offset only as a warned fallback. | §2.6 |
| R5 | Drop `_ref` injection. Return the public origin once in `meta`. | §2.8 |
| R6 | Preserve per-method `api` metadata through `discoverSurfaceStrict`. | §2.4 |
| R7 | Project `inspect_model` output; never return `depends`, raw `domain`, `manual`, `exportable`, `change_default` unless asked. | §2.3 |

### Registry simplification

| | Change |
| --- | --- |
| S1 | Collapse six visibility axes to `tags: string[]` + `tier: "core" \| "extended" \| "advanced"`. A profile becomes `{tags, maxTier}`. `layer` becomes descriptive or is dropped. |
| S2 | Delete `recommendFallback`, the stopword list, the singulariser, and the scoring function (~150 lines). With twelve tools there is nothing to route. `odoo_search_capabilities` disappears with them. |
| S3 | Profiles reduce to `/mcp` and `/mcp/read-only`. Thematic profiles exist only because the surface was too large; at twelve tools they are pure complexity — `ProfileName`, per-profile handler caches, budget tests, and the whole deferred-loading compatibility section of `tool-catalogue.md`. |
| S4 | `requiredModules` / `requiredPublicMethods` / `requiredModelAccess` / `requiredFeatures` and the `CapabilityAvailability` machinery largely evaporate with the domain tools. Generic tools are available whenever Odoo is; Odoo decides access per call, which the invariants already declare authoritative. `agent_access_cache.ts` (563 lines) shrinks to identity plus environment. |

Note that S4 does not weaken anything: `AGENTS.md` already states that
"profiles and `defer_loading` metadata are visibility controls only" and that
Odoo's ACLs are the authority. Availability gating was context optimisation for
a catalogue that no longer exists.

### Expected outcome

| | Now | Proposed |
| --- | ---: | ---: |
| Registered tools | 50 | ~12–16 |
| `src/capabilities/` lines | 3,090 | ~900 (est.) |
| Default-profile schema tokens | 14,988 | ~5,000 (est.) |
| Relational read depth | 1 hop, 10 relations | arbitrary |
| Heterogeneous batch write | unsupported | `web_save_multi` |
| Odoo-derived field values | reimplemented per tool | `onchange` |
| Label → id resolution | agent-guessed domain | `name_search` |
| Preflight authorization | none | `has_access` |
| Advanced ORM reads | annotated destructive, no retry | correct read contract |

### Costs, honestly

- **A second clean API break.** Existing clients need a migration document and a
  deprecation window with both surfaces registered.
- **Longer agent prompts** where a hand-tuned context bundle used to do the
  thinking. Mitigated by shipping recipes as resources and by one
  `web_search_read` replacing three calls.
- **The 60-task evaluation corpus needs re-baselining.** Per `refactor-spec.md`'s
  own acceptance criteria, that is the gate: within two points of the large
  static catalogue on overall, cross-domain, and held-out correctness, and no
  regression in unrequested consequential actions.
- **`onchange` and `web_save` are web-client methods.** They are public over
  JSON-2 and were verified live here, but the Distribution should confirm it
  intends them as a supported integration surface before they become load-bearing.

## 4. Suggested sequencing

Each step is independently reversible and independently valuable. Steps 1–3
are worth doing whether or not the consolidation is accepted.

1. **R6 + escape-hatch split** — preserve `api` metadata, classify readonly
   methods correctly. Small, strictly a safety fix, unlocks ORM reads today.
2. **R7 — project `inspect_model`.** Makes the tool usable on `account.move`.
3. **R1 + R2 + R3 — typed domains, commands, and context.** Pure reliability;
   no contract removal.
4. **Add `odoo_search` (`web_search_read`), `odoo_prepare` (`onchange`),
   `odoo_resolve` (`name_search`), `odoo_check_access`** alongside the existing
   tools. Re-run the corpus. This is the point where the thesis is proved or
   disproved on evidence.
5. **Add `odoo_save` (`web_save` / `web_save_multi`)**; deprecate
   `odoo_create_records` / `odoo_update_records`.
6. **Convert the `*_get_context` family to recipes**, one domain at a time,
   measuring the corpus after each.
7. **S1–S4 — collapse the registry and the profiles** once the catalogue is
   small enough that they carry no weight.

## 5. Verification method

Findings in §2 were established by:

- reading the registry at `e9a7652` and computing profile budgets from the built
  artefact;
- calling `res.partner.web_search_read`, `res.partner.name_search`,
  `account.move.onchange`, and `account.move.has_access` live over `/json/2`;
- reading `/doc-bearer` method signatures for `res.partner`, including the
  `api: ["model", "readonly"]` annotations;
- measuring `odoo_describe_model` response sizes for `res.partner` (methods) and
  `account.move` (fields).

No claim above rests on documentation alone.
