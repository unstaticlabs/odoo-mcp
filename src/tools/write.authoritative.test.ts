import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { callOdoo } from "../odoo";
import { OdooQueue } from "../odoo-queue";
import { validatedToolHandler } from "./structured-test-util";
import { registerWriteTools } from "./write";

const props = { odooBaseUrl: "https://odoo.example.com", odooDb: "db", odooApiKey: "secret" };

function build() {
  const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
  const caller = (async (_conn, model, method, args) => {
    if (model === "usl.json2.idempotency") throw new Error("extension unavailable");
    calls.push({ model, method, args });
    if (method === "create") return [73];
    if (method === "custom_public_method") return { ok: true };
    return true;
  }) as typeof callOdoo;
  const queue = new OdooQueue(caller);
  const server = new McpServer({ name: "test", version: "1" });
  registerWriteTools(server, () => props, queue);
  return { server, calls, handler: (name: string) => validatedToolHandler(server, name) };
}

describe("Odoo-authoritative generic writes", () => {
  test("previously restricted models and fields reach Odoo unchanged", async () => {
    const { calls, handler } = build();
    const result = await handler("update_record")({
      model: "res.company",
      record_id: 4,
      values: { fiscalyear_lock_date: "2026-12-31", arbitrary_custom_field: "x" },
      reason: "Apply the requested company configuration",
      odoo_context: {
        allowed_company_ids: [4],
        usl_agent_origin: "spoofed",
        usl_correlation_id: "spoofed"
      },
      idempotency_key: "company-config-1"
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "res.company",
      method: "write",
      args: {
        ids: [4],
        vals: { fiscalyear_lock_date: "2026-12-31", arbitrary_custom_field: "x" },
        context: {
          allowed_company_ids: [4],
          usl_agent_origin: "odoo-mcp",
          usl_idempotency_key: "company-config-1",
          usl_agent_reason: "Apply the requested company configuration"
        }
      }
    });
    expect(result.structuredContent).toMatchObject({
      execution: {
        idempotency_key: "company-config-1",
        idempotency_mode: "unavailable",
        outcome: "succeeded"
      }
    });
  });

  test("calls any public method with named kwargs and optional ids", async () => {
    const { calls, handler } = build();
    const result = await handler("call_model_method")({
      model: "x_studio_model",
      method: "custom_public_method",
      ids: [8],
      kwargs: { flag: true },
      idempotency_key: "custom-method-8"
    });
    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({
      model: "x_studio_model",
      method: "custom_public_method",
      args: { ids: [8], flag: true }
    });
  });

  test("tool schemas expose reason, Odoo context, and idempotency but no legacy controls", () => {
    const { server } = build();
    const registry = Reflect.get(server, "_registeredTools") as Record<
      string,
      { inputSchema: { safeParse(value: unknown): unknown; shape: Record<string, unknown> } }
    >;
    for (const tool of Object.values(registry)) {
      expect(Object.keys(tool.inputSchema.shape)).not.toContain("confirmation_token");
      expect(Object.keys(tool.inputSchema.shape)).not.toContain("context");
    }
    const callMethod = registry.call_model_method;
    expect(callMethod.inputSchema.safeParse({ model: "res.partner", method: "name_get", kwargs: {}, args: [] })).toMatchObject({
      success: false
    });
  });
});
