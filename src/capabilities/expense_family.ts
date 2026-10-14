import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import { attributedContext, OdooContextSchema, PositiveIdSchema } from "../odoo/schemas.js";
import type { RequestContext } from "../runtime/context.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const OptionalRelation = z.union([PositiveIdSchema, z.literal(false)]).optional();
const MappingFields = {
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
  product_id: OptionalRelation, account_id: OptionalRelation,
  tax_ids: z.array(PositiveIdSchema).max(50).optional(),
  analytic_distribution: z.record(z.string(), z.number().finite().nonnegative()).optional()
};
const SplitLine = z.object({ ...MappingFields, total_amount_currency: z.number().finite() }).strict();
const FamilyLine = z.object({ expense_id: PositiveIdSchema, values: z.object({
  ...MappingFields, expense_batch_id: OptionalRelation, vendor_id: OptionalRelation,
  existing_bill_id: OptionalRelation, has_existing_bill: z.boolean().optional()
}).strict() }).strict();
const NativeRecord = z.record(z.string(), z.unknown());
const Reference = z.object({ model: z.string(), id: PositiveIdSchema, display_name: z.string(), url: z.string() }).strict();
const Result = z.object({
  outcome: z.literal("succeeded"), correlation_id: z.string(), origin_id: PositiveIdSchema,
  source: Reference, records: z.array(Reference).min(2).max(50), expenses: z.array(NativeRecord).min(2).max(50),
}).strict();
const SplitResult = Result.extend({ before_total: z.number(), after_total: z.number(), currency_id: PositiveIdSchema });
const FamilyResult = Result.extend({ totals: z.array(z.object({
  currency_id: PositiveIdSchema, before_total: z.number(), after_total: z.number()
}).strict()).min(1).max(50) });
interface NativeReply {
  origin_id: number; expenses: Array<Record<string, unknown>>;
  before_total?: number; after_total?: number; currency_id?: number;
  totals?: Array<{ currency_id: number; before_total: number; after_total: number }>;
}
function record(context: RequestContext, id: number, name?: unknown) {
  return { model: "hr.expense", id, display_name: typeof name === "string" ? name : `hr.expense,${id}`,
    url: `${context.principal.publicOrigin}/odoo/hr.expense/${id}` };
}
function output(reply: NativeReply, context: RequestContext, sourceId: number) {
  return { data: {
    ...reply, outcome: "succeeded" as const, correlation_id: context.correlationId,
    source: record(context, sourceId, reply.expenses.find((part) => part.id === sourceId)?.display_name),
    records: reply.expenses.map((part) => record(context, Number(part.id), part.display_name))
  } };
}
const metadata = {
  layer: "business_action" as const, toolsets: ["expenses", "accounting"], profiles: ["accounting"] as const,
  effect: "write" as const,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  requiredModules: ["hr_expense", "usl_expense_batch"],
  requiredModelAccess: [{ model: "hr.expense", operation: "write" as const }],
  defaultVisible: true, alwaysLoad: false
};

export function registerExpenseFamilyCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    ...metadata, id: "expenses.draft.split", name: "expenses_split_draft", title: "Split Draft Expense",
    description: "Split one draft into explicit gross parts through the native wizard. Totals must match at currency precision. Preserves source defaults and evidence; never posts or pays. Read the result before any retry.",
    keywords: ["expense", "split", "gross", "import VAT", "duty"], sortOrder: 264,
    requiredPublicMethods: [{ model: "hr.expense", method: "split_draft_expense" }], output: SplitResult,
    input: z.object({ expense_id: PositiveIdSchema, lines: z.array(SplitLine).min(2).max(50), context: OdooContextSchema }).strict(),
    async handler(input, context, signal) {
      const receipt = await client.call<NativeReply>(context, "hr.expense", "split_draft_expense", {
        ids: [input.expense_id], lines: input.lines, context: attributedContext(input.context, context.correlationId)
      }, { kind: "mutation", signal, reconciliation: {
        targetModel: "hr.expense", knownIds: [input.expense_id],
        fields: ["split_expense_origin_id", "total_amount_currency", "currency_id", "state"], suggestedTool: "odoo_search_read",
        instructions: "Read the source split origin, then search hr.expense for that origin in the allowed companies and compare every part and gross total. Never replay an unknown split automatically."
      } });
      return receipt.finalize((reply) => ({ data: SplitResult.parse(output(reply, context, input.expense_id).data) }));
    }
  }));
  registry.add(defineCapability({
    ...metadata, id: "expenses.draft.family.configure", name: "expenses_correct_draft_family", title: "Correct Draft Expense Family",
    description: "Explicitly correct company/employee for every named draft split part in one transaction, with per-part mappings or clears. Requires the complete authorized family; preserves document amounts and evidence, and never posts or pays.",
    keywords: ["expense", "split", "family", "company", "employee", "correction"], sortOrder: 265,
    requiredPublicMethods: [{ model: "hr.expense", method: "configure_draft_expense_family" }], output: FamilyResult,
    input: z.object({ expense_id: PositiveIdSchema, expense_ids: z.array(PositiveIdSchema).min(2).max(50),
      company_id: PositiveIdSchema, employee_id: PositiveIdSchema, lines: z.array(FamilyLine).min(2).max(50), context: OdooContextSchema }).strict(),
    async handler(input, context, signal) {
      const receipt = await client.call<NativeReply>(context, "hr.expense", "configure_draft_expense_family", {
        ids: [input.expense_id], expense_ids: input.expense_ids, company_id: input.company_id,
        employee_id: input.employee_id, lines: input.lines, context: attributedContext(input.context, context.correlationId)
      }, { kind: "mutation", signal, reconciliation: {
        targetModel: "hr.expense", knownIds: input.expense_ids,
        fields: ["company_id", "employee_id", "account_id", "tax_ids", "analytic_distribution", "expense_batch_id", "currency_id", "total_amount_currency", "state"],
        suggestedTool: "odoo_read_records",
        instructions: "Read every named part in both allowed companies and compare ownership, mappings and document totals. Do not replay the family correction automatically after unknown completion."
      } });
      return receipt.finalize((reply) => ({ data: FamilyResult.parse(output(reply, context, input.expense_id).data) }));
    }
  }));
}
