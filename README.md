# odoo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Odoo**, running on
Cloudflare Workers. It lets AI clients (Claude Code, Claude Desktop, ChatGPT, and any other
MCP client) read and write Odoo data over a single remote endpoint.

- **Transport:** Streamable HTTP at `/mcp` (via the Cloudflare Agents `McpAgent`).
- **Auth:** **bring-your-own-key (BYO-key)** — each caller supplies their *own* Odoo URL +
  API key, so Odoo's own per-user permissions are the authorization. Clients that can set
  static headers (Claude Code, Claude Desktop) send them per request; ChatGPT connects via a
  built-in **OAuth shim** that collects the same credentials once and stores them encrypted
  (see [docs/product/auth.md](docs/product/auth.md)). No shared service account, no scopes
  model.
- **API:** Odoo JSON-2 (`POST {url}/json/2/{model}/{method}`).

> Status: Milestone 1+ — projects read core, model/field discovery, smart field selection,
> timeout+retry, record CRUD, and `odoo://` resources.

## Connection: BYO-key headers

For clients that can set static headers, every request to `/mcp` carries three headers
(missing/malformed → `401`). Requests without any `X-Odoo-*` header are treated as OAuth
(see [Connect ChatGPT](#connect-chatgpt-oauth) below).

| Header | Value |
|---|---|
| `Authorization` | `Bearer <your-odoo-api-key>` |
| `X-Odoo-Url` | your Odoo base URL, e.g. `https://your-org.odoo.com` |
| `X-Odoo-Db` | your Odoo database name |

The server never logs, stores, or echoes your key.

## Tools

| Tool | Kind | Parameters |
|---|---|---|
| `search_records` | read | `model` (string), `domain` (array, default `[]`), `fields` (string[] \| null → smart defaults), `limit` (1–100, default 10), `order` (string, optional, e.g. `"name desc"`), `offset` (int ≥ 0, default 0) |
| `search_count` | read | `model` (string), `domain` (array, default `[]`) → `{ count }` via `search_count`, without fetching records |
| `get_record` | read | `model` (string), `record_id` (positive int), `fields` (string[] \| null → smart defaults) |
| `batch_read` | read | `model` (string), `ids` (positive int[], min 1, capped at 100), `fields` (string[] \| null → smart defaults) → rows via `search_read` |
| `list_models` | read | — |
| `get_fields` | read | `model` (string) → field name/type/label schema |
| `projects.list_tasks` | read | `domain` (array), `fields` (string[]) — convenience wrapper over `project.task` |
| `aggregate_records` | read | `model` (string), `domain` (array), `groupby` (string[], Odoo `field:agg` syntax e.g. `invoice_date:month`), `aggregates` (string[], e.g. `amount_total:sum`, `__count`), `lazy` (bool, default true), `orderby` (string, optional) — wraps Odoo `read_group` |
| `create_record` | write | `model` (string), `values` (object) |
| `update_record` | write | `model` (string), `record_id` (positive int), `values` (object; x2many use Odoo command tuples, e.g. `[[6,0,ids]]`, `[[4,id]]`, `[[3,id]]`) |
| `delete_record` | write | `model` (string), `record_id` (positive int) |
| `batch_update` | write | `model` (string), `updates` (array of `{ record_id, values }`; x2many use Odoo command tuples) — one `write` per entry, fail-fast |
| `batch_post_message` | write | `model` (string), `messages` (array of `{ record_id, body, subtype?, body_is_html? }`) — one `message_post` per entry, HTML-escaped unless `body_is_html` |

Writes are gated by *your* Odoo user's access rights and record rules (BYO-key), so a caller
can only do what their Odoo account permits.

### Field selection

For `search_records` / `get_record`, `fields`:
- omit / `null` → a smart default set of the most relevant fields,
- a string array → exactly those fields.

## Resources

In addition to tools, the server exposes read-only Odoo data as **MCP resources** via URI
templates. Any MCP client can discover them with `resources/templates/list` (handled
automatically by the SDK) and read them with `resources/read`.

| URI template | Description | Example |
|---|---|---|
| `odoo://{model}/record/{id}` | Fetch a single record by id | `odoo://project.task/record/42` |
| `odoo://{model}/search` | List records for a model. Optional `?domain=<JSON array>&fields=<comma-separated>&limit=<1-100>` query params (defaults: `domain=[]`, smart fields, `limit=10`) | `odoo://project.task/search?domain=%5B%5B%22active%22%2C%22%3D%22%2Ctrue%5D%5D&limit=5` |
| `odoo://{model}/count` | Count records matching a domain via `search_count`. Optional `?domain=<JSON array>` query param (default `[]`) | `odoo://project.task/count?domain=%5B%5B%22active%22%2C%22%3D%22%2Ctrue%5D%5D` |
| `odoo://{model}/fields` | Field schema (name, type, string label) for a model | `odoo://project.task/fields` |

All four resources are strictly read-only (`read` / `search_read` / `search_count` / `fields_get`
only) and use the same BYO-key connection headers as the tools above.

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

## Connect ChatGPT (OAuth)

ChatGPT's connector UI can't set custom headers, so the Worker ships an OAuth 2.1 shim
(authorization code + PKCE + dynamic client registration) on the same `/mcp` endpoint:

1. Deploy the Worker (see below — the `OAUTH_KV` namespace must exist).
2. In ChatGPT: **Settings → Apps & Connectors → Advanced settings → enable Developer Mode**,
   then **Create connector**: give it a name and the server URL
   `https://<worker>.workers.dev/mcp`, auth **OAuth**.
3. ChatGPT redirects you to the Worker's hosted `/authorize` page. Paste your Odoo URL,
   database, and API key — the shim verifies them against your Odoo before accepting.
4. Back in ChatGPT, the connector shows the tool list; try a read tool (e.g. ask it to
   search `project.task`).

Your credentials are stored end-to-end encrypted in Workers KV and resolved per request —
tools behave exactly as on the header path, limited by your own Odoo permissions. Token
lifetime is 1 h (refresh 30 days). Revocation: delete the `grant:*` key via
`npx wrangler kv key list/delete --binding OAUTH_KV --remote` (details in
[docs/product/auth.md](docs/product/auth.md)).

## Deploy

```bash
npm ci                # required — node_modules must actually be installed before bundling
npx wrangler deploy
```

- `wrangler` must already be logged in (`npx wrangler whoami`; if not, `npx wrangler login`).
- The header path is stateless/BYO-key, so there are no secrets or `.dev.vars` to set for a
  deploy. The ChatGPT OAuth shim needs one resource: the **`OAUTH_KV`** KV namespace bound in
  `wrangler.jsonc`. Deploying to a new account? Create it once with
  `npx wrangler kv namespace create OAUTH_KV` and put the printed `id` into the
  `kv_namespaces` entry.
- If your Cloudflare login can reach **multiple accounts**, `wrangler deploy` needs to know
  which one to use. `wrangler deploy` has no `--account-id` flag — set the account via the
  `CLOUDFLARE_ACCOUNT_ID` env var instead (or add `"account_id"` to `wrangler.jsonc`):
  ```bash
  CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy
  ```
  Run `npx wrangler whoami` to list the account IDs your login can reach.
- `wrangler.jsonc` declares the `McpAgent` Durable Object; the first deploy provisions it
  automatically — no manual setup needed.
- On success, wrangler prints the public URL: `https://<worker-name>.<subdomain>.workers.dev`.
  The MCP endpoint is that URL + `/mcp`.

## Development

- `npm run typecheck` — `tsc --noEmit`
- `npx wrangler deploy --dry-run` — bundle check
- CI gate: `.ci.json` (install → typecheck → deploy dry-run)

## License

MIT (see repository).
