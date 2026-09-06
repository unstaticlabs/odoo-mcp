# USL Odoo MCP

One agent-facing MCP for the self-hosted USL Odoo Distribution. It runs as a Node 26 service beside Odoo and maps stable MCP contracts onto Odoo 19 JSON-2 and purpose-built Distribution methods.

The interface deliberately combines:

- a generic Odoo substrate for cross-domain and unanticipated work, built on Odoo's own read specification, typed domains, and keyset paging;
- statically callable everyday workflow tools on `/mcp`, with deferred discovery on `/mcp/all`;
- thematic profiles generated from one capability registry;
- Odoo-authoritative permissions, record rules, company scope, and transactions;
- a governed autonomous Agent identity for every connection.

Tool visibility is context optimization, not authorization. `odoo_call_method` is a statically advertised, one-shot escape hatch on writable named profiles, deferred only on `/mcp/all`; Odoo remains the authority for public-method dispatch and access.

Documents remain metadata/text-only until an agent explicitly invokes
`documents_create_download_url`. Odoo then issues a revocable,
short-lived URL for one exact version; ordinary searches and reads never create
bearer capabilities.

## Runtime

- Node 26, Express 5, MCP TypeScript SDK 2.0.
- Streamable HTTP at `/mcp` and `/mcp/:profile`.
- `stdio` for local Codex and Claude clients.
- `/healthz` for process health and `/readyz` for registry, OAuth, and analytics status.
- JSON-2 calls to `/json/2/{model}/{method}` and API discovery through authenticated `/doc-bearer`.
- Stateless MCP requests; no application-level MCP session store.
- Optional, fail-open, privacy-filtered PostHog MCP Analytics.

`/mcp` advertises a bounded static surface that `/readyz` enforces; the current
tool count, schema-token budget, and profile contents live in one place, the
[tool catalogue](docs/tool-catalogue.md). Everyday document, project, activity,
Chatter, feedback and draft-accounting workflows do not require a profile switch.
Only `/mcp/all` uses deferred-loading hints.

## Quick start

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

Configure at least one allowed Odoo target. A single target can use `ODOO_PUBLIC_ORIGIN`, `ODOO_INTERNAL_ORIGIN`, and `ODOO_DATABASE`; multiple targets use `ODOO_TARGETS_JSON`.

Direct HTTP clients send all three headers:

```text
X-Odoo-Url: https://odoo.example.com
X-Odoo-Database: production
X-Odoo-Api-Key: <odoo-api-key>
```

The key must belong to an active Agent created in Odoo **My Agents**. Human API
keys are rejected. The Agent remains the Odoo actor while the Agent's owner is
the accountable human and the upper bound on delegated authority.

The URL/database pair must match configured targets. The MCP maps the public URL to the private VPS/Compose origin and never forwards the credential through redirects. `Authorization` is reserved for MCP OAuth bearer tokens.

For stdio, set `ODOO_URL`, `ODOO_DATABASE`, and `ODOO_API_KEY`, then configure the client command as:

```text
node /absolute/path/to/odoo-mcp/dist/stdio.js
```

## Verification

```bash
npm run check
```

That is the default gate: typecheck, the unit/protocol suite, and a production
build. [Testing](docs/testing.md) covers the evaluation-corpus check, the
container build, the opt-in live smoke suite, and the release gates.

## Documentation

- [Contributing and Git workflow](CONTRIBUTING.md)
- [Architecture](docs/architecture.md)
- [Authentication and credential operations](docs/authentication.md)
- [Tool catalogue and profiles](docs/tool-catalogue.md)
- [VPS deployment and rollback](docs/deployment.md)
- [MCP observability and privacy](docs/observability.md)
- [Testing](docs/testing.md)
- [Agent-interface evaluation](docs/evaluation.md)
- [Breaking migration guide](docs/migration.md)
- [Architecture decisions](docs/refactor-spec.md)
- [ORM-first redesign (proposal and progress)](docs/orm-first-redesign.md)
