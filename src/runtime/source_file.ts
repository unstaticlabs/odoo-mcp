import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { open, realpath } from "node:fs/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { delimiter, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RequestContext } from "./context.js";

export const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024;
export const SourceFileSchema = z.object({
  download_url: z.string().min(1).max(8192),
  file_id: z.string().min(1).max(512),
  mime_type: z.string().min(1).max(255).optional(),
  file_name: z.string().min(1).max(255).optional(),
  byte_size: z.number().int().positive().max(MAX_SOURCE_FILE_BYTES).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export interface ResolvedSourceFile {
  filename: string;
  mimetype?: string;
  bytes: Buffer;
  sha256: string;
}

const forbidden = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) forbidden.addSubnet(address, prefix, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]] as const) {
  forbidden.addSubnet(address, prefix, "ipv6");
}

export function isPublicSourceAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !forbidden.check(address, "ipv4")
    : family === 6 && globalIpv6.check(address, "ipv6") && !forbidden.check(address, "ipv6");
}

function sourceUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The source file reference is invalid"); }
  if (url.username || url.password || url.hash) throw new Error("The source file reference is invalid");
  return url;
}

async function localFile(url: URL, context: RequestContext, signal: AbortSignal): Promise<Buffer> {
  if (context.principal.authMode !== "stdio") {
    throw new Error("Local files require stdio with explicitly configured source roots");
  }
  const roots = (process.env.MCP_EVIDENCE_FILE_ROOTS ?? "").split(delimiter).filter(Boolean);
  if (!roots.length) throw new Error("Configure MCP_EVIDENCE_FILE_ROOTS before handing off a local file");
  const filename = await realpath(fileURLToPath(url)).catch(() => { throw new Error("The local source file is unavailable"); });
  const allowed = await Promise.all(roots.map(async root => {
    const resolvedRoot = await realpath(root).catch(() => { throw new Error("A configured local source root is unavailable"); });
    const child = relative(resolvedRoot, filename);
    return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
  }));
  if (!allowed.some(Boolean)) throw new Error("The local source file is outside the configured source roots");
  const handle = await open(filename, "r").catch(() => { throw new Error("The local source file is unavailable"); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOURCE_FILE_BYTES) {
      throw new Error("Source evidence must contain between one byte and 20 MiB");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error("The local source changed during handoff; try the original file again");
    }
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function remoteFile(url: URL, signal: AbortSignal, remaining = 3): Promise<{ bytes: Buffer; mime?: string; filename?: string }> {
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
    throw new Error("Connector source files require an HTTPS download reference");
  }
  const addresses = await lookup(url.hostname, { all: true }).catch(() => { throw new Error("The source file host is unavailable"); });
  if (!addresses.length || addresses.some(item => !isPublicSourceAddress(item.address))) {
    throw new Error("The source file reference must resolve to a public file host");
  }
  const pinned = addresses[0]!;
  return await new Promise((resolve, reject) => {
    const req = request(url, {
      signal, agent: false, headers: { "Accept-Encoding": "identity" },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (!remaining || !res.headers.location) return reject(new Error("The source file redirect is unavailable"));
        let next: URL;
        try { next = sourceUrl(new URL(res.headers.location, url).href); }
        catch { return reject(new Error("The source file redirect is invalid")); }
        void remoteFile(next, signal, remaining - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume(); reject(new Error("The source file is unavailable or its download reference expired")); return;
      }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        res.resume(); reject(new Error("The file host changed the transfer encoding; provide the original file")); return;
      }
      const expected = res.headers["content-length"];
      if (expected && (!/^\d+$/.test(expected) || Number(expected) > MAX_SOURCE_FILE_BYTES)) {
        res.destroy(); reject(new Error("Source evidence is limited to 20 MiB")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SOURCE_FILE_BYTES) { res.destroy(); reject(new Error("Source evidence is limited to 20 MiB")); }
        else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("The source file transfer did not finish; no evidence was uploaded")));
      res.on("end", () => {
        if (!size || (expected && size !== Number(expected))) return reject(new Error("The source file transfer did not finish; no evidence was uploaded"));
        const disposition = res.headers["content-disposition"] ?? "";
        const filename = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1];
        const mime = res.headers["content-type"]?.split(";", 1)[0]?.trim();
        resolve({ bytes: Buffer.concat(chunks), ...(mime ? { mime } : {}), ...(filename ? { filename } : {}) });
      });
    });
    req.setTimeout(30_000, () => req.destroy());
    req.on("error", () => reject(new Error("The source file transfer failed; refresh its download reference")));
    req.end();
  });
}

export async function resolveSourceFile(file: z.infer<typeof SourceFileSchema>, context: RequestContext, signal: AbortSignal, originalFilename?: string): Promise<ResolvedSourceFile> {
  const url = sourceUrl(file.download_url);
  const source = url.protocol === "file:" ? { bytes: await localFile(url, context, signal) } : await remoteFile(url, signal);
  const responseFilename = "filename" in source ? source.filename : undefined;
  const filename = file.file_name ?? responseFilename ?? originalFilename;
  if (!filename) throw new Error("Provide original_filename when the file reference has no source filename");
  if ((originalFilename && originalFilename !== filename) || (file.file_name && responseFilename && file.file_name !== responseFilename)) {
    throw new Error("The declared source filename contradicts the original file; use its original filename");
  }
  const specificMime = (value: string | undefined) => value && value.toLowerCase() !== "application/octet-stream" ? value.toLowerCase() : undefined;
  const declaredMime = specificMime(file.mime_type);
  const responseMime = specificMime("mime" in source ? source.mime : undefined);
  if (declaredMime && responseMime && declaredMime !== responseMime) {
    throw new Error("The declared source MIME type contradicts the file response; provide the original file");
  }
  const mimetype = declaredMime ?? responseMime;
  const sha256 = createHash("sha256").update(source.bytes).digest("hex");
  if ((file.byte_size !== undefined && file.byte_size !== source.bytes.length) || (file.sha256 !== undefined && file.sha256 !== sha256)) {
    throw new Error("The source file size or checksum changed; provide the original file");
  }
  return { filename, ...(mimetype ? { mimetype } : {}), bytes: source.bytes, sha256 };
}
