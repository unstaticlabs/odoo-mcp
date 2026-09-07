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

Model access for `account.return`, `stock.valuation.layer`,
`project.project.stage_id` and the `rebuild.*` models is granted in the Odoo
Distribution, not here: those calls failed correctly, with
`agent_read_only_action_denied`. Confirm what an identity actually holds with
`odoo_describe_environment`, which reports `effective_applications` and
`effective_company_ids`.
