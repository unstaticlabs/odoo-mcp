import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

describe("stdio entrypoint", () => {
  it("starts as a subprocess and exposes the canonical default registry", async () => {
    const odoo = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.includes("/json/2/usl.agent/current_identity")) {
        response.end(JSON.stringify({
          schema_version: 3,
          principal_kind: "agent",
          user_id: 41,
          agent: {
            id: 7,
            name: "stdio Agent",
            purpose: "Test stdio.",
            state: "active",
            access_mode: "read_write",
            authority_reduced: false,
            partner_id: 43
          },
          owner: { id: 5, name: "Test Owner" },
          credential: { id: 9, name: "stdio", expires_at: "2027-09-02 00:00:00" },
          company_id: 1,
          company_ids: [1],
          companies: [{ id: 1, name: "USL" }],
          effective_applications: [{ id: 10, name: "Accounting", access: "read_write" }],
          effective_group_ids: [1, 10]
        }));
        return;
      }
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "API document intentionally unavailable in this transport test" }));
    }).listen(0, "127.0.0.1");
    await once(odoo, "listening");
    const odooOrigin = `http://127.0.0.1:${(odoo.address() as AddressInfo).port}`;
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/stdio.ts"],
      cwd: process.cwd(),
      env: {
        ...inherited,
        ODOO_PUBLIC_ORIGIN: "https://odoo.example",
        ODOO_INTERNAL_ORIGIN: odooOrigin,
        ODOO_DATABASE: "test",
        ODOO_URL: "https://odoo.example",
        ODOO_API_KEY: "stdio-test-key",
        MCP_OAUTH_ENABLED: "false"
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "stdio-subprocess-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(20);
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "odoo_search_capabilities",
        "odoo_search_models",
        "odoo_describe_model",
        "odoo_search_records",
        "odoo_read_records"
      ]));
      expect(tools.tools.map((tool) => tool.name)).not.toContain("odoo_call_method");
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        odoo.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);
});
