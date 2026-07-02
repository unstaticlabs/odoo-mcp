# odoo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Odoo**, running on
Cloudflare Workers. It lets AI clients (Claude Code, Claude Desktop, ChatGPT, and any other
MCP client) read and write Odoo data over a single remote endpoint.

- **Transport:** Streamable HTTP at `/mcp` (via the Cloudflare Agents `McpAgent`).
- **Auth:** **bring-your-own-key (BYO-key)** — each caller supplies their *own* Odoo URL +
  API key per request, so Odoo's own per-user permissions are the authorization. The server
  is stateless; no OAuth, no shared service account, no credential storage.
- **API:** Odoo JSON-2 (`POST {url}/json/2/{model}/{method}`).

> Status: Milestone 1+ — projects read core, model/field discovery, smart field selection,
> timeout+retry, and record CRUD. Roadmap: chatter/aggregate/method tools, `odoo://` resources.

## Connection: BYO-key headers

Every request to `/mcp` must carry three headers (missing/malformed → `401`):

| Header | Value |
|---|---|
| `Authorization` | `Bearer <your-odoo-api-key>` |
| `X-Odoo-Url` | your Odoo base URL, e.g. `https://your-org.odoo.com` |
| `X-Odoo-Db` | your Odoo database name |

The server never logs, stores, or echoes your key.

## Tools

| Tool | Kind | Parameters |
|---|---|---|
| `search_records` | read | `model` (string), `domain` (array, default `[]`), `fields` (string[] \| null → smart defaults), `limit` (1–100, default 10) |
| `get_record` | read | `model` (string), `record_id` (positive int), `fields` (string[] \| null → smart defaults) |
| `list_models` | read | — |
| `get_fields` | read | `model` (string) → field name/type/label schema |
| `projects.list_tasks` | read | `domain` (array), `fields` (string[]) — convenience wrapper over `project.task` |
| `create_record` | write | `model` (string), `values` (object) |
| `update_record` | write | `model` (string), `record_id` (positive int), `values` (object; x2many use Odoo command tuples, e.g. `[[6,0,ids]]`, `[[4,id]]`, `[[3,id]]`) |
| `delete_record` | write | `model` (string), `record_id` (positive int) |

Writes are gated by *your* Odoo user's access rights and record rules (BYO-key), so a caller
can only do what their Odoo account permits.

### Field selection

For `search_records` / `get_record`, `fields`:
- omit / `null` → a smart default set of the most relevant fields,
- a string array → exactly those fields.

## Quick start

See **[docs/testing.md](docs/testing.md)** for the full local + deployed testing guide. In short:

```bash
npm ci
npx wrangler dev        # serves http://localhost:8787/mcp

# connect Claude Code to the local server:
claude mcp add --transport http odoo http://localhost:8787/mcp \
  --header "Authorization: Bearer $ODOO_API_KEY" \
  --header "X-Odoo-Url: https://your-org.odoo.com" \
  --header "X-Odoo-Db: your-db"
```

## Development

- `npm run typecheck` — `tsc --noEmit`
- `npx wrangler deploy --dry-run` — bundle check
- CI gate: `.ci.json` (install → typecheck → deploy dry-run)
- Deploy: `npx wrangler deploy`

## License

MIT (see repository).
