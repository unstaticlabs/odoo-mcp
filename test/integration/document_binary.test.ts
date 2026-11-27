import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;
const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
const fixture = JSON.parse(process.env.ODOO_DOCUMENT_BINARY_QA ?? "null") as null | {
  company_id: number; other_company_id: number; task_id: number; foreign_document_id: number;
  documents: Array<{ document_id: number; version_id: number; sha256: string; size_bytes: number; mime_type: string; archive: { sha256: string; size_bytes: number } }>;
};
const configured = Boolean(origin && database && apiKey && fixture?.documents.length === 2);
const withdrawn = process.env.ODOO_DOCUMENT_BINARY_QA_PHASE === "after_withdrawal";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
async function connected() {
  if (!origin || !database || !apiKey) throw new Error("Synthetic document fixture is not configured");
  const context: RequestContext = { requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), profile: "documents",
    principal: { targetId: "document-bytes-qa", publicOrigin: origin, internalOrigin: origin, database, apiKey, authMode: "direct" } };
  const odoo = new OdooClient(); const cache = new AgentAccessSnapshotCache(odoo);
  const snapshot = await cache.initialize(context);
  context.agentIdentity = snapshot.identity; context.availableModules = snapshot.surface?.modules ?? null;
  context.availablePublicMethods = snapshot.surface?.publicMethods ?? null; context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
  const server = createCapabilityRegistry(odoo).createServer(context);
  const client = new Client({ name: "synthetic-document-bytes", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  cleanup.push(async () => { await client.close(); await server.close(); await cache.close(); }); return client;
}
const scope = () => ({ allowed_company_ids: [fixture!.company_id] });
function received(result: Awaited<ReturnType<Client["callTool"]>>) {
  const image = result.content.find(item => item.type === "image");
  if (image?.type === "image") return Buffer.from(image.data, "base64");
  const resource = result.content.find(item => item.type === "resource");
  if (resource?.type === "resource" && "blob" in resource.resource && typeof resource.resource.blob === "string") return Buffer.from(resource.resource.blob, "base64");
  throw new Error("No binary content was received");
}
describe.skipIf(!configured || withdrawn)("live direct document bytes", () => {
  it("finds the two linked originals and their version-specific integrity context", async () => {
    const client = await connected();
    const search = await client.callTool({ name: "documents_search", arguments: { linked_model: "project.task", linked_id: fixture!.task_id, context: scope() } });
    expect(search.isError).not.toBe(true);
    const rows = (search.structuredContent as { data: { result: { results: Array<{ id: number }> } } }).data.result.results;
    expect(rows.map(row => row.id).sort()).toEqual(fixture!.documents.map(doc => doc.document_id).sort());
    const doc = fixture!.documents[0]!;
    const context = await client.callTool({ name: "documents_get_context", arguments: { document_id: doc.document_id, include_integrity: true, context: scope() } });
    expect(context.isError).not.toBe(true);
    expect(context.structuredContent).toMatchObject({ data: { context: { versions: expect.arrayContaining([expect.objectContaining({ id: doc.version_id, integrity: { original: { algorithm: "sha256", digest: doc.sha256, size_bytes: doc.size_bytes }, archive: expect.any(Object) } })]) } } });
  }, 60_000);
  it("receives exact PDF and PNG bytes through authenticated native reads despite incomplete OCR", async () => {
    const client = await connected();
    for (const [index, doc] of fixture!.documents.entries()) {
      const text = await client.callTool({ name: "documents_get_content", arguments: { document_id: doc.document_id, context: scope() } });
      expect(text.isError).not.toBe(true);
      expect(text.structuredContent).toMatchObject({ data: { result: { content: "QA incomplete OCR" } } });
      const file = await client.callTool({ name: "documents_get_content", arguments: { document_id: doc.document_id, binary: { document_version_id: doc.version_id }, context: scope() } });
      expect(file.isError).not.toBe(true);
      const bytes = received(file);
      expect(bytes.length).toBe(doc.size_bytes); expect(createHash("sha256").update(bytes).digest("hex")).toBe(doc.sha256);
      expect(file.structuredContent).toMatchObject({ data: { result: { document_id: doc.document_id, document_version_id: doc.version_id, source_checksum_verified: "sha256" } } });
      expect(file.structuredContent).not.toHaveProperty("data.result.content_base64");
      if (doc.mime_type === "image/png") expect(file.content.some(item => item.type === "image")).toBe(true);
      else expect(file.content.some(item => item.type === "resource")).toBe(true);
      const output = process.env.ODOO_DOCUMENT_BINARY_QA_OUTPUT;
      if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, `received-original-${index + 1}.${doc.mime_type === "image/png" ? "png" : "pdf"}`), bytes); }
    }
  }, 60_000);
  it("distinguishes the archive PDF from the original image bytes", async () => {
    const client = await connected(); const doc = fixture!.documents[1]!;
    const result = await client.callTool({ name: "documents_get_content", arguments: { document_id: doc.document_id, binary: { document_version_id: doc.version_id, variant: "archive" }, context: scope() } });
    expect(result.isError).not.toBe(true);
    const bytes = received(result); expect(bytes.length).toBe(doc.archive.size_bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(doc.archive.sha256);
    expect(result.structuredContent).toMatchObject({ data: { result: { variant: "archive", mime_type: "application/pdf" } } });
  }, 60_000);
  it("returns no file or file metadata for a foreign company even with crafted company context", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "documents_get_content", arguments: { document_id: fixture!.foreign_document_id, binary: {}, context: { allowed_company_ids: [fixture!.company_id, fixture!.other_company_id] } } });
    expect(result.isError).toBe(true); expect(result.content.every(item => item.type === "text")).toBe(true);
    expect(result.structuredContent ?? {}).not.toHaveProperty("data.result");
  }, 60_000);
});
// An authorized fixture owner removes the native share between these opt-in runs.
// This suite itself only reads; it never changes sharing or archive permissions.
describe.skipIf(!configured || !withdrawn)("live direct document withdrawal", () => {
  it("returns no previously shared file after native withdrawal", async () => {
    const client = await connected(); const doc = fixture!.documents[0]!;
    const result = await client.callTool({ name: "documents_get_content", arguments: { document_id: doc.document_id, binary: { document_version_id: doc.version_id }, context: scope() } });
    expect(result.isError).toBe(true); expect(result.content.every(item => item.type === "text")).toBe(true);
    expect(result.structuredContent ?? {}).not.toHaveProperty("data.result");
  }, 60_000);
  it("returns no context or integrity metadata for the withdrawn file", async () => {
    const client = await connected(); const doc = fixture!.documents[0]!;
    const result = await client.callTool({ name: "documents_get_context", arguments: { document_id: doc.document_id, include_integrity: true, context: scope() } });
    expect(result.isError).toBe(true); expect(result.structuredContent ?? {}).not.toHaveProperty("data.context");
  }, 60_000);
});
