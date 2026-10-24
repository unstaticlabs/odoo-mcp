import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map((callback) => callback())); });
const method = "get_purchase_attachment_context";
async function connected(options: { moveType?: string; snapshot?: Record<string, unknown>; advertised?: boolean | null; failed?: boolean } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const route = String(url);
    if (route.endsWith(`/account.move/${method}`)) {
      if (options.failed) return new Response("", { status: 403 });
      return Response.json(options.snapshot ?? {});
    }
    return Response.json(route.endsWith("/account.move/read")
      ? [{ id: 42, display_name: "[QA] Bill", move_type: options.moveType ?? "in_invoice" }] : []);
  });
  const context = { ...requestContext(), profile: "accounting" as const };
  const publicMethods = new Map(context.availablePublicMethods);
  if (options.advertised !== false && options.advertised !== null) publicMethods.set("account.move", new Set([method]));
  context.availablePublicMethods = options.advertised === null ? null : publicMethods;
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer(context);
  const client = new Client({ name: "purchase-attachment-context-qa", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  close.push(async () => { await client.close(); await server.close(); });
  return { client, fetcher };
}
const snapshot = {
  version: 1, bill_id: 42, needs_review: true,
  documents: [{ id: 91, name: "[QA] invoice.pdf", role: "invoice", is_main: true, separated_bill_ids: [] }],
  offset: 0, limit: 50, count: 55, complete: false, truncated: true, next_offset: 50,
  actions: { review: { model: "account.move", method: "action_review_mail_grouping", ids: [42] } }
};
async function read(client: Client) {
  return client.callTool({ name: "accounting_get_invoice_context", arguments: { move_id: 42, context: { allowed_company_ids: [2] } } });
}
describe("automatic relevant purchase attachment context", () => {
  it.each(["in_invoice", "in_refund"])("includes bounded native context automatically for %s", async (moveType) => {
    const { client, fetcher } = await connected({ moveType, snapshot });
    const result = await read(client);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { context: { purchase_attachments: snapshot } } });
    const native = fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/account.move/${method}`));
    expect(native).toHaveLength(1);
    expect(JSON.parse(String(native[0]![1]?.body))).toMatchObject({ ids: [42], offset: 0, limit: 50, context: { allowed_company_ids: [2] } });
    expect(fetcher.mock.calls.every(([url]) => !/write|create|action_|\/web\/content/.test(String(url)))).toBe(true);
    const billRead = fetcher.mock.calls.find(([url]) => String(url).endsWith("/account.move/read"));
    expect(JSON.parse(String(billRead![1]?.body)).fields).not.toContain("usl_mail_grouping");
  });
  it("omits purchase context for an ordinary ungrouped vendor bill", async () => {
    const { client } = await connected();
    const result = await read(client);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).data.context).not.toHaveProperty("purchase_attachments");
  });
  it.each(["out_invoice", "out_refund", "entry"])("does not call the purchase method for %s", async (moveType) => {
    const { client, fetcher } = await connected({ moveType, snapshot });
    const result = await read(client);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).data.context).not.toHaveProperty("purchase_attachments");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(method))).toBe(false);
  });
  it.each([false, null])("does not speculate when backend capability advertisement is %s", async (advertised) => {
    const { client, fetcher } = await connected({ advertised, snapshot });
    const result = await read(client);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).data.context).not.toHaveProperty("purchase_attachments");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(method))).toBe(false);
  });
  it("keeps invoice context available with a bounded warning if optional native context fails", async () => {
    const { client } = await connected({ failed: true });
    const result = await read(client);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).data.context.invoice.id).toBe(42);
    expect((result.structuredContent as any).warnings.join(" ")).toContain("Purchase attachment context was unavailable");
  });
});
