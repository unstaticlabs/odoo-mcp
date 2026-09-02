# Breaking migration guide

This release is a clean break from the previous hosted runtime and Odoo Online-shaped interfaces. Existing clients must reconnect and refresh tool schemas.

## Deployment changes

- Deploy the Node 26 container beside the self-hosted Distribution.
- Replace the previous hosted endpoint with `/mcp` or `/mcp/:profile` on the VPS reverse-proxy origin.
- Configure public-to-private Odoo target mappings.
- Replace previous grant storage with the mounted Better Auth SQLite vault. Old grants are not imported; hosted clients enroll once.
- Direct clients replace the old bearer/key arrangement with `X-Odoo-Url`, `X-Odoo-Database`, and `X-Odoo-Api-Key` together.
- Local clients use the stdio entrypoint and environment credentials.
- Replace every human Odoo key with a governed Agent credential created in **My Agents**. Hosted OAuth authorization remains human, but Odoo execution and attribution belong to the Agent.

## Tool migration

The most common mappings are:

| Previous contract family | New contract |
| --- | --- |
| model listing/discovery variants | `odoo_search_models` |
| fields/API/actions variants | `odoo_describe_model` |
| search/compact/browse/count variants | `odoo_search_records` |
| single/batch read variants | `odoo_read_records` |
| relational expansion and aggregation | `odoo_expand_record`, `odoo_aggregate_records` |
| database description | `odoo_describe_environment` |
| create/update variants | `odoo_create_records`, `odoo_update_records` |
| deletion | default `odoo_archive_records`; advanced `odoo_delete_records` |
| chatter message variants | `odoo_post_message` |
| arbitrary model method | `odoo_call_method` in `advanced`/`all` |
| thin project list/get wrappers | generic search/read or `projects_get_task_context` |
| legacy document model access | `documents_*` capabilities backed by `usl.document` |
| expense/batch workflow chains | fixed-intent `expenses_*` and `expense_batches_*` actions |
| legacy accounting report wrappers | rebuilt `accounting_*` context/report capabilities |

Old offset pagination, heterogeneous batch writes, duplicated server-specific tool names, UI button scraping as the primary method catalogue, feedback submission, and multi-call claims of atomicity are not supported.

## Behavior changes

- All input objects are strict and bounded; unknown fields are rejected.
- Outputs use structured envelopes and canonical `{model,id,display_name,url}` references.
- Cursor-oriented searches replace offset variants.
- Direct mutations receive one attempt. There is no generic replay key or deployed transaction-replay service.
- An ambiguous mutation transport failure returns unknown completion and requires Odoo reconciliation.
- The unrestricted public-method escape hatch is preserved but renamed, deferred, and truthfully annotated as potentially destructive/non-idempotent.
- Specialized capabilities disappear when the owning Distribution module is definitively absent; generic discovery/read remains.
- The document archive contract is the Distribution facade rather than an Enterprise application model.
- `odoo_describe_environment` now reports the Agent, accountable owner, credential expiry and effective companies. Human keys, suspended Agents and expired Agent credentials fail before tools are exposed.

## Client profile choice

- General static agents: `/mcp`.
- Native tool-search/deferred clients: `/mcp/all`.
- Specialized static agents: a thematic profile URL.
- Public-method or permanent-delete workflows: `/mcp/advanced` or dynamic retrieval from `/mcp/all`.

Do not use a narrower profile as a permission boundary. Preserve the intended Odoo identity and company access independently.

## Rollback

Keep the last pre-migration service/image available until direct, stdio, and hosted connections are qualified. Runtime rollback is a reverse-proxy/image change. Restore the pre-migration SQLite backup only when rolling back an OAuth schema change, and use its matching secrets.

Any additive Odoo public application-service methods landed for atomic actions can remain deployed during MCP rollback. Never roll back by deleting Odoo data or by replaying an operation with unknown completion.
