import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

// Explicit opt-in fixture: never infer write targets from a live business record.
const fixturePath = process.env.ODOO_INTEGRATION_BILL_TERMS_FIXTURE;
describe.skipIf(!fixturePath)("disposable bill terms through the native Agent API and MCP SDK", () => {
  it("keeps printed legal terms and internal notes distinct with unchanged native ledger lines", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
      disposable: boolean; database: string; origin: string; key: string;
      company_ids: number[]; bills: Record<string, number>;
    };
    expect(fixture.disposable).toBe(true);
    expect(new Set(fixture.company_ids).size).toBe(2);
    expect(fixture.database).toMatch(/^odoo_fb_/);
    expect(new URL(fixture.origin).hostname).toMatch(/^(localhost|127\.0\.0\.1|[a-z-]+\.localhost)$/);
    const context: RequestContext = {
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "default",
      principal: { targetId: "disposable-bill-terms", publicOrigin: fixture.origin,
        internalOrigin: fixture.origin, database: fixture.database, apiKey: fixture.key, authMode: "direct" }
    };
    const odoo = new OdooClient();
    const cache = new AgentAccessSnapshotCache(odoo);
    const snapshot = await cache.initialize(context, undefined, { requireSurface: true, timeoutMs: 90_000 });
    context.agentIdentity = snapshot.identity;
    context.availableModules = snapshot.surface?.modules ?? null;
    context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
    context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context);
    context.noteAgentAccessFailure = (error) => cache.noteAccessFailure(context, error);
    const server = createCapabilityRegistry(odoo).createServer(context);
    const client = new Client({ name: "disposable-bill-terms", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      async function call(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return result.structuredContent as { data: Record<string, any>; warnings: string[] };
      }
      const rpcContext = { allowed_company_ids: fixture.company_ids, lang: "en_US" };
      async function read(model: string, ids: number[], fields: string[]) {
        return (await call("odoo_read_records", { model, ids, fields, context: rpcContext })).data.records;
      }
      const metadata = await call("odoo_describe_model", {
        model: "account.move", field_names: ["narration"], include_methods: false, detail: "full"
      });
      expect(metadata.data.fields.narration.help).toMatch(/print|imprim|condition/i);
      expect(metadata.data.fields.narration.help).toMatch(/chatter/i);
      const english = await call("odoo_call_method", {
        model: "account.move", method: "fields_get", kwargs: { allfields: ["narration"], attributes: ["help"] },
        context: rpcContext
      });
      expect(english.data.result.narration.help).toContain("printed");
      expect(english.data.result.narration.help).toContain("Chatter");
      const draft = fixture.bills["1_draft"]!;
      const posted = fixture.bills["0_posted"]!;
      const [before] = await read("account.move", [posted], ["narration", "line_ids", "message_ids", "company_id"]);
      expect(before.company_id[0]).toBe(fixture.company_ids[0]);
      const lineFields = ["balance", "amount_currency", "amount_residual", "account_id", "tax_ids", "move_id", "company_id"];
      const ledger = await read("account.move.line", before.line_ids, lineFields);
      const terms = "<p>[QA terms] The remaining balance is payable within 30 days; contractual audit rights remain.</p>";
      const configured = await call("expenses_configure_draft_vendor_bill", {
        bill_id: draft, terms_and_conditions: terms, context: rpcContext
      });
      expect(configured.warnings.join(" ")).toContain("Terms and Conditions");
      expect(configured.data.result.bill.state).toBe("draft");
      expect(configured.data.result.bill.company.id).toBe(fixture.company_ids[1]);
      expect((await read("account.move", [draft], ["narration"]))[0].narration).toBe(terms);
      await call("expenses_configure_draft_vendor_bill", {
        bill_id: draft, reference: "[QA terms] New supplier reference", context: rpcContext
      });
      expect((await read("account.move", [draft], ["narration"]))[0].narration).toBe(terms);
      const generic = await call("odoo_update_records", {
        model: "account.move", ids: [posted], values: { narration: terms }, context: rpcContext
      });
      expect(generic.warnings.join(" ")).toContain("odoo_add_internal_note");
      const [beforeNote] = await read("account.move", [posted], ["narration", "message_ids"]);
      await call("odoo_add_internal_note", {
        model: "account.move", id: posted, body: "[QA terms] INTERNAL SDK MEMO < 2 & not contract terms",
        body_is_html: false, context: rpcContext
      });
      const [afterNote] = await read("account.move", [posted], ["narration", "message_ids"]);
      expect(afterNote.narration).toBe(terms);
      expect(afterNote.message_ids.length).toBe(beforeNote.message_ids.length + 1);
      expect(await read("account.move.line", before.line_ids, lineFields)).toEqual(ledger);
      await call("expenses_configure_draft_vendor_bill", {
        bill_id: draft, terms_and_conditions: "", context: rpcContext
      });
      expect((await read("account.move", [draft], ["narration"]))[0].narration).toBe("");
    } finally {
      await client.close(); await server.close(); await cache.close();
    }
  }, 120_000);
});
