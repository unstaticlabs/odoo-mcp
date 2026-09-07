# Triaging a failed MCP call

Use this runbook when an agent reports that a tool call failed and it is not
obvious whether the fault is in the client, in this server, or in Odoo. It
records the failure shapes this server can produce, how to prove a call reached
it, and the worked example that motivated the contract.

## The client-visible failure surface

Every failure this server produces is structured and traceable. There are three
shapes and no others.

| Shape | Produced by | Always carries |
|---|---|---|
| Tool error envelope — `isError: true`, a JSON `error` object in the text content | `toolError` in `src/runtime/envelope.ts`, from the single `catch` in `defineCapability` | `code`, `message`, `retryable`, `outcome`, `recovery`, `request_id`, `correlation_id` |
| HTTP rejection body on `/mcp` and `/mcp/:profile` | `authenticate` in `src/http.ts`, `protectMcp` in `src/auth/oauth.ts` | `error`, `message`, `retryable`, `request_id`, `correlation_id` |
| JSON-RPC protocol error | the MCP SDK, for an unparseable request, an unknown method or an unknown tool name | the SDK's `code` and `message` |

Schema-invalid `tools/call` arguments are the case that used to escape this. The
SDK rejects them before the tool handler runs and answers with a bare string, so
the advertised input schema is now wrapped (`deferInputValidation` in
`src/capabilities/registry.ts`): validation issues travel into the handler and
leave as `MCP_INVALID_TOOL_INPUT` through the same envelope as every other
failure, with the per-argument issues in `message` and the advertised JSON
Schema unchanged.

Consequences worth relying on when triaging:

- A failure with no `code` and no `correlation_id` did not come from a tool
  handler on this server.
- A failure with an `agent_*` code came from the Odoo Distribution's Agent
  policy. It is a stable authorization decision, not a transient one.
- `retryable` is authoritative. `MCP_UPSTREAM_UNAVAILABLE` and `surface_warming`
  are the retryable failures; a policy denial and `MCP_INVALID_TOOL_INPUT` are
  not.

## Did the call reach this server?

Every runtime event is written to stderr as one JSON line — that is, into the
container log — whether or not PostHog export is configured. `emitEvent` in
`src/runtime/logging.ts` owns the schema and `docs/observability.md` owns the
export contract.

1. Take the incident window and the target.
2. Search the container log for `mcp.tool.started` and `mcp.tool.completed` with
   the tool name. `mcp.tool.completed` carries `status`, which is `ok` or the
   failure `code`.
3. If neither event exists for a call the agent says it made, the call was never
   dispatched to this server. Stop: the fault is in the client or in the network
   between them, and nothing in this repository can reproduce it.
4. If `mcp.request.started` exists without a matching `mcp.tool.*` pair, the
   request was rejected at the transport or authentication layer. `auth.resolved`
   with `status: rejected` and the same `request_id` names the reason.
5. `agent.snapshot.refresh` explains catalogue movement: `status` distinguishes
   `ok`, `partial` (identity resolved, capability surface not), `warming`, and a
   failure class, and `visibility_changed` says whether the advertised tool set
   actually moved.

When the client supplies `X-Correlation-Id`, or a valid W3C `traceparent`, the
client's own record and these events join exactly.

## Worked example: `No approval received.` (2026-09-07)

Read-only calls (`odoo_search_records`, `odoo_read_records`,
`odoo_aggregate_records`, `odoo_describe_model`) intermittently failed in one
long Claude web-chat session with the bare string `Error: No approval received.`
No approval prompt was shown, identical calls succeeded in the next turn, and
`projects_get_task_context` read the same `project.task` record without
interruption.

The calls never reached this server.

1. The string appears nowhere in this repository or in its pinned dependencies.
2. This server cannot emit an unstructured failure; see the table above.
3. The four tools declare no `requiredModules`, `requiredPublicMethods` or
   `requiredModelAccess` in `src/capabilities/generic.ts`, so `visible()` cannot
   withdraw them for any state of the Agent access snapshot — including a
   snapshot with no capability surface at all. A refresh landing mid-turn is
   therefore not an available explanation. Pinned by *keeps the generic read
   substrate advertised regardless of backend metadata* in
   `test/vps/registry.test.ts`.
4. Every read capability advertises byte-identical annotations
   (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
   `openWorldHint: true`), so no advertised difference distinguishes the generic
   reads that failed from the semantic read that succeeded. Pinned by
   *advertises one read annotation set across every read capability*.
5. `projects_get_task_context` returned task 1040 during the failing stretch. It
   uses the same credentials, ACLs and record rules, so Odoo was not denying the
   read — and an Odoo denial has a stable shape, which the same session did
   receive for `account.return.search_read` as
   `agent_read_only_action_denied` at three separate points.
6. An unrelated MCP server returned the identical string in the same session.

The failure was therefore rejected in the client's approval layer before
dispatch. It is not reproducible or fixable here; it belongs upstream with the
host, with the observation that the bare string carries no code, no retry
guidance, and nothing to correlate against a server log.

### Disposition of the reported fixes

| Requested | Disposition |
|---|---|
| Never return a bare error string | Held, and the one gap closed: schema-invalid arguments now return `MCP_INVALID_TOOL_INPUT` instead of the SDK's bare text |
| Set `retryable` and say so in `recovery` | Already held for tool errors; HTTP rejections now carry `retryable` and, where applicable, `retry_after_seconds` |
| Carry `request_id` and `correlation_id` | Already held for tool errors; now held for every HTTP rejection on the MCP endpoints |
| Surface the approval prompt, or say none could be shown | Client-side. This server neither requests nor mediates approval, and declares no elicitation capability |
| Do not require interactive approval for read-only operations | Client-side. Read capabilities already advertise `readOnlyHint: true`, uniformly |
| Document any per-turn limit | No such limit exists here. `MCP_TARGET_CONCURRENCY` bounds concurrent Odoo calls per target and queues rather than rejecting; nothing in this server counts calls per turn or per session |

## What `agent_read_only_action_denied` actually means

The message reads *"This Agent has no approved application access for
`<model>.<method>`"*, which points the owner at the Agent's application grants.
That is only one of the reasons it is raised. `_api_method_access` in the
Distribution's `usl_access_control/models/agent.py` returns `None`, and so
produces this identical message, in three unrelated cases:

1. **The `(model, method)` pair is absent from the qualified action policy.**
   `access_for` looks up `rpc:<model>.<method>` in
   `policy/agent_readonly_runtime_policy.json` and returns `None` when it is
   missing. A model that does not exist in the build has no entry at all, so
   every method on it is denied.
2. **The model has no `ir.model.access` row.** `_allows_model_operation`
   requires a matching ACL row whose group is implied by the Agent's delegated
   groups. Report and `_auto = False` models often carry no ACL row, so the
   check fails for every Agent regardless of grants.
3. **The ACL rows name groups the Agent does not hold.** This is the only case
   the message actually describes, and the only one an application grant fixes.

Verified against the live deployment on 2026-09-07 for Agent *Elio* (`usl.agent`
id 1, user 9), which holds 22 applications — all `read_write`, including
Accounting, Inventory, Bank and Settings — with `authority_reduced: false`:

| Model | Cause | Fixable by a grant? |
|---|---|---|
| `account.return` | 1 — no `ir.model` row, absent from `action_surface.json`, no `_name` in the Distribution source. Odoo 19 does not ship it | No; use `account.report` (readable — the French Tax Report is id 4) |
| `stock.valuation.layer` | 1 — same; Odoo 19 replaced it with `stock_account.stock.valuation.report` | No |
| `stock_account.stock.valuation.report` | 2 — classified `read_only` in the policy but has zero `ir.model.access` rows | No |
| `project.project.stage_id` | Neither — a field-level group (`project.group_project_stages`), not an application | No; grant the group |

Diagnosing one of these means asking, in order: does `ir.model` hold a row for
the model, does `action_surface.json` list it, does `ir.model.access` have a row
for it, and only then whether the Agent holds the naming group.
`odoo_describe_environment` reports what the identity actually holds
(`effective_applications`, `effective_company_ids`).

Two defects follow, both owned by the Distribution's `usl_access_control`:

- The message should distinguish these causes. As written it sends an owner who
  has already granted everything to re-check grants that cannot be the cause.
- `web_search_read` is classified `write` for the 766 models that carry it,
  while `search_read`, `read` and `formatted_read_group` are `read_only`. It is
  a read RPC, and it is the method `odoo_search_records` and `odoo_read_records`
  use whenever a `specification` is passed — which this server's own
  instructions recommend for relational context. A read-only Agent, or any
  model an Agent holds through `read_only_group_ids`, therefore cannot use
  `specification` at all, and a read that does succeed is scoped and audited as
  a write.
