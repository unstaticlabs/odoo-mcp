import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const fixture = process.env.ODOO_INTEGRATION_EVIDENCE_FIXTURE;
const enabled = process.env.ODOO_INTEGRATION_MUTATION_QA === "1" && Boolean(fixture);
type Fixture = { source_company_id: number; target_company_id: number; expense_ids: number[]; move_id: number; restricted_expense_id: number };

describe.skipIf(!enabled).sequential("synthetic native source evidence handoff", () => {
  let client: Client; let cleanup: () => Promise<void>; let input: Fixture; let bytes: Buffer;
  let firstAttachment: number;
  beforeAll(async () => {
    input = JSON.parse(fixture!);
    if (process.env.ODOO_INTEGRATION_DATABASE !== "odoo_action_risk") throw new Error("Use the dedicated synthetic QA registry");
    bytes = await readFile("/qa-source/qa-new-source-evidence.pdf");
    const context: RequestContext = { requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "default",
      principal: { targetId: "qa-source-evidence", authMode: "stdio", publicOrigin: process.env.ODOO_INTEGRATION_ORIGIN!,
        internalOrigin: process.env.ODOO_INTEGRATION_INTERNAL_ORIGIN!, database: process.env.ODOO_INTEGRATION_DATABASE!, apiKey: process.env.ODOO_INTEGRATION_API_KEY! } };
    const odoo = new OdooClient(); const cache = new AgentAccessSnapshotCache(odoo); const snapshot = await cache.initialize(context);
    context.agentIdentity = snapshot.identity; context.availableModules = snapshot.surface?.modules ?? null;
    context.availablePublicMethods = snapshot.surface?.publicMethods ?? null; context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
    context.touchAgentAccess = () => cache.touch(context); context.noteAgentAccessFailure = error => cache.noteAccessFailure(context, error);
    const server = createCapabilityRegistry(odoo).createServer(context);
    client = new Client({ name: "qa-source-evidence", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    cleanup = async () => { await client.close(); await server.close(); await cache.close(); };
  }, 60_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  const companies = () => ({ allowed_company_ids: [input.source_company_id, input.target_company_id] });
  const file = () => ({ download_url: "file:///qa-source/qa-new-source-evidence.pdf", file_id: "qa-original-pdf", file_name: "qa-new-source-evidence.pdf", mime_type: "application/pdf",
    byte_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  async function read(model: string, ids: number[], fields: string[]) {
    const result = await client.callTool({ name: "odoo_read_records", arguments: { model, ids, fields, context: companies() } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return (result.structuredContent as { data: { records: Array<Record<string, unknown>> } }).data.records;
  }
  it("passes a real client file reference and reads exact native expense evidence", async () => {
    const before = await read("hr.expense", [input.expense_ids[0]!], ["state", "total_amount_currency", "company_id", "employee_id", "account_move_id"]);
    const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: { file: file(), target_model: "hr.expense", target_id: input.expense_ids[0], set_main_attachment: true, context: companies() } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const data = (result.structuredContent as { data: { result: { attachment_id: number; sha256: string } } }).data.result;
    firstAttachment = data.attachment_id;
    expect(data.sha256).toBe(file().sha256);
    const attachment = (await read("ir.attachment", [firstAttachment], ["name", "mimetype", "file_size", "checksum", "raw", "res_model", "res_id", "public"]))[0]!;
    expect(Buffer.from(String(attachment.raw), "base64")).toEqual(bytes);
    expect(attachment).toMatchObject({ name: file().file_name, mimetype: "application/pdf", file_size: bytes.length, res_model: "hr.expense", res_id: input.expense_ids[0], public: false });
    expect(await read("hr.expense", [input.expense_ids[0]!], ["state", "total_amount_currency", "company_id", "employee_id", "account_move_id"])).toEqual(before);
  }, 60_000);
  it("reuses the same owned file on repeat without duplicating history", async () => {
    const before = await read("hr.expense", [input.expense_ids[0]!], ["message_ids", "message_main_attachment_id"]);
    const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: { file: file(), target_model: "hr.expense", target_id: input.expense_ids[0], set_main_attachment: true, context: companies() } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { result: { attachment_id: firstAttachment, reused: true } } });
    expect(await read("hr.expense", [input.expense_ids[0]!], ["message_ids", "message_main_attachment_id"])).toEqual(before);
  }, 60_000);
  it("attaches the same exact source to a posted entry without changing its financial lines", async () => {
    const before = await read("account.move", [input.move_id], ["state", "name", "amount_total", "line_ids"]);
    const ids = before[0]!.line_ids as number[];
    const lines = await read("account.move.line", ids, ["account_id", "debit", "credit", "currency_id", "amount_currency", "amount_residual", "full_reconcile_id"]);
    const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: { file: file(), target_model: "account.move", target_id: input.move_id, set_main_attachment: true, context: companies() } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect((result.structuredContent as any).data.result.attachment_id).not.toBe(firstAttachment);
    expect(await read("account.move", [input.move_id], ["state", "name", "amount_total", "line_ids"])).toEqual(before);
    expect(await read("account.move.line", ids, ["account_id", "debit", "credit", "currency_id", "amount_currency", "amount_residual", "full_reconcile_id"])).toEqual(lines);
  }, 60_000);
  it("accepts the native required-only file reference with filename fallback and disclosed MIME inference", async () => {
    const before = await read("hr.expense", [input.expense_ids[0]!], ["message_ids", "message_main_attachment_id"]);
    const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: {
      file: { download_url: file().download_url, file_id: file().file_id }, original_filename: file().file_name,
      target_model: "hr.expense", target_id: input.expense_ids[0], set_main_attachment: true, context: companies(),
    } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { result: { attachment_id: firstAttachment, reused: true, mime_inferred: true, mimetype: "application/pdf" } } });
    expect(await read("hr.expense", [input.expense_ids[0]!], ["message_ids", "message_main_attachment_id"])).toEqual(before);
  }, 60_000);
  it("denies an unselected company without adding evidence or history", async () => {
    const before = await read("hr.expense", [input.restricted_expense_id], ["message_ids", "message_main_attachment_id", "state", "company_id"]);
    const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: { file: file(), target_model: "hr.expense", target_id: input.restricted_expense_id, context: { allowed_company_ids: [input.source_company_id] } } });
    expect(result.isError).toBe(true);
    expect(await read("hr.expense", [input.restricted_expense_id], ["message_ids", "message_main_attachment_id", "state", "company_id"])).toEqual(before);
  }, 60_000);
  it("materializes an exact HTTPS connector file onto an owned native expense", async () => {
    const url = "https://raw.githubusercontent.com/unstaticlabs/odoo/3d43bbd8a5267309f747979e1edecc6df8e41f97/docs/product/screenshots/expense-family/preview-mobile.png";
    const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: { file: { download_url: url, file_id: "qa-connector-image", file_name: "qa-source-image.png", mime_type: "image/png", sha256: "86b7e271f2236e77f2cdf053d0a2fc2ac56f8da8f18a2b74f87a0421c92d11e5" }, target_model: "hr.expense", target_id: input.expense_ids[1], context: companies() } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { result: { sha256: "86b7e271f2236e77f2cdf053d0a2fc2ac56f8da8f18a2b74f87a0421c92d11e5", filename: "qa-source-image.png", mimetype: "image/png" } } });
    expect(JSON.stringify(result)).not.toContain(url);
  }, 60_000);
});
