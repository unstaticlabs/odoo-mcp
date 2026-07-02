# Testing the odoo-mcp server

How to run and exercise the server **locally** and against a **deployed Cloudflare Worker**.
All requests to `/mcp` need the three BYO-key headers (see the README):
`Authorization: Bearer <odoo-api-key>`, `X-Odoo-Url`, `X-Odoo-Db`.

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
three headers above. Then **List Tools** and try `search_records`.

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

### Connect ChatGPT (remote)

Add a **custom connector / remote MCP server** pointing at `https://<worker>.workers.dev/mcp`.
ChatGPT's connector UI is more restrictive about custom auth headers than Claude; if it can't
send the BYO-key headers, a thin OAuth shim can be added for that path later (out of scope for
now). See `docs/product/auth.md`.

### Verify the deploy

Reuse the Node client from section 1(d) with the deployed URL — the outbound Odoo fetch is
reliable on the real Cloudflare edge (unlike local Miniflare), so calls return promptly.

---

## Security notes

- Credentials arrive per request and are never logged, persisted, or echoed in errors.
- Auth failures return `401` with a generic message (no header values).
- Writes (`create`/`update`/`delete`) are limited by the caller's own Odoo permissions.
