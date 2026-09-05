# Tool catalogue and profiles

The executable source of truth is the canonical registry created in `src/capabilities/index.ts`. This document describes selection policy; tool schemas and module predicates come from code.

## Universal core

The five preferred discovery and read tools are:

| Tool | Selection rule |
| --- | --- |
| `odoo_search_capabilities` | Find semantic helpers or actions by intent across several toolsets. |
| `odoo_search_models` | Find accessible technical models from authenticated API metadata. |
| `odoo_describe_model` | Inspect fields and public method signatures before guessing. |
| `odoo_search_records` | Perform bounded cross-domain or long-tail search. |
| `odoo_read_records` | Read selected fields from known record IDs. |

Further generic substrate tools are available in every writable profile:

- `odoo_expand_record`, `odoo_aggregate_records`, and `odoo_describe_environment`;
- `odoo_create_records`, `odoo_update_records`, `odoo_archive_records`, `odoo_post_message`, and `odoo_call_method`.

`odoo_submit_feedback` is also present in every writable MCP profile. It lets any active governed Agent create one structured, low-trust report in the configured MCP development Inbox, even when that Agent has no Project application access. The Odoo method fixes and validates the destination, escapes all submitted text, and creates the task plus its audit marker in one transaction. The explicit `/mcp/read-only` transport profile hides it because that profile contains no mutations.

The only advanced-only generic tool is `odoo_delete_records`.

Use `odoo_call_method` when a legitimate public Distribution method has no MCP shortcut or when preserving a model's versatile public API is more useful than adding a thin wrapper. Prefer a fixed-intent action when it reduces ambiguity, returns better context, or guarantees a multi-step invariant. The method tool receives one attempt and may report unknown completion.

## Semantic catalogue

Current context helpers cover partners, record activities, project tasks, invoices, individual expenses, expense batches, Home attention, B2C orders, the rebuilt Accounting overview/reports, and the USL document archive. They return bounded high-signal context and warnings when optional linked context cannot be read.

Document tools use the Distribution archive facade for search, context, bounded text, similarity, and catalogues. Link/unlink operations call one public archive method. `documents_create_download_url` is a deferred consequential action that explicitly materializes one exact authorized document version as a 30–900 second HTTPS bearer URL; `documents_revoke_download_url` ends that capability early. Search and read tools report binary availability but never create or return bearer URLs.

Thin domain list/get wrappers are intentionally absent where generic search/read already communicates the task cleanly.

## Business actions

Current actions cover:

- project task creation and small task attachments;
- cross-domain activity scheduling;
- draft expense/vendor-bill preparation and individual expense transitions;
- expense-batch context application and submit/approve/post transitions;
- document link/unlink;
- explicit short-lived document materialization and revocation;
- draft incoming vendor-receipt creation with a no-call dry run.
- structured Agent feedback submission to the governed MCP development Inbox.

Actions do not bypass Odoo state or permissions. The agent should read the relevant context immediately before consequential operations. Mutation failures are not automatically replayed.

## Profiles

| URL | Intended visible surface |
| --- | --- |
| `/mcp` | Static broad default for general agents; maximum 23 tools/15k estimated schema tokens. |
| `/mcp/all` | Complete catalogue with deferred-loading metadata. |
| `/mcp/read-only` | Every read capability currently available. |
| `/mcp/accounting` | Universal core plus accounting, expenses, and related document actions. |
| `/mcp/projects` | Universal core plus project and related capabilities. |
| `/mcp/documents` | Universal core plus archive and related capabilities. |
| `/mcp/b2c` | Universal core plus B2C context. |
| `/mcp/advanced` | Default plus permanent deletion. |

Clients should use `/mcp` or a fitting profile. These named profiles omit `_meta.defer_loading` so hosted clients receive every listed schema as a static callable surface. `/mcp/all` is available only when a client deliberately wants the complete catalogue and emits per-tool deferred-loading hints. Those hints do not make a schema callable unless the client actually loads that tool definition.

### Progressive-discovery client compatibility

Progressive discovery is a host capability, not an MCP server-side profile switch. Use `/mcp/all` only with a host that searches and materializes MCP tool definitions itself:

- OpenAI Responses API agents support tool search with GPT-5.4 and later when the request includes `tool_search` and marks the hosted MCP server `defer_loading: true`. OpenAI documents deferral on the Responses API MCP-server tool definition, not automatic interpretation of arbitrary per-tool MCP result metadata.
- Claude Code and the Claude Agent SDK enable MCP tool search by default with Sonnet 4+ and Opus 4+; Haiku does not support it. Their host defers and materializes registered MCP tools.
- GitHub Copilot CLI enables on-demand tool loading on supported Claude and GPT-5.4+ models when its tool-count threshold is reached. Its `deferTools` setting is host configuration.

Hosted ChatGPT plugin connections are not documented as providing that host-controlled materialization flow, and production testing currently shows catalogue discovery without callable-schema materialization. Keep those connections on the static `/mcp` endpoint.

References: [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), [Claude Code MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search), and [GitHub Copilot CLI tool search](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/tool-search).

Module, public-method, model-access, and feature predicates remove specialized tools from `tools/list` unless positive availability is known. Capability search evaluates the complete canonical catalogue: it omits entries proven unavailable, retains unknown candidates, and returns `availability`, `visible_in_current_profile`, and `callable_now`. On writable profiles its optional fallback prefers a matching callable tool, then `odoo_call_method`; on `read-only` it always recommends generic record search and never method invocation. Search metadata is advisory and never activates a tool, changes a profile, or alters `tools/list`.

## Contract conventions

- Tool names are stable snake_case actions; capability IDs are stable dotted identifiers.
- Schemas are strict and bounded. Unknown input keys fail validation.
- Results use structured MCP output plus concise text compatibility.
- Record references use `{model,id,display_name,url}` and the public Odoo origin.
- Read/write/consequential/irreversible effects and MCP annotations describe behavior; they do not authorize it.
- Search and read calls select fields and bound result counts instead of dumping arbitrary records.
- Context reserves only connector origin and correlation metadata; caller-supplied reserved `usl_*` values are removed.
