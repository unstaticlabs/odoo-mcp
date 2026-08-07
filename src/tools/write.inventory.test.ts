/**
 * Narrow inventory master-data graduation (cards ODOO2240, ODOO2255) — tool-level contract.
 *
 * `product.category`, `stock.location` and `product.template` create/write reach Odoo under the
 * caller's ACLs; every refusal on those paths (connector policy, duplicate, Odoo ACL, Odoo
 * validation) is a structured envelope naming the refusing layer and the next step — never an opaque
 * error. Sibling `product.*` / `stock.*` models stay default-denied.
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OdooError } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import { validatedToolHandler } from "./structured-test-util";
import { registerWriteTools } from "./write";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
const SECRET = "test-confirmation-secret";

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
type Call = { model: string; method: string; args: Record<string, unknown> };

/** Queue recording every Odoo call, so "no second create" / "no call at all" are assertable. */
function recordingQueue(responder: (call: Call) => unknown) {
  const calls: Call[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const call: Call = { model: a[1] as string, method: a[2] as string, args: a[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call);
  });
  return { queue: { enqueue } as unknown as OdooQueue, calls };
}

function buildHandlers(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue, () => SECRET);
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return {
    createRecord: handler("create_record"),
    updateRecord: handler("update_record"),
    deleteRecord: handler("delete_record"),
    callModelMethod: handler("call_model_method")
  };
}

/** No existing record matches the duplicate domain. */
const noDuplicates = (call: Call) => (call.method === "search_read" ? [] : [7]);

describe("graduated create/write reach Odoo", () => {
  test("create_record on product.category creates with vals_list under the caller's ACLs", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({
      model: "product.category",
      values: { name: "Consumables", parent_id: 3 },
      context: "user asked for a new expense category"
    });

    expect(result.isError).toBeUndefined();
    // product.category routes through the verified Categories action path (ODOO2272).
    expect(result.structuredContent).toEqual({
      id: 7,
      web_url: "http://example.com/odoo/product-categories/7"
    });
    expect(calls.map((c) => c.method)).toEqual(["search_read", "create"]);
    expect(calls[1].args).toEqual({ vals_list: [{ name: "Consumables", parent_id: 3 }] });
  });

  test("create_record on stock.location checks location_id (not parent_id) for duplicates", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({
      model: "stock.location",
      values: { name: "Shelf 1", location_id: 8, usage: "internal" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0].args.domain).toEqual([
      ["name", "=", "Shelf 1"],
      ["location_id", "=", 8]
    ]);
    expect(calls[0].args.fields).toEqual(["id", "name", "location_id"]);
  });

  test("a root record (no parent in the payload) is checked against parent = false", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { createRecord } = buildHandlers(queue);

    await createRecord({ model: "product.category", values: { name: "Top Level" } });

    expect(calls[0].args.domain).toEqual([
      ["name", "=", "Top Level"],
      ["parent_id", "=", false]
    ]);
  });

  test("a [id, display_name] many2one payload coerces to the parent id", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { createRecord } = buildHandlers(queue);

    await createRecord({ model: "product.category", values: { name: "Nested", parent_id: [3, "Saleable"] } });

    expect(calls[0].args.domain).toEqual([
      ["name", "=", "Nested"],
      ["parent_id", "=", 3]
    ]);
  });

  test("update_record on stock.location writes without a duplicate lookup (update is not create)", async () => {
    const { queue, calls } = recordingQueue(() => true);
    const { updateRecord } = buildHandlers(queue);

    const result = await updateRecord({ model: "stock.location", record_id: 8, values: { name: "Shelf 2" } });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["write"]);
  });

  test("create_record on product.template checks name+company_id (templates are flat, not nested)", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({
      model: "product.template",
      values: { name: "Blue Mug", company_id: 2, type: "consu" },
      context: "B2C catalogue rebuild"
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id: 7, web_url: "http://example.com/odoo/products/7" });
    expect(calls.map((c) => c.method)).toEqual(["search_read", "create"]);
    expect(calls[0].args.domain).toEqual([
      ["name", "=", "Blue Mug"],
      ["company_id", "=", 2]
    ]);
    expect(calls[0].args.fields).toEqual(["id", "name", "company_id"]);
    expect(calls[1].args).toEqual({ vals_list: [{ name: "Blue Mug", company_id: 2, type: "consu" }] });
  });

  test("a product.template with default_code runs the SKU check too, then creates", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({
      model: "product.template",
      values: { name: "Blue Mug", company_id: 2, default_code: "MUG-BLUE" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["search_read", "search_read", "create"]);
    expect(calls[1].args.domain).toEqual([
      ["default_code", "=", "MUG-BLUE"],
      ["company_id", "=", 2]
    ]);
  });

  test("update_record on product.template writes without a duplicate lookup", async () => {
    const { queue, calls } = recordingQueue(() => true);
    const { updateRecord } = buildHandlers(queue);

    const result = await updateRecord({
      model: "product.template",
      record_id: 7,
      values: { list_price: 12.5 }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["write"]);
  });

  test("call_model_method write on product.template reaches Odoo", async () => {
    const { queue, calls } = recordingQueue(() => true);
    const { callModelMethod } = buildHandlers(queue);

    const result = await callModelMethod({
      model: "product.template",
      method: "write",
      ids: [7],
      kwargs: { vals: { standard_price: 3.2 } }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["write"]);
  });
});

describe("duplicate preflight", () => {
  test("same name under the same parent is refused, naming the existing id, before any create", async () => {
    const { queue, calls } = recordingQueue((call) =>
      call.method === "search_read" ? [{ id: 12, name: "Consumables", parent_id: [3, "Saleable"] }] : [99]
    );
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({ model: "product.category", values: { name: "Consumables", parent_id: 3 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope).toMatchObject({
      error: "write_blocked",
      model: "product.category",
      method: "create",
      policy_rule: "duplicate_master_data",
      refusing_layer: "connector_policy",
      risk_class: "reversible_configuration",
      record_ids: [12],
      blocked_fields: ["name", "parent_id"],
      recoverable: true
    });
    expect(envelope.details).toContain("id 12");
    expect(envelope.next_step).toContain("12");
    // The whole point: no second create.
    expect(calls.map((c) => c.method)).toEqual(["search_read"]);
  });

  test("call_model_method create cannot bypass the duplicate preflight", async () => {
    const { queue, calls } = recordingQueue((call) =>
      call.method === "search_read" ? [{ id: 5, name: "Shelf 1", location_id: [8, "WH/Stock"] }] : [99]
    );
    const { callModelMethod } = buildHandlers(queue);

    const result = await callModelMethod({
      model: "stock.location",
      method: "create",
      kwargs: { vals_list: [{ name: "Shelf 1", location_id: 8 }] }
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("duplicate_master_data");
    expect(envelope.record_ids).toEqual([5]);
    expect(calls.map((c) => c.method)).toEqual(["search_read"]);
  });

  test("call_model_method create proceeds when no duplicate exists", async () => {
    const { queue, calls } = recordingQueue(noDuplicates);
    const { callModelMethod } = buildHandlers(queue);

    const result = await callModelMethod({
      model: "product.category",
      method: "create",
      kwargs: { vals_list: [{ name: "Fresh", parent_id: 3 }] }
    });

    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["search_read", "create"]);
  });

  test("product.template with the same name in the same company is refused before any create", async () => {
    const { queue, calls } = recordingQueue((call) =>
      call.method === "search_read" ? [{ id: 31, name: "Blue Mug", company_id: [2, "Acme"] }] : [99]
    );
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({ model: "product.template", values: { name: "Blue Mug", company_id: 2 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope).toMatchObject({
      error: "write_blocked",
      model: "product.template",
      method: "create",
      policy_rule: "duplicate_master_data",
      refusing_layer: "connector_policy",
      risk_class: "reversible_configuration",
      record_ids: [31],
      blocked_fields: ["name", "company_id"],
      recoverable: true
    });
    expect(envelope.details).toContain("id 31");
    expect(envelope.next_step).toContain("31");
    expect(calls.map((c) => c.method)).toEqual(["search_read"]);
  });

  test("product.template with a colliding default_code is refused even when the name is free", async () => {
    let lookups = 0;
    const { queue, calls } = recordingQueue((call) => {
      if (call.method !== "search_read") return [99];
      // First lookup is name+company (free); second is default_code+company (taken).
      lookups += 1;
      return lookups === 1 ? [] : [{ id: 44, name: "Mug (old)", default_code: "MUG-BLUE", company_id: [2, "Acme"] }];
    });
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({
      model: "product.template",
      values: { name: "Blue Mug", company_id: 2, default_code: "MUG-BLUE" }
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("duplicate_master_data");
    expect(envelope.blocked_fields).toEqual(["default_code", "company_id"]);
    expect(envelope.record_ids).toEqual([44]);
    expect(envelope.details).toContain("MUG-BLUE");
    expect(calls.map((c) => c.method)).toEqual(["search_read", "search_read"]);
  });

  test("call_model_method create on product.template cannot bypass the duplicate preflight", async () => {
    const { queue, calls } = recordingQueue((call) =>
      call.method === "search_read" ? [{ id: 31, name: "Blue Mug", company_id: false }] : [99]
    );
    const { callModelMethod } = buildHandlers(queue);

    const result = await callModelMethod({
      model: "product.template",
      method: "create",
      kwargs: { vals_list: [{ name: "Blue Mug" }] }
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.policy_rule).toBe("duplicate_master_data");
    expect(envelope.record_ids).toEqual([31]);
    expect(envelope.details).toContain("no company (shared)");
    expect(calls.map((c) => c.method)).toEqual(["search_read"]);
  });

  test("a nameless create skips the lookup and lets Odoo's own validation refuse it", async () => {
    const { queue, calls } = recordingQueue(() => {
      throw new OdooError({
        message: "Odoo validation",
        code: "invalid_request",
        httpStatus: 400,
        model: "product.category",
        method: "create",
        details: 'null value in column "name" violates not-null constraint'
      });
    });
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({ model: "product.category", values: { parent_id: 3 } });

    expect(calls.map((c) => c.method)).toEqual(["create"]);
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.refusing_layer).toBe("schema");
    expect(envelope.blocked_fields).toEqual(["name"]);
    expect(envelope.next_step).toBeTruthy();
  });

  test("a failing duplicate lookup fails closed with a structured envelope (no unverified create)", async () => {
    const { queue, calls } = recordingQueue((call) => {
      if (call.method === "search_read") {
        throw new OdooError({
          message: "Access Denied",
          code: "permission_denied",
          httpStatus: 403,
          model: "product.category",
          method: "search_read",
          details: "You are not allowed to access 'Product Category' records."
        });
      }
      return [7];
    });
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({ model: "product.category", values: { name: "Consumables" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("permission_denied");
    expect(envelope.refusing_layer).toBe("odoo_record_rule");
    expect(envelope.next_step).toBeTruthy();
    expect(calls.map((c) => c.method)).toEqual(["search_read"]);
  });
});

describe("refusals on graduated paths are structured, never opaque", () => {
  test("an Odoo ACL denial on create names the layer and keeps Odoo's own message", async () => {
    const { queue } = recordingQueue((call) => {
      if (call.method === "search_read") return [];
      throw new OdooError({
        message: "Access Denied",
        code: "permission_denied",
        httpStatus: 403,
        model: "stock.location",
        method: "create",
        details: "You are not allowed to create 'Inventory Location' (stock.location) records."
      });
    });
    const { createRecord } = buildHandlers(queue);

    const result = await createRecord({ model: "stock.location", values: { name: "Shelf 9" } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("permission_denied");
    expect(envelope.refusing_layer).toBe("odoo_acl");
    expect(envelope.details).toContain("not allowed to create");
    expect(envelope.next_step).toContain("access rights");
    expect(result.content[0].text).not.toContain("secret-key");
  });

  test("an Odoo validation error naming a field surfaces that field on update_record", async () => {
    const { queue } = recordingQueue(() => {
      throw new OdooError({
        message: "Invalid field",
        code: "invalid_request",
        httpStatus: 400,
        model: "product.category",
        method: "write",
        details: "Invalid field 'parent_idd' on model 'product.category'"
      });
    });
    const { updateRecord } = buildHandlers(queue);

    const result = await updateRecord({ model: "product.category", record_id: 4, values: { parent_idd: 3 } });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.refusing_layer).toBe("schema");
    expect(envelope.blocked_fields).toEqual(["parent_idd"]);
    expect(envelope.record_ids).toEqual([4]);
    expect(envelope.next_step).toBeTruthy();
  });

  test("sibling product.* / stock.* models stay refused by connector policy, before any Odoo call", async () => {
    const { queue, calls } = recordingQueue(() => [1]);
    const { createRecord } = buildHandlers(queue);

    for (const model of ["product.product", "stock.picking", "stock.move", "stock.quant"]) {
      const result = await createRecord({ model, values: { name: "Widget" } });
      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe("write_blocked");
      expect(envelope.intent).toBe("disallowed");
      expect(envelope.refusing_layer).toBe("connector_policy");
      expect(envelope.next_step).toBeTruthy();
    }
    expect(calls).toEqual([]);
  });
});

describe("irreversible operations stay confirmation-gated", () => {
  for (const model of ["product.category", "stock.location", "product.template"]) {
    test(`${model} delete_record preflights, then executes with the token`, async () => {
      const { queue, calls } = recordingQueue(() => true);
      const { deleteRecord } = buildHandlers(queue);

      const preflight = await deleteRecord({ model, record_id: 4, context: "cleanup" });
      expect(preflight.isError).toBe(true);
      const envelope = JSON.parse(preflight.content[0].text);
      expect(envelope.error).toBe("confirmation_required");
      expect(envelope.risk_class).toBe("destructive");
      expect(typeof envelope.confirmation_token).toBe("string");
      expect(calls).toEqual([]);

      const confirmed = await deleteRecord({
        model,
        record_id: 4,
        context: "cleanup",
        confirmation_token: envelope.confirmation_token
      });
      expect(confirmed.isError).toBeUndefined();
      expect(calls.map((c) => c.method)).toContain("unlink");
    });

    test(`${model} unlink via call_model_method also needs a token`, async () => {
      const { queue, calls } = recordingQueue(() => true);
      const { callModelMethod } = buildHandlers(queue);

      const result = await callModelMethod({ model, method: "unlink", ids: [4] });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe("confirmation_required");
      expect(calls).toEqual([]);
    });
  }
});
