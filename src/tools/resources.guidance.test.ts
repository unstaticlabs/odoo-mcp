import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OPERATIONS_GUIDE, registerAgentGuidance, SERVER_INSTRUCTIONS } from "./resources";

describe("layered agent guidance", () => {
  test("registers the fixed guide resource and reusable planning prompt", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    registerAgentGuidance(server);

    const internal = server as unknown as {
      _registeredResources: Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>;
      _registeredPrompts: Record<string, { callback: (args: Record<string, string>) => { messages: Array<{ content: { text: string } }> } }>;
    };
    const resource = internal._registeredResources["odoo://guide/operations"];
    expect(resource).toBeDefined();
    const rendered = await resource.readCallback(new URL("odoo://guide/operations"));
    expect(rendered.contents[0].text).toBe(OPERATIONS_GUIDE);

    const prompt = internal._registeredPrompts.plan_odoo_operation;
    expect(prompt).toBeDefined();
    const planned = prompt.callback({ objective: "Post the approved vendor bill" });
    expect(planned.messages[0].content.text).toContain("Post the approved vendor bill");
    expect(planned.messages[0].content.text).toContain("outcome_unknown");
  });

  test("guide and server instructions agree on the critical operating rules", () => {
    for (const phrase of ["Odoo", "Discover", "idempotency", "outcome_unknown"] as const) {
      expect(`${SERVER_INSTRUCTIONS}\n${OPERATIONS_GUIDE}`.toLowerCase()).toContain(phrase.toLowerCase());
    }
    for (const required of [
      "untrusted data",
      "x2many",
      "allowed_company_ids",
      "one public Odoo method",
      "never seek a connector bypass",
      "canonical _web_url/web_url"
    ]) {
      expect(OPERATIONS_GUIDE).toContain(required);
    }
  });
});
