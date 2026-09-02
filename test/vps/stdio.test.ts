import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

describe("stdio entrypoint", () => {
  it("starts as a subprocess and exposes the canonical default registry", async () => {
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
        ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
        ODOO_DATABASE: "test",
        ODOO_URL: "https://odoo.example",
        ODOO_API_KEY: "stdio-test-key",
        MCP_OAUTH_ENABLED: "false",
        MCP_ANALYTICS_ENABLED: "false"
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "stdio-subprocess-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(17);
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "odoo_search_capabilities",
        "odoo_search_models",
        "odoo_describe_model",
        "odoo_search_records",
        "odoo_read_records"
      ]));
      expect(tools.tools.map((tool) => tool.name)).not.toContain("odoo_call_method");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("home_get_attention");
    } finally {
      await client.close();
    }
  }, 15_000);
});
