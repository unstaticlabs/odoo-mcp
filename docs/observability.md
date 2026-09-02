# MCP observability

Production analytics is optional and disabled by default. When enabled, the
runtime instruments each registry-generated server with pinned
`@posthog/mcp@0.12.0` and sends privacy-filtered operational events through one
process-wide PostHog client. The implementation is isolated in
`src/runtime/observability.ts` so the sink can be upgraded or replaced without
changing capability contracts.

Analytics is strictly fail-open. Configuration, filtering, instrumentation,
capture, network, and shutdown failures do not fail an MCP request. A bad
configuration reports `analytics: degraded` from `/readyz`, while the overall
readiness result remains governed by the registry and OAuth vault. Shutdown
flushes PostHog for at most two seconds.

Instrumentation does not alter the interface being measured. Context/intent
parameters, conversation IDs, model self-reporting, missing-capability reports,
exception autocapture, and analytics-specific tools are all disabled. Enabled
and disabled servers advertise byte-equivalent tool names, schemas,
annotations, and metadata.

## Configure production

Set `MCP_ANALYTICS_ENABLED=true` and provide every value below:

| Variable | Requirement |
|---|---|
| `POSTHOG_API_KEY` or `POSTHOG_API_KEY_FILE` | PostHog project ingestion key. Prefer a mounted secret file. |
| `POSTHOG_HOST` | Explicit HTTPS ingestion origin for the project's chosen residency. Paths, credentials, query strings, and fragments are rejected. |
| `MCP_ANALYTICS_PSEUDONYMIZATION_KEY` or `MCP_ANALYTICS_PSEUDONYMIZATION_KEY_FILE` | Exactly 32 random bytes encoded as canonical Base64. Keep this separate from every application and PostHog key. |
| `MCP_DEPLOYMENT_ID` | Stable low-cardinality deployment label, such as `usl-prod-vps-1`. |
| `MCP_BUILD_ID` | Immutable revision, normally the Git SHA or image digest. |
| `MCP_ENVIRONMENT` | Optional low-cardinality environment label; defaults to `development`. |

Generate the pseudonymization key once and store its output in the mounted
secret file:

```bash
openssl rand -base64 32
```

A Compose deployment can add the following environment entries and mount the
two referenced files as secrets:

```yaml
environment:
  MCP_ANALYTICS_ENABLED: "true"
  MCP_ENVIRONMENT: production
  POSTHOG_API_KEY_FILE: /run/secrets/posthog_api_key
  POSTHOG_HOST: https://eu.i.posthog.com
  MCP_ANALYTICS_PSEUDONYMIZATION_KEY_FILE: /run/secrets/analytics_pseudonymization_key
  MCP_DEPLOYMENT_ID: usl-prod-vps-1
  MCP_BUILD_ID: <immutable-git-sha-or-image-digest>
```

Do not rotate this key as part of routine PostHog-key rotation. Rotating either
an Odoo API key or the pseudonymization key intentionally creates a new
pseudonymous principal. The digest cannot be joined across rotations without
outside identity data.

Before enabling export, the deployment owner must select and document the
PostHog project/region, retention period, deletion process, and least-privilege
project membership. Treat the project as sensitive operational metadata even
though business content is excluded. PostHog MCP Analytics is a beta surface
and its SDK is a `0.x` release, which is why this repository pins its version.
Use the built-in [MCP Analytics views](https://posthog.com/docs/mcp-analytics)
instead of creating a parallel analytics stack.

After deployment, verify:

1. `/readyz` reports `analytics: ready`.
2. A test `tools/list` and harmless read produce `$mcp_tools_list`,
   `$mcp_tool_call`, `usl_mcp_tool_completed`, and
   `usl_odoo_call_completed` events.
3. Tool arguments/results and the three Odoo credential headers are absent
   from the captured event JSON.
4. `usl_build_id`, `usl_deployment_id`, `usl_profile`, and the stable
   capability metadata are populated.

`analytics: ready` confirms valid local configuration and client
initialization; asynchronous PostHog endpoint reachability is not a readiness
dependency. Alert on missing events separately without restarting or removing
the MCP from service.

Set `MCP_ANALYTICS_ENABLED=false` and restart to stop remote export. Existing
content-free stderr events remain available.

## Captured data

The official integration supplies MCP lifecycle events, including
`$mcp_initialize`, `$mcp_tools_list`, and one `$mcp_tool_call` per completed
call. The local completion hooks add exact serialized byte counts and Odoo
attempt information without duplicating start events remotely.

The built-in per-tool usage, client, latency, response-size, and failure views
are the primary operational surface. Intent clustering, missing-capability,
model, and synthetic conversation views will be absent or incomplete by
design, because enabling their collection would change agent behavior or
collect unneeded content.

Captured properties are limited to:

- stable capability ID and tool name, generic/semantic/business layer, effect,
  and toolsets;
- success or normalized low-cardinality error/status class;
- tool, MCP request, and Odoo-attempt duration;
- serialized argument/result byte counts only;
- Odoo attempt number, whether it is a retry, whether another retry will occur,
  and response byte count;
- profile, environment, deployment ID, server version, and build ID;
- negotiated protocol and bounded client name/version where the client supplies
  them, plus a normalized Codex/Claude/ChatGPT/other family;
- HMAC-SHA-256 pseudonymous credential principal;
- request and correlation IDs; and
- validated W3C trace ID, parent span ID, and sampling bit.

Person profiles and geolocation enrichment are disabled. The explicit
`beforeSend` allowlist drops every unrecognized event/property, `$identify`,
and `$exception`.

Never exported:

- tool arguments or results, prompts, intents, tool descriptions, model
  self-reports, business record/document contents or IDs, domains, field
  values, model names, or method names;
- Odoo/Paperless URLs, database names, API keys, OAuth/session credentials, or
  document materialization grants;
- raw user-agent or vendor headers, baggage, tracestate, exception messages, or
  stacks; or
- PostHog person profiles or location data.

The runtime may serialize arguments/results locally to compute their byte
length, but only the integer length can enter an event. The existing local
stderr events remain content-free; they are not automatically shipped by this
module.

## Traces and sequences

HTTP requests accept validated W3C `traceparent`, `tracestate`, and `baggage`.
For stdio, the same fields may arrive in MCP request `_meta`. HTTP context wins
when both exist. The validated context is propagated to Odoo JSON-2 and API
documentation requests. PostHog receives only trace/span IDs and the sampling
bit—never raw tracestate or baggage. Clients must not put secrets in tracing
headers even though PostHog drops their raw values.

Tool sequences are exact when calls share a valid W3C trace or a legacy MCP
session. Current sessionless protocol traffic does not receive an invented
conversation identifier. Without either correlation source, sequence analysis
is only an approximation over pseudonymous principal, client, and a bounded
time window.

Native agent telemetry complements this server view:

- [Codex OpenTelemetry logs](https://openai.com/index/running-codex-safely/)
  can report agent-side MCP usage and the surrounding run.
- [Claude Code OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage)
  can report session, model/API latency, tool events, token, and cost metrics;
  its trace exporter is currently documented as beta.

Send those signals to the organization's existing OTLP destination, not to a
new platform created by this repository. Keep user-prompt, tool-detail, and
tool-content export disabled. Where an agent propagates the same W3C trace into
MCP calls, the client and server sides can be joined without a custom tracing
protocol.

## Interpretation limits

Server telemetry can measure volume, failures, retries, latency, payload sizes,
client/profile/build differences, and generic versus specialized usage. It
cannot reliably determine task correctness, a wrong or unnecessary successful
tool choice, failure to discover an existing tool, total model tokens, or
competence on requests the MCP developer did not anticipate. Those questions
remain owned by the versioned agent-evaluation corpus in `docs/evaluation.md`.
