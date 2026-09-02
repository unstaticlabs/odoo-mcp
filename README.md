# USL Odoo MCP

One agent-facing MCP for the self-hosted USL Odoo Distribution. It runs as a Node 24 service beside Odoo and maps stable MCP contracts onto Odoo 19 JSON-2 and purpose-built Distribution methods.

The interface deliberately combines:

- five always-loaded discovery and read primitives;
- a broad generic Odoo substrate for cross-domain and unanticipated work;
- deferred semantic context tools and fixed-intent business actions;
- thematic profiles generated from one capability registry;
- Odoo-authoritative permissions, record rules, company scope, and transactions.
- a governed autonomous Agent identity for every connection.

Tool visibility is context optimization, not authorization. `odoo_call_method` remains available in the `advanced` and `all` profiles as a one-shot escape hatch for any Odoo-public JSON-2 method.

Documents remain metadata/text-only until an agent explicitly invokes the
deferred `documents_create_download_url` action. Odoo then issues a revocable,
short-lived URL for one exact version; ordinary searches and reads never create
bearer capabilities.

## Runtime

- Node 24, Express 5, MCP TypeScript SDK 2.0.
- Streamable HTTP at `/mcp` and `/mcp/:profile`.
- `stdio` for local Codex and Claude clients.
- `/healthz` for process health and `/readyz` for registry, OAuth, and analytics status.
- JSON-2 calls to `/json/2/{model}/{method}` and API discovery through authenticated `/doc-bearer`.
- Stateless MCP requests; no application-level MCP session store.
- Optional, fail-open, privacy-filtered PostHog MCP Analytics.

The default surface currently contains 19 tools and remains below the 15,000 estimated schema-token budget. Dynamic clients should use `/mcp/all`; only these tools are marked for immediate loading:

1. `odoo_search_capabilities`
2. `odoo_search_models`
3. `odoo_describe_model`
4. `odoo_search_records`
5. `odoo_read_records`

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
npm run eval:validate
npm run test:integration
docker build -t usl-odoo-mcp .
```

`test:integration` skips unless `ODOO_INTEGRATION_ORIGIN`, `ODOO_INTEGRATION_DATABASE`, and `ODOO_INTEGRATION_API_KEY` are supplied. Mutating fixture tests and pinned Codex/Claude evaluation runs are release gates, not part of the default local test command.

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
- [Authoritative refactor specification](docs/refactor-spec.md)
- [Fulfilled usage-analytics workstream](docs/issues/mcp-usage-analytics.md)
