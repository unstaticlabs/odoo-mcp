import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestContext } from "./fixtures.js";

const io = vi.hoisted(() => ({ responses: [] as Array<{ status?: number; headers?: Record<string, string>; content?: Buffer; error?: boolean }>, calls: [] as Array<{ url: URL; options: any }> }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (host: string) => [{ address: host === "127.0.0.1" ? host : "8.8.8.8", family: 4 }]) }));
vi.mock("node:https", () => ({ request: (url: URL, options: any, callback: (response: any) => void) => {
  io.calls.push({ url, options }); const spec = io.responses.shift();
  if (!spec) throw new Error("[QA] Unexpected request");
  const req: any = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => req.emit("error", new Error("[QA] Transfer failed"));
  req.end = () => queueMicrotask(() => {
    const res: any = new EventEmitter(); res.statusCode = spec.status ?? 200; res.headers = spec.headers ?? {};
    res.resume = () => undefined; res.destroy = () => { res.destroyed = true; };
    callback(res);
    queueMicrotask(() => {
      if (res.destroyed) return;
      if (spec.error) return res.emit("error", new Error("[QA] Interrupted"));
      if (spec.content) res.emit("data", spec.content);
      res.emit("end");
    });
  }); return req;
} }));
import { MAX_SOURCE_FILE_BYTES, resolveSourceFile } from "../../src/runtime/source_file.js";

afterEach(() => { io.responses.splice(0); io.calls.splice(0); });
const file = { download_url: "https://files.example.test/source?token=qa-secret", file_id: "qa-runtime-file" };
const signal = () => new AbortController().signal;

describe("bounded exact HTTPS file transfer", () => {
  it("pins DNS, forwards no Odoo credentials and preserves response filename/MIME/bytes", async () => {
    const content = Buffer.from("[QA] Binary\0\xff");
    io.responses.push({ headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="qa-source.pdf"', "content-length": String(content.length) }, content });
    const result = await resolveSourceFile(file, requestContext(), signal());
    expect(result.bytes).toEqual(content); expect(result.filename).toBe("qa-source.pdf"); expect(result.mimetype).toBe("application/pdf");
    expect(io.calls).toHaveLength(1); expect(io.calls[0]!.options.headers).toEqual({ "Accept-Encoding": "identity" });
    const callback = vi.fn(); io.calls[0]!.options.lookup("files.example.test", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(JSON.stringify(result)).not.toContain("qa-secret");
  });
  it("revalidates every redirect and refuses a private redirect without requesting it", async () => {
    io.responses.push({ status: 302, headers: { location: "https://127.0.0.1/private?secret=qa-hidden" } });
    await expect(resolveSourceFile(file, requestContext(), signal())).rejects.toThrow("public file host");
    expect(io.calls).toHaveLength(1);
  });
  it("uses connector original metadata before generic transfer headers", async () => {
    const content = Buffer.from("%PDF-1.4\n[QA]\n%%EOF\n");
    io.responses.push({ headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="qa-source.pdf"' }, content });
    const resolved = await resolveSourceFile(file, requestContext(), signal());
    expect(resolved.mimetype).toBeUndefined(); expect(resolved.bytes).toEqual(content);
    io.responses.push({ headers: { "content-type": "application/x-download" }, content });
    const declared = await resolveSourceFile({ ...file, file_name: "qa-source.pdf", mime_type: "application/pdf" }, requestContext(), signal());
    expect(declared.mimetype).toBe("application/pdf"); expect(declared.bytes).toEqual(content);
    io.responses.push({ headers: { "content-disposition": 'attachment; filename="download"' }, content });
    const original = await resolveSourceFile({ ...file, file_name: "qa-original.pdf" }, requestContext(), signal());
    expect(original.filename).toBe("qa-original.pdf"); expect(original.bytes).toEqual(content);
  });
  it("follows a bounded public redirect to the exact original bytes", async () => {
    const content = Buffer.from("[QA] Original");
    io.responses.push({ status: 307, headers: { location: "/authorized-file" } }, { headers: { "content-type": "application/pdf" }, content });
    const result = await resolveSourceFile({ ...file, file_name: "qa-original.pdf" }, requestContext(), signal());
    expect(result.bytes).toEqual(content); expect(io.calls).toHaveLength(2);
  });
  it("bounds redirect chains", async () => {
    for (let i = 0; i < 4; i++) io.responses.push({ status: 302, headers: { location: "/again" } });
    await expect(resolveSourceFile(file, requestContext(), signal())).rejects.toThrow("redirect is unavailable");
    expect(io.calls).toHaveLength(4);
  });
  it.each([
    { headers: { "content-length": "100" }, content: Buffer.from("[QA] Truncated") },
    { headers: {}, error: true },
  ])("rejects incomplete source transfer without returning partial bytes", async response => {
    io.responses.push(response);
    await expect(resolveSourceFile(file, requestContext(), signal())).rejects.toThrow(/did not finish/);
    expect(io.calls).toHaveLength(1);
  });
  it("rejects expired references and oversized or encoded responses without exposing the URL", async () => {
    for (const response of [
      { status: 403 }, { headers: { "content-length": String(MAX_SOURCE_FILE_BYTES + 1) } },
      { headers: { "content-encoding": "gzip" } },
    ]) {
      io.responses.push(response);
      let error: unknown;
      try { await resolveSourceFile(file, requestContext(), signal()); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("qa-secret");
    }
    expect(io.calls).toHaveLength(3);
  });
});
