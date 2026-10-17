import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { isPublicSourceAddress, resolveSourceFile, SourceFileSchema } from "../../src/runtime/source_file.js";
import { requestContext } from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map(close => close())); });
async function source(content = Buffer.from("[QA] Exact evidence\0\xff")) {
  const root = await mkdtemp(join(tmpdir(), "qa-evidence-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "qa-source.pdf"); await writeFile(path, content);
  vi.stubEnv("MCP_EVIDENCE_FILE_ROOTS", root);
  return { root, content, file: { download_url: pathToFileURL(path).href, file_id: "qa-source", file_name: "qa-source.pdf", mime_type: "application/pdf" } };
}
function context() {
  const value = requestContext(); value.principal.authMode = "stdio";
  value.availablePublicMethods = new Map(value.availablePublicMethods);
  (value.availablePublicMethods as Map<string, ReadonlySet<string>>).set("hr.expense", new Set(["attach_source_evidence"]));
  (value.availablePublicMethods as Map<string, ReadonlySet<string>>).set("account.move", new Set(["attach_source_evidence"]));
  return value;
}
async function connected(fetcher: typeof fetch) {
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer(context());
  const client = new Client({ name: "qa-source-evidence", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanup.push(async () => { await client.close(); await server.close(); }); return client;
}

describe("source-file materialization", () => {
  it("advertises the complete host-injected file schema without model-call binary", async () => {
    const client = await connected(vi.fn<typeof fetch>());
    const tool = (await client.listTools()).tools.find(item => item.name === "documents_attach_source_evidence")!;
    expect(tool._meta?.["openai/fileParams"]).toEqual(["file"]);
    const file = (tool.inputSchema.properties as Record<string, any>).file;
    expect(Object.keys(file.properties)).toEqual(expect.arrayContaining(["download_url", "file_id", "mime_type", "file_name"]));
    expect(file.required).toEqual(["download_url", "file_id"]);
    expect(JSON.stringify(tool.inputSchema)).not.toContain("base64");
  });

  it.each(["hr.expense", "account.move"] as const)("hands exact local bytes to %s in one native mutation", async model => {
    const fixture = await source(); const hash = createHash("sha256").update(fixture.content).digest("hex");
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("/read")
      ? Response.json([{ id: 91, company_id: [1, "[QA] Company"] }])
      : Response.json({ source_attachment_id: false, source_document_id: false, attachment_id: 8, target_model: model, target_id: 91, filename: "qa-source.pdf", mimetype: "application/pdf",
        byte_size: fixture.content.length, sha256: hash, checksum: "qa-checksum", reused: false, mime_inferred: false,
        main_attachment_id: 8, uploaded_by_id: 7, uploaded_at: "2026-10-14 06:00:00", archive_state: "pending" }));
    const result = await (await connected(fetcher)).callTool({ name: "documents_attach_source_evidence", arguments: {
      file: fixture.file, target_model: model, target_id: 91, set_main_attachment: true,
    } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain(`/${model}/attach_source_evidence`);
    const payload = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(Buffer.from(payload.data_base64, "base64")).toEqual(fixture.content);
    expect(payload).toMatchObject({ ids: [91], sha256: hash, byte_size: fixture.content.length, set_main_attachment: true });
    expect(JSON.stringify(result)).toContain(`/odoo/${model}/91`);
    expect(JSON.stringify(result)).not.toContain(fixture.file.download_url);
    expect(payload).not.toHaveProperty("download_url"); expect(payload).not.toHaveProperty("file_id");
  });

  it.each(["source_attachment_id", "source_document_id"] as const)("copies %s in one native mutation without materializing a file", async field => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("/read")
      ? Response.json([{ id: 91 }])
      : Response.json({ source_attachment_id: field === "source_attachment_id" ? 19 : false,
        source_document_id: field === "source_document_id" ? 19 : false, attachment_id: 8,
        target_model: "hr.expense", target_id: 91, filename: "qa-source.pdf", mimetype: "application/pdf",
        byte_size: 20, sha256: "a".repeat(64), checksum: "b".repeat(40), reused: false, mime_inferred: false,
        main_attachment_id: 8, uploaded_by_id: 7, uploaded_at: "2026-10-17 01:00:00", archive_state: "pending" }));
    const result = await (await connected(fetcher)).callTool({ name: "documents_attach_source_evidence", arguments: {
      [field]: 19, target_model: "hr.expense", target_id: 91, set_main_attachment: true,
    } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(payload).toMatchObject({ ids: [91], [field]: 19, set_main_attachment: true });
    expect(payload).not.toHaveProperty("data_base64");
  });

  it("rejects missing or competing original sources before an Odoo call", async () => {
    const fixture = await source(); const fetcher = vi.fn<typeof fetch>(); const client = await connected(fetcher);
    for (const sources of [{}, { source_attachment_id: 19, source_document_id: 20 }, { file: fixture.file, source_attachment_id: 19 }]) {
      const result = await client.callTool({ name: "documents_attach_source_evidence", arguments: {
        ...sources, target_model: "hr.expense", target_id: 91,
      } });
      expect(result.isError).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uploads a 1 MiB source without expanding the generic JSON argument limit", async () => {
    const fixture = await source(Buffer.alloc(1024 * 1024, 81));
    const hash = createHash("sha256").update(fixture.content).digest("hex");
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("/read")
      ? Response.json([{ id: 91 }])
      : Response.json({ source_attachment_id: false, source_document_id: false, attachment_id: 8,
        target_model: "hr.expense", target_id: 91, filename: "qa-source.pdf", mimetype: "application/pdf",
        byte_size: fixture.content.length, sha256: hash, checksum: "b".repeat(40), reused: false, mime_inferred: false,
        main_attachment_id: false, uploaded_by_id: 7, uploaded_at: "2026-10-17 01:00:00", archive_state: "pending" }));
    const result = await (await connected(fetcher)).callTool({ name: "documents_attach_source_evidence", arguments: {
      file: fixture.file, target_model: "hr.expense", target_id: 91,
    } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(Buffer.from(payload.data_base64, "base64")).toEqual(fixture.content);
    await expect(new OdooClient(8, 1024 * 1024, fetcher).call(context(), "hr.expense", "write", {
      ids: [91], vals: { description: "x".repeat(256 * 1024) },
    }, { kind: "mutation", reconciliation: { targetModel: "hr.expense", suggestedTool: "odoo_read_records", instructions: "Read the target" } })).rejects.toThrow("262144-byte limit");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never retries an upload after ambiguous native completion", async () => {
    const fixture = await source();
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith("/read")) return Response.json([{ id: 91 }]);
      throw new TypeError("Connection closed");
    });
    const result = await (await connected(fetcher)).callTool({ name: "documents_attach_source_evidence", arguments: {
      file: fixture.file, target_model: "hr.expense", target_id: 91,
    } });
    expect(result.isError).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).toContain("unknown");
    expect(JSON.stringify(result)).not.toContain(fixture.file.download_url);
  });

  it("accepts a required-only file object with an explicit original filename fallback", async () => {
    const fixture = await source();
    const minimal = { download_url: fixture.file.download_url, file_id: fixture.file.file_id };
    const resolved = await resolveSourceFile(minimal, context(), new AbortController().signal, "qa-original.pdf");
    expect(resolved.bytes).toEqual(fixture.content);
    expect(resolved.filename).toBe("qa-original.pdf");
    expect(resolved.mimetype).toBeUndefined();
    await expect(resolveSourceFile(fixture.file, context(), new AbortController().signal, "renamed.pdf")).rejects.toThrow("contradicts");
  });

  it("does not resolve source bytes when the target read is denied", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ name: "odoo.exceptions.AccessError", message: "[QA] Denied" }, { status: 403 }));
    const result = await (await connected(fetcher)).callTool({ name: "documents_attach_source_evidence", arguments: {
      file: { download_url: "https://127.0.0.1/private?secret=hidden", file_id: "qa-file" }, target_model: "hr.expense", target_id: 91,
    } });
    expect(result.isError).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("secret=hidden");
  });

  it("rejects changed size/checksum, unset local roots and non-stdio local sources", async () => {
    const fixture = await source(); const ctx = context();
    await expect(resolveSourceFile({ ...fixture.file, byte_size: 1 }, ctx, new AbortController().signal)).rejects.toThrow("size or checksum");
    await expect(resolveSourceFile({ ...fixture.file, sha256: "0".repeat(64) }, ctx, new AbortController().signal)).rejects.toThrow("size or checksum");
    ctx.principal.authMode = "direct";
    await expect(resolveSourceFile(fixture.file, ctx, new AbortController().signal)).rejects.toThrow("Local files require stdio");
    ctx.principal.authMode = "stdio"; vi.stubEnv("MCP_EVIDENCE_FILE_ROOTS", "");
    await expect(resolveSourceFile(fixture.file, ctx, new AbortController().signal)).rejects.toThrow("Configure MCP_EVIDENCE_FILE_ROOTS");
  });

  it("rejects symlink escape without disclosing a private local path", async () => {
    const fixture = await source(); const outside = await mkdtemp(join(tmpdir(), "qa-private-source-"));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "private.pdf"), "[QA] Private");
    const link = join(fixture.root, "escape.pdf"); await symlink(join(outside, "private.pdf"), link);
    await expect(resolveSourceFile({ ...fixture.file, download_url: pathToFileURL(link).href }, context(), new AbortController().signal)).rejects.toThrow("outside the configured source roots");
  });

  it("rejects credentials, plain HTTP and private HTTPS source references", async () => {
    for (const url of ["https://user:password@example.test/file", "http://example.test/file", "https://127.0.0.1/file", "https://169.254.169.254/file"]) {
      await expect(resolveSourceFile({ download_url: url, file_id: "qa-file" }, context(), new AbortController().signal)).rejects.toThrow();
    }
    expect(SourceFileSchema.safeParse({ download_url: "https://example.test/file", file_id: "qa-file", data_base64: "private" }).success).toBe(false);
  });

  it("accepts public addresses and excludes private/mapped/metadata network addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicSourceAddress(address)).toBe(true);
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1", "172.16.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::1"]) expect(isPublicSourceAddress(address)).toBe(false);
  });
});
