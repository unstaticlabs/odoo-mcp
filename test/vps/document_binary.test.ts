import { createHash } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=", "base64");
const native = { document_id: 17, document_version_id: 21, variant: "original", filename: "synthetic-evidence.png", mime_type: "image/png", size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), source_checksum_verified: "sha256", content_base64: bytes.toString("base64") };
async function call(response: unknown, run: (result: Awaited<ReturnType<Client["callTool"]>>, fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => void, options: { nativeBinary?: boolean; arguments?: Record<string, unknown> } = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
  const context = requestContext("read_only");
  context.availablePublicMethods = new Map(context.availablePublicMethods);
  if (options.nativeBinary === false) context.availablePublicMethods.set("usl.document", new Set([...context.availablePublicMethods.get("usl.document")!].filter(method => method !== "mcp_read_binary")));
  else context.availablePublicMethods.set("usl.document", new Set([...context.availablePublicMethods.get("usl.document")!, "mcp_read_binary"]));
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({ ...context, profile: "documents" });
  const client = new Client({ name: "synthetic-document-bytes", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try { run(await client.callTool({ name: "documents_get_content", arguments: options.arguments ?? { document_id: 17, binary: { document_version_id: 21 }, context: { allowed_company_ids: [1] } } }), fetcher); }
  finally { await client.close(); await server.close(); }
}
describe("read exact authorized document bytes", () => {
  it("makes the existing content tool discoverable for original receipt images", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    expect(registry.search("read original receipt image", 5).map(item => item.metadata.name)).toContain("documents_get_content");
  });
  it("returns a real image content block and bounded metadata without a second URL", async () => {
    await call(native, (result, fetcher) => {
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
      expect(result.structuredContent).toMatchObject({ data: { result: { document_id: 17, document_version_id: 21, sha256: native.sha256 } } });
      expect(JSON.stringify(result.structuredContent)).not.toContain("content_base64");
      expect(JSON.stringify(result)).not.toContain("agent-documents/");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/usl.document\/mcp_read_binary$/);
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ document_id: 17, document_version_id: 21, variant: "original", context: { allowed_company_ids: [1] } });
    });
  });
  it("returns PDF bytes as an embedded resource rather than claiming image visibility", async () => {
    const pdf = Buffer.from("%PDF-1.4\nSynthetic evidence\n%%EOF");
    await call({ ...native, filename: "qa.pdf", mime_type: "application/pdf", size_bytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), content_base64: pdf.toString("base64") }, result => {
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual({ type: "resource", resource: { uri: "odoo-document://17/21/original", mimeType: "application/pdf", blob: pdf.toString("base64") } });
      expect(result.content.some(item => item.type === "image")).toBe(false);
    });
  });
  it("keeps legacy paginated text as one unchanged native read on an older server", async () => {
    await call({ document_id: 17, content: "Synthetic OCR", has_more: false }, (result, fetcher) => {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { result: { content: "Synthetic OCR" } } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/usl.document\/mcp_get_content$/);
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ document_id: 17, offset: 2, limit: 10 });
    }, { nativeBinary: false, arguments: { document_id: 17, offset: 2, limit: 10 } });
  });
  it("explains unavailable binary support without fetching or silently returning OCR", async () => {
    await call(native, (result, fetcher) => {
      expect(result.isError).toBe(true);
      const text = result.content.find(item => item.type === "text");
      expect(text?.type === "text" ? JSON.parse(text.text) : null).toMatchObject({ error: { code: "ODOO_FEATURE_UNAVAILABLE" } });
      expect(fetcher).not.toHaveBeenCalled();
    }, { nativeBinary: false });
  });
  it("does not return bytes of a different selected version", async () => {
    await call({ ...native, document_version_id: 22 }, result => {
      expect(result.isError).toBe(true);
      expect(result.content.every(item => item.type === "text")).toBe(true);
    });
  });
  it("does not return binary content when received bytes fail integrity", async () => {
    await call({ ...native, sha256: "0".repeat(64) }, result => {
      expect(result.isError).toBe(true);
      expect(result.content.every(item => item.type === "text")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    });
  });
});
