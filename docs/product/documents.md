# Documents MCP

`/documents/mcp` is the focused read-only connector for the USL Odoo
Distribution's governed Odoo–Paperless archive. The full `/mcp` surface
registers the same nine tools. Accounting and Projects endpoints do not.

## Authorization boundary

The Worker calls only explicit `usl.document.mcp_*` Odoo JSON-2 methods with
the connected user's Odoo credentials. It never accepts, stores, or forwards a
Paperless API token. Odoo applies current record rules, allowed companies,
linked-record access, archive availability, and synchronized binary permission
before it calls Paperless. Missing, guessed, and inaccessible document IDs use
the same denial.

Search returns excerpts of at most 500 characters. More OCR requires an
explicit `documents.get_content` call and pages of at most 8,000 characters.
An external MCP client or its model provider receives the excerpts returned by
these tools; users must connect only approved clients and minimize content
retrieval.

## Qualified foundation

- source commit: `6cfe40b6ea42a0a34819c0c6fb74d5f455deca67`;
- `SERVER_VERSION`: `0.21.0`;
- compiled Wrangler `index.js` SHA-256:
  `d3cae37a1b9c3616e900c2e29b1f39e4cde65c3f0e523a561c25780d569c09f3`;
- Durable Object migration: `v3`, adding `DocumentsAgent`;
- endpoint composition: exactly nine `documents.*` tools on
  `/documents/mcp`, the same nine on `/mcp`, none on the other focused
  endpoints.

The complete gate passed TypeScript typecheck, 1,206 tests across 29 files
with 4,914 assertions, and Wrangler deploy dry-run. Two consecutive dry runs
produced the same compiled Worker digest.
Local readiness reached both MCP endpoints and received the expected
authenticated HTTP 401 from an unauthenticated POST.

Real MCP Inspector acceptance used a short-lived API key for the existing QA
Documents user. It listed exactly the nine tools, completed governed hybrid
search, bounded content, similar-document, version, catalog, and link calls,
then removed the temporary key. Odoo tests cover restricted users,
multi-company isolation, guessed IDs, output bounds, unsynchronized archive
permissions, and Paperless/Ollama degradation.

## Capacity and client refresh

The queue serializes calls per Odoo origin at roughly one request per second.
Search returns at most 25 records inside a window of 50. OCR is paginated.
Paperless semantic scopes are chunked behind Odoo without an unscoped service
query. Track Worker/Durable Object requests, Odoo calls, Paperless latency, and
local Ollama latency separately; do not raise concurrency to mask retry or
permission defects.

After every tool-surface change, bump `SERVER_VERSION`, deploy, and refresh or
reconnect each client so it discards its cached tool list.

## Deploy and rollback

Deployment requires a clean checkout at the qualified commit, passing full
tests, and a matching Wrangler dry-run digest. Wrangler applies the
`DocumentsAgent` migration; deploy to the intended Cloudflare account and KV
namespace, then repeat readiness, tools/list, one authorized search, and one
restricted-user negative probe on the HTTPS endpoint.

Rollback only the Worker when the failure is Worker-only: deploy the preceding
qualified MCP commit and artifact to the same Cloudflare environment, preserve
the `DocumentsAgent` Durable Object class/storage and OAuth KV, repeat endpoint
composition checks, and refresh clients. Never delete grants or Durable Object
storage as a rollback shortcut. If the Odoo facade contract also changed
incompatibly, roll back the complete coordinated release cohort using the USL
Odoo backup/recovery runbook.
