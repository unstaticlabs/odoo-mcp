# Follow-up: privacy-preserving MCP usage analytics

## Summary

Implement production analytics for the USL Odoo MCP after the VPS refactor. The refactor supplies stable identifiers and content-free instrumentation hooks; this issue owns storage, retention, dashboards, and analysis. It must not be folded into the runtime refactor.

## Goals

- Measure task-facing tool discovery, selection, execution, fallback, correction, latency, and reliability.
- Join controlled evaluation runs to production-shaped events without collecting Odoo record contents, prompts, credentials, or tool results.
- Make tool/profile/version comparisons possible across Codex, Claude, and other clients.
- Support deletion, retention, access control, and deployment-specific opt-out.

## Event boundaries

- `auth.resolved`
- `mcp.request.started` and `mcp.request.completed`
- `mcp.tools.listed` and `mcp.capabilities.searched`
- `mcp.tool.started` and `mcp.tool.completed`
- `odoo.call.started` and `odoo.call.completed`
- `mcp.request.cancelled`

## Common dimensions

- Timestamp and schema version.
- Privacy-preserving request, correlation, trace, and evaluation-run identifiers.
- Stable capability ID, tool name, registry version, profile, layer, toolsets, and effect.
- Client family/version and model identifier when the client supplies them.
- Auth mode and opaque deployment target ID; never Odoo URL, database, user name, or API key.
- Result status, normalized error code, recoverability, mutation outcome, retry count, Odoo-call count, duration, and bounded byte counts.
- Discovery result count, truncation flag, and whether execution used a generic fallback.

Do not capture prompts, tool arguments, domains, record IDs, field values, record contents, returned text, stack traces containing application data, secrets, or direct personal identifiers.

## Required analysis

- Task completion and correctness when an evaluation oracle exists.
- Wrong or corrected tool selections.
- Failure to retrieve a relevant capability.
- Successful and unnecessary generic fallback.
- Unnecessary calls, total calls, latency, tool-schema tokens, and context tokens when supplied by the client.
- Cross-domain and unanticipated-request success.
- Consequential-operation refusal, approval, execution, and unknown-outcome behavior.

## Operational requirements

- Document event schema/versioning, storage owner, regional location, retention, deletion, and access policy before enabling collection.
- Default to structured local events with no remote exporter until an operator explicitly configures one.
- Provide sampling controls that never sample away failures or consequential-operation events.
- Support per-deployment disablement and deletion by opaque enrollment/principal identifier.
- Redact defensively at the event producer and again at ingestion.
- Bound cardinality and reject unrecognized free-form dimensions.

## Acceptance criteria

- A reviewed event-schema document and threat/privacy assessment exist.
- Automated tests prove forbidden payload fields and secrets are never serialized.
- Events can reconstruct tool-selection funnels and latency without Odoo content.
- Evaluation runs can be filtered independently from production events.
- Retention, deletion, access, opt-out, and incident procedures are documented and tested.
- Dashboards cover usage, tool discovery/selection, generic fallback, errors, latency, and consequential outcomes.

## Out of scope

- Replacing application audit records in Odoo.
- Recording user prompts or Odoo data for later model training.
- Adding a general product analytics stack to the MCP refactor.
- Treating telemetry as an authorization or transaction mechanism.
