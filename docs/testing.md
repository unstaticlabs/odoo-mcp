# Testing the odoo-mcp server

How to run and exercise the server **locally** and against a **deployed Cloudflare Worker**.
Header-authenticated requests to `/mcp` need the three BYO-key headers (see the README):
`Authorization: Bearer <odoo-api-key>`, `X-Odoo-Url`, `X-Odoo-Db`. Requests without any
`X-Odoo-*` header go through the ChatGPT OAuth shim instead (section 3).

---

## 1. Local (`wrangler dev`)

```bash
npm ci
npx wrangler dev            # → Ready on http://localhost:8787
```

> **Note on local dev:** Miniflare's outbound `fetch` to an external Odoo host can be slow or
> intermittently hang on the *first* call (cold start). The server wraps Odoo calls in a
> timeout + retry, so a stuck request fails fast and retries rather than hanging forever.
> For fully reliable end-to-end runs against real Odoo, prefer a deployed Worker (section 2).

### a) MCP Inspector (fastest smoke test)

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI: transport **Streamable HTTP**, URL `http://localhost:8787/mcp`, and add the
three headers above. Then **List Tools** and try `search_records` or `browse_records`.

### b) Claude Code

```bash
claude mcp add --transport http odoo http://localhost:8787/mcp \
  --header "Authorization: Bearer $ODOO_API_KEY" \
  --header "X-Odoo-Url: https://your-org.odoo.com" \
  --header "X-Odoo-Db: your-db"
# then, in a claude session:  "list the odoo tools"  /  "search project.task where project_id = 17"
```

### c) Raw HTTP (auth check)

Missing headers must return `401`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'      # → 401
```

### d) Node client (list tools + call one)

```js
// smoke.mjs  —  run from the repo root (uses the installed @modelcontextprotocol/sdk)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const headers = {
  Authorization: `Bearer ${process.env.ODOO_API_KEY}`,
  "X-Odoo-Url": process.env.ODOO_URL,   // e.g. https://your-org.odoo.com
  "X-Odoo-Db": process.env.ODOO_DB,
};
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8787/mcp"), { requestInit: { headers } });
const client = new Client({ name: "smoke", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

console.log("tools:", (await client.listTools()).tools.map(t => t.name));
const res = await client.callTool({
  name: "search_records",
  arguments: { model: "project.task", domain: [], fields: ["id", "name"], limit: 3 },
});
console.log(res.content.map(c => c.text).join("\n"));
// Schema-aware clients also get structuredContent with field reporting:
// returned_fields, omitted_fields (with reason), and warnings[] on read tools.

const browse = await client.callTool({
  name: "browse_records",
  arguments: {
    model: "project.task",
    domain: [],
    field_preset: "tracking_minimal",
    limit: 25,
    offset: 0,
    order: "id asc"
  }
});
console.log("browse page 1:", browse.content.map(c => c.text).join("\n"));
await client.close();
```

```bash
ODOO_API_KEY=… ODOO_URL=https://your-org.odoo.com ODOO_DB=your-db node smoke.mjs
```

---

## 2. Deployed Cloudflare Worker

### Deploy

```bash
npx wrangler deploy         # to the target Cloudflare account
```

Notes:
- `wrangler.jsonc` declares the `McpAgent` Durable Object; the first deploy provisions it.
- Choose the account with `--account-id <id>` or by setting `account_id` in `wrangler.jsonc` /
  `CLOUDFLARE_ACCOUNT_ID` (run `npx wrangler whoami` to see which accounts your login can reach).
- The public URL is `https://<worker-name>.<subdomain>.workers.dev/mcp`.

### Connect Claude (remote)

```bash
claude mcp add --transport http odoo https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer $ODOO_API_KEY" \
  --header "X-Odoo-Url: https://your-org.odoo.com" \
  --header "X-Odoo-Db: your-db"
```

### Verify the deploy

Reuse the Node client from section 1(d) with the deployed URL — the outbound Odoo fetch is
reliable on the real Cloudflare edge (unlike local Miniflare), so calls return promptly.

---

## 3. The ChatGPT OAuth shim

ChatGPT can't send custom headers, so it authenticates through the Worker's OAuth 2.1 shim
(`/authorize`, `/token`, `/register`, `/.well-known/*`). See `docs/product/auth.md` for the
design; `wrangler.jsonc` must have the `OAUTH_KV` binding.

### a) MCP Inspector (test the OAuth flow without ChatGPT)

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI: transport **Streamable HTTP**, URL `http://localhost:8787/mcp` (or the
deployed URL), **no headers**, and click **Open Auth Settings → Quick OAuth Flow** (or just
Connect — the Inspector detects the `401` + discovery metadata). A browser tab opens the
Worker's `/authorize` page: paste your Odoo URL, database, and API key. The shim validates
them against Odoo, redirects back, and the Inspector completes the token exchange. Then
**List Tools** and try `browse_records` (e.g. `project.task`, `field_preset: "tracking_minimal"`, `limit: 25`, then page with `offset: 25`).

### b) Connect ChatGPT (Developer Mode)

1. ChatGPT → **Settings → Apps & Connectors → Advanced settings → enable Developer Mode**.
2. **Create connector**: name it, set the MCP server URL to
   `https://<worker>.workers.dev/mcp`, authentication **OAuth**.
3. ChatGPT registers itself dynamically and sends you to the `/authorize` form: enter your
   Odoo URL, database, and API key.
4. After the redirect the connector lists the tools. Verify with a read, e.g. ask ChatGPT to
   "search project.task, limit 3" with the connector enabled.

### c) Raw curl checks

```bash
# discovery metadata:
curl -s https://<worker>.workers.dev/.well-known/oauth-authorization-server | jq .

# /mcp without headers or token → 401 (OAuth challenge, not the header-path error):
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<worker>.workers.dev/mcp \
  -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# GET /mcp → 405: the optional standalone SSE (server-push) stream is deliberately
# not offered — this server never sends server-initiated messages, and agents@0.17.3
# stalls subsequent POSTs in production while a standalone stream is open.
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>.workers.dev/mcp \
  -H "Accept: text/event-stream"
```

### d) Revoke a stored credential

```bash
npx wrangler kv key list --binding OAUTH_KV --remote --prefix grant: | jq -r '.[].name'
npx wrangler kv key delete --binding OAUTH_KV --remote "grant:<userId>:<grantId>"
```

Deleting the grant destroys the wrapped encryption key, so outstanding access/refresh tokens
become useless immediately.

### e) Point a connector at a moved/rebuilt Odoo instance (re-auth)

You never need to delete a ChatGPT connector to change its Odoo URL, database, or API key —
those live in the OAuth grant, not in the connector. When an (ephemeral) test instance moves:

1. Revoke its grant as in (d). The grant's `userId` is `"<odoo-host>/<db>"`, so the key name
   tells you which connection is which.
2. Use the connector in ChatGPT again. The next call fails auth, ChatGPT prompts you to
   reconnect, and the same `/authorize` form comes up — enter the new URL/db/key there.
3. The connector, its name, and its settings all survive; only the grant is replaced. This
   also covers a rebuilt instance whose API key changed.

---

## Security notes

- Header-path credentials arrive per request and are never logged, persisted, or echoed in
  errors.
- OAuth-path credentials are validated against Odoo once at `/authorize`, then stored
  end-to-end encrypted in `OAUTH_KV` (decryptable only by presenting the issued token).
- Auth failures return `401` with a generic message (no header values, no token echoes).
- Writes (`create`/`update`/`delete`) are limited by the caller's own Odoo permissions on
  both paths.
