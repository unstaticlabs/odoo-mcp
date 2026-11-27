import { createHash } from "node:crypto";
import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import { attributedContext, PositiveIdSchema } from "../odoo/schemas.js";
import { CapabilityInputError, type BinaryToolContent } from "../runtime/envelope.js";
import type { RequestContext } from "../runtime/context.js";

const MAX_BYTES = 4 * 1024 * 1024;
const FileSchema = z.object({
  document_id: PositiveIdSchema,
  document_version_id: PositiveIdSchema,
  variant: z.enum(["original", "archive"]),
  filename: z.string().min(1).max(1024),
  mime_type: z.string().min(1).max(255),
  size_bytes: z.number().int().min(1).max(MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_checksum_verified: z.enum(["sha256", "md5"]).nullable()
}).strict();
const NativeSchema = FileSchema.extend({ content_base64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4) });
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function readDocumentBinary(
  client: OdooClient,
  input: { document_id: number; document_version_id?: number; variant: "original" | "archive"; context: Record<string, unknown> },
  context: RequestContext,
  signal: AbortSignal
) {
  const methods = context.availablePublicMethods?.get("usl.document");
  if (methods && !methods.has("mcp_read_binary")) {
    throw new CapabilityInputError("ODOO_FEATURE_UNAVAILABLE", "This Odoo server does not support direct document files yet.", "Use the document download-URL workflow, or install the matching server revision. Ordinary text reads remain available.");
  }
  const raw = await client.call(context, "usl.document", "mcp_read_binary", {
    document_id: input.document_id, ...(input.document_version_id ? { document_version_id: input.document_version_id } : {}),
    variant: input.variant, context: attributedContext(input.context, context.correlationId)
  }, { signal, responseBytes: 6 * 1024 * 1024 });
  const parsed = NativeSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Document binary response was incomplete or invalid. No file was returned.");
  const { content_base64, ...file } = parsed.data;
  const bytes = Buffer.from(content_base64, "base64");
  if (bytes.toString("base64") !== content_base64 || bytes.length !== file.size_bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256 || file.document_id !== input.document_id || file.variant !== input.variant || (input.document_version_id && file.document_version_id !== input.document_version_id)) {
    throw new Error("Document binary response failed integrity or version verification. No file was returned.");
  }
  const binaryContent: BinaryToolContent[] = IMAGE_TYPES.has(file.mime_type)
    ? [{ type: "image", mimeType: file.mime_type, data: content_base64 }]
    : [{ type: "resource", resource: { uri: `odoo-document://${file.document_id}/${file.document_version_id}/${file.variant}`, mimeType: file.mime_type, blob: content_base64 } }];
  return { data: { result: file }, binaryContent };
}
