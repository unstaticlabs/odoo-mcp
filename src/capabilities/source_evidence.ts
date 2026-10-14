import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import { attributedContext, OdooContextSchema, PositiveIdSchema } from "../odoo/schemas.js";
import { resolveSourceFile, SourceFileSchema } from "../runtime/source_file.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const Result = z.object({
  attachment_id: PositiveIdSchema, target_model: z.enum(["hr.expense", "account.move"]),
  target_id: PositiveIdSchema, filename: z.string(), mimetype: z.string(),
  mime_inferred: z.boolean(),
  byte_size: z.number().int().positive(), sha256: z.string(), checksum: z.string(),
  reused: z.boolean(), main_attachment_id: z.union([PositiveIdSchema, z.literal(false)]),
  uploaded_by_id: PositiveIdSchema, uploaded_at: z.string(), archive_state: z.string(),
}).strict();

export function registerSourceEvidenceCapability(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "documents.source_evidence.attach", name: "documents_attach_source_evidence",
    title: "Attach Source Evidence",
    description: "Attach the exact bytes of one connector-supplied file to an existing expense or accounting entry. Preserves filename, MIME and checksum; optionally selects the main attachment. Does not submit, post or pay. Expired references require a fresh file reference; unknown upload outcomes require native readback before retry.",
    layer: "business_action", toolsets: ["documents", "expenses", "accounting"], profiles: ["documents", "accounting"],
    effect: "write", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    keywords: ["receipt", "upload", "file", "evidence", "attachment", "expense", "invoice"],
    requiredModules: ["usl_documents"], requiredAnyPublicMethods: ["attach_source_evidence"],
    defaultVisible: true, alwaysLoad: false, sortOrder: 266, fileParams: ["file"],
    input: z.object({
      file: SourceFileSchema, target_model: z.enum(["hr.expense", "account.move"]), target_id: PositiveIdSchema,
      original_filename: z.string().min(1).max(255).optional().describe("Original filename fallback only when the connector and download response omit it."),
      set_main_attachment: z.boolean().default(false), context: OdooContextSchema,
    }).strict(),
    output: z.object({
      result: Result, outcome: z.literal("succeeded"), correlation_id: z.string(),
      record: z.object({ model: z.string(), id: PositiveIdSchema, display_name: z.string(), url: z.string() }).strict(),
    }).strict(),
    async handler(input, context, signal) {
      if (context.availablePublicMethods && !context.availablePublicMethods.get(input.target_model)?.has("attach_source_evidence")) {
        throw new Error("Source evidence upload is unavailable for this target; check its native application access");
      }
      const common = attributedContext(input.context, context.correlationId);
      // Native preflight comes before resolving a private source file. The
      // mutation repeats authority checks in its own transaction.
      const targets = await client.call<Array<{ id: number }>>(context, input.target_model, "read", {
        ids: [input.target_id], fields: ["id", "company_id"], context: common,
      }, { signal });
      if (!targets.some(target => target.id === input.target_id)) throw new Error("The evidence target is unavailable");
      const file = await resolveSourceFile(input.file, context, signal, input.original_filename);
      const receipt = await client.call(context, input.target_model, "attach_source_evidence", {
        ids: [input.target_id], filename: file.filename, mimetype: file.mimetype ?? false,
        data_base64: file.bytes.toString("base64"), sha256: file.sha256, byte_size: file.bytes.length,
        set_main_attachment: input.set_main_attachment, context: common,
      }, { kind: "mutation", signal, reconciliation: {
        targetModel: "ir.attachment", fields: ["res_model", "res_id", "name", "file_size", "checksum"],
        suggestedTool: "odoo_search_records",
        instructions: "Read attachments on the original target and compare source filename, byte size and checksum; inspect its main attachment. Do not replay an upload with unknown completion automatically.",
      } });
      return receipt.finalize(value => ({ data: {
        result: Result.parse(value), outcome: "succeeded" as const, correlation_id: context.correlationId,
        record: { model: input.target_model, id: input.target_id, display_name: `${input.target_model},${input.target_id}`,
          url: `${context.principal.publicOrigin}/odoo/${input.target_model}/${input.target_id}` },
      } }));
    },
  }));
}
