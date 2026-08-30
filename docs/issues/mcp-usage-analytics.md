# Fulfilled: privacy-preserving MCP usage analytics

Status: fulfilled on `codex/posthog-mcp-analytics`.

The follow-up workstream from the VPS refactor is implemented by the pinned
official PostHog MCP Analytics integration and the local privacy boundary in
`src/runtime/observability.ts`. It remains optional, disabled by default,
fail-open, and does not modify any MCP tool contract or discovery behavior.

Delivered:

- built-in MCP lifecycle/tool-call events plus content-free MCP and Odoo
  completion events;
- stable capability, profile, server, deployment, build, client, request,
  correlation, and W3C trace dimensions;
- HMAC-pseudonymous credential principals, strict property/event allowlists,
  disabled person profiles/geolocation, and no arguments, results, prompts,
  exceptions, credentials, grants, or business records;
- latency, byte counts, normalized failures, attempts, retries, and generic
  versus specialized-tool classification;
- optional configuration, degraded-but-ready behavior, asynchronous capture,
  and bounded fail-open shutdown;
- contract-equivalence, privacy, failure-injection, trace, retry, HTTP/stdio,
  and protocol compatibility tests; and
- the production runbook in `docs/observability.md`.

No custom dashboard or second observability platform was added. Operators
should use PostHog's built-in MCP Analytics views and configure project
residency, retention, deletion, and access control before enabling collection.

Task correctness, wrong or unnecessary successful selections, missed tool
discovery, model/token usage, and performance on held-out unanticipated tasks
are not inferable from MCP-side telemetry alone. They remain owned by the agent
evaluation system. Native Codex and Claude Code OpenTelemetry may complement
the MCP events for whole-run signals; content-bearing exporter options must
remain disabled.
