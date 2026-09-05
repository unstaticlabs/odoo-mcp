import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import {
  attributedContext,
  ModelNameSchema,
  OdooContextSchema,
  PositiveIdSchema
} from "../odoo/schemas.js";
import type { RequestContext } from "../runtime/context.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const RecordSchema = z.record(z.string(), z.unknown());
const RecordsSchema = z.array(RecordSchema);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const actionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const ActionOutputSchema = z.object({
  result: z.unknown(),
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "requires_follow_up", "unknown"]),
  record: z.object({
    model: z.string(), id: z.number().int(), display_name: z.string(), url: z.string()
  }).strict().optional()
}).strict();

const RelatedRecordSchema = z.object({
  id: PositiveIdSchema,
  name: z.string()
}).strict().nullable();
const VendorBillConfigurationResultSchema = z.object({
  bill: z.object({
    id: PositiveIdSchema,
    display_name: z.string(),
    move_type: z.enum(["in_invoice", "in_refund"]),
    state: z.literal("draft"),
    company: RelatedRecordSchema,
    partner: RelatedRecordSchema,
    currency: RelatedRecordSchema,
    invoice_date: DateSchema.nullable(),
    accounting_date: DateSchema.nullable(),
    invoice_date_due: DateSchema.nullable(),
    reference: z.string().nullable(),
    review_state: z.enum(["no_review", "todo", "reviewed", "supervised", "anomaly"]),
    amount_untaxed: z.number(),
    amount_tax: z.number(),
    amount_total: z.number()
  }).strict(),
  invoice_lines: z.array(z.object({
    id: PositiveIdSchema,
    name: z.string(),
    product: RelatedRecordSchema,
    account: RelatedRecordSchema,
    quantity: z.number(),
    price_unit: z.number(),
    discount: z.number(),
    tax_ids: z.array(PositiveIdSchema),
    analytic_distribution: z.record(z.string(), z.number()),
    price_subtotal: z.number(),
    price_total: z.number()
  }).strict()).max(500),
  tax_lines: z.array(z.object({
    id: PositiveIdSchema,
    name: z.string(),
    account: RelatedRecordSchema,
    tax: RelatedRecordSchema,
    balance: z.number(),
    amount_currency: z.number()
  }).strict()).max(500),
  payable_lines: z.array(z.object({
    id: PositiveIdSchema,
    name: z.string(),
    account: RelatedRecordSchema,
    date_maturity: DateSchema.nullable(),
    balance: z.number(),
    amount_currency: z.number()
  }).strict()).max(100)
}).strict();
const VendorBillConfigurationOutputSchema = z.object({
  result: VendorBillConfigurationResultSchema,
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "unknown"]),
  record: z.object({
    model: z.string(), id: z.number().int(), display_name: z.string(), url: z.string()
  }).strict()
}).strict();

function rpcContext(requested: Record<string, unknown>, context: RequestContext) {
  return attributedContext(requested, context.correlationId);
}

function recordRef(context: RequestContext, model: string, id: number, name?: string) {
  return {
    model,
    id,
    display_name: name?.trim() || `${model},${id}`,
    url: `${context.principal.publicOrigin}/odoo/${model}/${id}`
  };
}

function createdId(value: unknown): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!Number.isInteger(candidate) || (candidate as number) <= 0) {
    throw new Error("Odoo did not return a created record identifier");
  }
  return candidate as number;
}

function plaintextToHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replace(/\r?\n/g, "<br>");
}

function decodedBase64Bytes(value: string): { normalized: string; bytes: number } {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("data_base64 must be canonical padded base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64");
  if (canonical !== normalized) throw new Error("data_base64 is malformed");
  return { normalized, bytes: decoded.byteLength };
}

function normalizeOdooDatetime(value: string): string {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return raw.replace("T", " ").length === 16 ? `${raw.replace("T", " ")}:00` : raw.replace("T", " ");
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error("scheduled_date must be YYYY-MM-DD or an ISO datetime");
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

export function registerOperationalCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "projects.task.create",
    name: "projects_create_task",
    title: "Create Project Task",
    description:
      "Create one project task with explicit common fields in a single Odoo transaction. Use for routine task creation; use odoo_create_records when additional project.task fields are genuinely needed.",
    layer: "business_action",
    toolsets: ["projects"],
    profiles: ["projects"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["project", "task", "create", "assignment", "deadline", "dependency"],
    requiredModules: ["project"],
    requiredModelAccess: [{ model: "project.task", operation: "create" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 560,
    input: z.object({
      name: z.string().trim().min(1).max(500),
      project_id: PositiveIdSchema,
      description: z.string().max(100_000).optional(),
      description_is_html: z.boolean().default(false),
      stage_id: PositiveIdSchema.optional(),
      assignee_ids: z.array(PositiveIdSchema).max(50).optional(),
      tag_ids: z.array(PositiveIdSchema).max(100).optional(),
      dependency_ids: z.array(PositiveIdSchema).max(100).optional(),
      date_deadline: DateSchema.optional(),
      company_id: PositiveIdSchema.optional(),
      context: OdooContextSchema
    }).strict(),
    output: ActionOutputSchema,
    async handler(input, context, signal) {
      const values = {
        name: input.name,
        project_id: input.project_id,
        ...(input.description !== undefined ? {
          description: input.description_is_html ? input.description : plaintextToHtml(input.description)
        } : {}),
        ...(input.stage_id ? { stage_id: input.stage_id } : {}),
        ...(input.assignee_ids ? { user_ids: [[6, 0, input.assignee_ids]] } : {}),
        ...(input.tag_ids ? { tag_ids: [[6, 0, input.tag_ids]] } : {}),
        ...(input.dependency_ids ? { depend_on_ids: [[6, 0, input.dependency_ids]] } : {}),
        ...(input.date_deadline ? { date_deadline: input.date_deadline } : {}),
        ...(input.company_id ? { company_id: input.company_id } : {})
      };
      const receipt = await client.call<unknown>(context, "project.task", "create", {
        vals_list: [values], context: rpcContext(input.context, context)
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: "project.task",
          fields: ["name", "project_id", "stage_id", "user_ids", "date_deadline"],
          suggestedTool: "odoo_search_records",
          instructions: "Search project.task using the original project_id and task name. If exactly one matching task exists, read it and patch only missing fields; do not create another task."
        }
      });
      return receipt.finalize((result) => {
        const id = createdId(result);
        return {
          data: {
            result,
            correlation_id: context.correlationId,
            outcome: "succeeded" as const,
            record: recordRef(context, "project.task", id, input.name)
          }
        };
      }, (result) => ({ knownIds: [createdId(result)] }));
    }
  }));

  registry.add(defineCapability({
    id: "projects.task.attachment.create",
    name: "projects_attach_file",
    title: "Attach File to Project Task",
    description:
      "Create one bounded binary attachment on one project task. Use for small agent-generated artifacts; use the Documents archive for larger, versioned, or searchable source documents.",
    layer: "business_action",
    toolsets: ["projects", "documents"],
    profiles: ["projects"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["project task", "attachment", "file", "upload"],
    requiredModules: ["project"],
    requiredModelAccess: [
      { model: "project.task", operation: "read" },
      { model: "ir.attachment", operation: "create" }
    ],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 570,
    input: z.object({
      task_id: PositiveIdSchema,
      name: z.string().trim().min(1).max(255),
      data_base64: z.string().min(4).max(700_000),
      mimetype: z.string().trim().min(1).max(255).default("application/octet-stream"),
      context: OdooContextSchema
    }).strict(),
    output: ActionOutputSchema,
    async handler({ task_id, name, data_base64, mimetype, context: requestedContext }, context, signal) {
      const payload = decodedBase64Bytes(data_base64);
      if (payload.bytes > 512 * 1024) throw new Error("Project attachments are limited to 512 KiB; use USL Documents for larger files");
      const common = rpcContext(requestedContext, context);
      const tasks = await client.call<unknown[]>(context, "project.task", "read", {
        ids: [task_id], fields: ["id", "display_name"], context: common
      }, { signal });
      if (!tasks[0]) throw new Error(`project.task,${task_id} was not found or is not readable`);
      const receipt = await client.call<unknown>(context, "ir.attachment", "create", {
        vals_list: [{ name, type: "binary", datas: payload.normalized, mimetype, res_model: "project.task", res_id: task_id }],
        context: common
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: "ir.attachment",
          fields: ["name", "res_model", "res_id", "mimetype", "file_size"],
          suggestedTool: "odoo_search_records",
          instructions: "Search ir.attachment by the original task, filename, and MIME type. Compare file_size before uploading the attachment again."
        }
      });
      return receipt.finalize((result) => {
        const id = createdId(result);
        return {
          data: {
            result: { attachment_id: id, task_id, name, mimetype, file_size: payload.bytes },
            correlation_id: context.correlationId,
            outcome: "succeeded" as const,
            record: recordRef(context, "project.task", task_id)
          }
        };
      }, (result) => ({ knownIds: [createdId(result)] }));
    }
  }));

  registry.add(defineCapability({
    id: "activities.record.schedule",
    name: "activities_schedule",
    title: "Schedule Activity",
    description:
      "Schedule one activity on one chatter-enabled Odoo record through that model's public activity_schedule method. Use for assigned follow-up work; use odoo_post_message for an unassigned note.",
    layer: "business_action",
    toolsets: ["activities"],
    profiles: [],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["activity", "todo", "follow-up", "deadline", "assign"],
    requiredModules: ["mail"],
    requiredAnyPublicMethods: ["activity_schedule"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 580,
    input: z.object({
      model: ModelNameSchema,
      id: PositiveIdSchema,
      activity_type_id: PositiveIdSchema,
      user_id: PositiveIdSchema,
      summary: z.string().trim().min(1).max(500),
      note: z.string().max(20_000).optional(),
      note_is_html: z.boolean().default(false),
      date_deadline: DateSchema.optional(),
      context: OdooContextSchema
    }).strict(),
    output: ActionOutputSchema,
    async handler(input, context, signal) {
      const receipt = await client.call<unknown>(context, input.model, "activity_schedule", {
        ids: [input.id],
        activity_type_id: input.activity_type_id,
        user_id: input.user_id,
        summary: input.summary,
        ...(input.note !== undefined ? { note: input.note_is_html ? input.note : plaintextToHtml(input.note) } : {}),
        ...(input.date_deadline ? { date_deadline: input.date_deadline } : {}),
        context: rpcContext(input.context, context)
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: input.model,
          knownIds: [input.id],
          fields: ["activity_ids"],
          suggestedTool: "odoo_read_records",
          instructions: "Read the record's activities and match the original activity type, assignee, summary, and deadline before scheduling another activity."
        }
      });
      return receipt.finalize((result) => ({
        data: {
          result,
          correlation_id: context.correlationId,
          outcome: "succeeded" as const,
          record: recordRef(context, input.model, input.id)
        }
      }));
    }
  }));

  registry.add(defineCapability({
    id: "expenses.context.get",
    name: "expenses_get_context",
    title: "Get Expense Context",
    description:
      "Read up to 50 expenses with accounting context, batch readiness, receipt status, next step, and attachment references. Use for review or before an expense mutation; use expense_batches_get_context for batch-level decisions.",
    layer: "semantic",
    toolsets: ["expenses", "accounting", "documents"],
    profiles: ["accounting"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["expense", "receipt", "category", "analytic", "audit", "next step"],
    requiredModules: ["hr_expense", "rebuild_account_migration", "usl_expense_batch"],
    requiredModelAccess: [
      { model: "hr.expense", operation: "read" },
      { model: "ir.attachment", operation: "read" }
    ],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 270,
    input: z.object({
      expense_ids: z.array(PositiveIdSchema).min(1).max(50),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ expenses: RecordsSchema, attachments: RecordsSchema }).strict(),
    async handler({ expense_ids, context: requestedContext }, context, signal) {
      const common = rpcContext(requestedContext, context);
      const [expenses, attachments] = await Promise.all([
        client.call<Record<string, unknown>[]>(context, "hr.expense", "read", {
          ids: expense_ids,
          fields: [
            "display_name", "state", "date", "employee_id", "product_id", "account_id", "analytic_distribution",
            "tax_ids", "payment_mode", "currency_id", "total_amount", "total_amount_currency", "reference", "company_id",
            "expense_batch_id", "batch_readiness", "batch_incomplete_reason", "batch_attachment_status",
            "account_context_source", "analytic_context_source", "batch_context_revision", "batch_context_status",
            "batch_warning_reason", "batch_attention_level", "batch_attention_message", "rebuild_receipt_state", "rebuild_next_step"
          ],
          context: common
        }, { signal }),
        client.call<Record<string, unknown>[]>(context, "ir.attachment", "search_read", {
          domain: [["res_model", "=", "hr.expense"], ["res_id", "in", expense_ids]],
          fields: ["name", "mimetype", "file_size", "res_id", "create_date"],
          order: "res_id asc, id asc",
          limit: 200,
          context: common
        }, { signal })
      ]);
      return {
        data: {
          expenses: expenses.map((expense) => {
            const id = typeof expense.id === "number" ? expense.id : 0;
            return id > 0 ? { ...expense, _ref: recordRef(context, "hr.expense", id, String(expense.display_name ?? "")) } : expense;
          }),
          attachments
        }
      };
    }
  }));

  registry.add(defineCapability({
    id: "expenses.draft.update",
    name: "expenses_update_draft",
    title: "Update Draft Expense",
    description:
      "Update curated preparatory fields on one draft expense after reading its current state. This does not submit, approve, post, pay, move companies, or change the employee; use generic update only when broader Odoo flexibility is intentional.",
    layer: "business_action",
    toolsets: ["expenses", "accounting"],
    profiles: ["accounting"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["expense", "draft", "category", "account", "analytic", "tax", "paid by"],
    requiredModules: ["hr_expense"],
    requiredModelAccess: [{ model: "hr.expense", operation: "write" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 590,
    input: z.object({
      expense_id: PositiveIdSchema,
      name: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(20_000).optional(),
      date: DateSchema.optional(),
      product_id: PositiveIdSchema.optional(),
      account_id: PositiveIdSchema.optional(),
      analytic_distribution: z.record(z.string(), z.number().finite()).optional(),
      quantity: z.number().positive().optional(),
      price_unit: z.number().finite().optional(),
      total_amount: z.number().finite().optional(),
      tax_ids: z.array(PositiveIdSchema).max(50).optional(),
      reference: z.string().max(500).optional(),
      payment_mode: z.enum(["own_account", "company_account"]).optional(),
      context: OdooContextSchema
    }).strict(),
    output: ActionOutputSchema,
    async handler(input, context, signal) {
      const common = rpcContext(input.context, context);
      const before = await client.call<Record<string, unknown>[]>(context, "hr.expense", "read", {
        ids: [input.expense_id], fields: ["id", "state", "display_name"], context: common
      }, { signal });
      if (!before[0]) throw new Error(`hr.expense,${input.expense_id} was not found or is not readable`);
      if (before[0].state !== "draft") throw new Error(`hr.expense,${input.expense_id} must be draft before preparatory fields can be changed`);
      const displayName = String(before[0].display_name ?? "");
      const values = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
        ...(input.product_id !== undefined ? { product_id: input.product_id } : {}),
        ...(input.account_id !== undefined ? { account_id: input.account_id } : {}),
        ...(input.analytic_distribution !== undefined ? { analytic_distribution: input.analytic_distribution } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.price_unit !== undefined ? { price_unit: input.price_unit } : {}),
        ...(input.total_amount !== undefined ? { total_amount: input.total_amount } : {}),
        ...(input.tax_ids !== undefined ? { tax_ids: [[6, 0, input.tax_ids]] } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.payment_mode !== undefined ? { payment_mode: input.payment_mode } : {})
      };
      if (Object.keys(values).length === 0) throw new Error("Supply at least one draft expense field to update");
      const receipt = await client.call<unknown>(context, "hr.expense", "write", {
        ids: [input.expense_id], vals: values, context: common
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: "hr.expense",
          knownIds: [input.expense_id],
          fields: Object.keys(values),
          suggestedTool: "odoo_read_records",
          instructions: "Read the changed expense fields and compare them with the original patch. Preserve matching values and patch only fields that remain different."
        }
      });
      return receipt.finalize((result) => ({
        data: {
          result,
          correlation_id: context.correlationId,
          outcome: "succeeded" as const,
          record: recordRef(context, "hr.expense", input.expense_id, displayName)
        }
      }));
    }
  }));

  registry.add(defineCapability({
    id: "accounting.vendor_bill.draft.configure",
    name: "expenses_configure_draft_vendor_bill",
    title: "Configure Draft Vendor Bill",
    description:
      "Atomically update curated header fields and existing product lines on one draft vendor bill or credit note, including taxes and analytics. Odoo validates company, ownership, locks, access, type, and state, then returns recomputed totals, tax lines, and payable lines. This never posts, pays, reconciles, deletes user-entered lines, or accepts generated lines as input.",
    layer: "business_action",
    toolsets: ["expenses", "accounting"],
    profiles: ["accounting"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["vendor bill", "credit note", "draft", "supplier", "invoice date", "review", "tax", "reverse charge", "analytic", "line"],
    requiredModules: ["account", "usl_accounting"],
    requiredPublicMethods: [{ model: "account.move", method: "configure_draft_vendor_bill" }],
    requiredModelAccess: [{ model: "account.move", operation: "write" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 600,
    input: z.object({
      bill_id: PositiveIdSchema,
      partner_id: PositiveIdSchema.optional(),
      invoice_date: DateSchema.optional(),
      accounting_date: DateSchema.optional(),
      invoice_date_due: DateSchema.optional(),
      reference: z.string().max(500).optional(),
      fiscal_position_id: PositiveIdSchema.optional(),
      currency_id: PositiveIdSchema.optional(),
      narration: z.string().max(50_000).optional(),
      payment_reference: z.string().max(500).optional(),
      review_state: z.enum(["no_review", "todo", "reviewed", "supervised", "anomaly"]).optional(),
      line_patches: z.array(z.object({
        line_id: PositiveIdSchema,
        name: z.string().trim().min(1).max(2_000).optional(),
        account_id: PositiveIdSchema.optional(),
        quantity: z.number().finite().optional(),
        price_unit: z.number().finite().optional(),
        discount: z.number().finite().min(0).max(100).optional(),
        tax_ids: z.array(PositiveIdSchema).max(50).optional(),
        analytic_distribution: z.record(z.string().min(1).max(200), z.number().finite())
          .refine((distribution) => Object.keys(distribution).length <= 100, "At most 100 analytic entries are allowed")
          .optional()
      }).strict()).max(100).optional(),
      context: OdooContextSchema
    }).strict(),
    output: VendorBillConfigurationOutputSchema,
    async handler(input, context, signal) {
      const common = rpcContext(input.context, context);
      const headerValues = {
        ...(input.partner_id !== undefined ? { partner_id: input.partner_id } : {}),
        ...(input.invoice_date !== undefined ? { invoice_date: input.invoice_date } : {}),
        ...(input.accounting_date !== undefined ? { date: input.accounting_date } : {}),
        ...(input.invoice_date_due !== undefined ? { invoice_date_due: input.invoice_date_due } : {}),
        ...(input.reference !== undefined ? { ref: input.reference } : {}),
        ...(input.fiscal_position_id !== undefined ? { fiscal_position_id: input.fiscal_position_id } : {}),
        ...(input.currency_id !== undefined ? { currency_id: input.currency_id } : {}),
        ...(input.narration !== undefined ? { narration: input.narration } : {}),
        ...(input.payment_reference !== undefined ? { payment_reference: input.payment_reference } : {}),
        ...(input.review_state !== undefined ? { review_state: input.review_state } : {})
      };
      if (Object.keys(headerValues).length === 0 && !input.line_patches?.length) {
        throw new Error("Supply at least one draft vendor bill field or line patch");
      }
      const receipt = await client.call<z.infer<typeof VendorBillConfigurationResultSchema>>(
        context,
        "account.move",
        "configure_draft_vendor_bill",
        {
          ids: [input.bill_id],
          header_values: headerValues,
          line_patches: input.line_patches ?? [],
          context: common
        }, {
          kind: "mutation",
          signal,
          reconciliation: {
            targetModel: "account.move",
            knownIds: [input.bill_id],
            fields: [...Object.keys(headerValues), ...(input.line_patches?.length ? ["invoice_line_ids"] : [])],
            suggestedTool: "odoo_read_records",
            instructions: "Read the draft vendor bill totals, review state, invoice lines, taxes, and payment terms. Compare them with the requested patch and do not repeat fields whose intended result is already present."
          }
        }
      );
      return receipt.finalize((result) => ({
        data: {
          result,
          correlation_id: context.correlationId,
          outcome: "succeeded" as const,
          record: recordRef(context, "account.move", input.bill_id, result.bill.display_name)
        }
      }));
    }
  }));

  for (const action of [
    { name: "expenses_reset_draft", id: "expenses.reset_draft", method: "action_reset", title: "Reset Expense to Draft", verb: "reset the selected expenses to draft", expectedStates: ["draft"] },
    { name: "expenses_submit", id: "expenses.submit", method: "action_submit", title: "Submit Expenses", verb: "submit the selected draft expenses", expectedStates: ["submitted", "approved"] },
    { name: "expenses_approve", id: "expenses.approve", method: "action_approve", title: "Approve Expenses", verb: "approve the selected submitted expenses", expectedStates: ["approved"] }
  ]) {
    registry.add(defineCapability({
      id: action.id,
      name: action.name,
      title: action.title,
      description: `Run the public hr.expense workflow to ${action.verb} in one Odoo transaction. Read expenses_get_context immediately beforehand; Odoo enforces state, receipt, company, role, and irreversible-action rules.`,
      layer: "business_action",
      toolsets: ["expenses", "accounting"],
      profiles: ["accounting"],
      effect: "consequential",
      annotations: action.name === "expenses_reset_draft"
        ? { ...actionAnnotations, destructiveHint: true }
        : actionAnnotations,
      keywords: ["expense", action.method, "workflow"],
      requiredModules: ["hr_expense"],
      requiredPublicMethods: [{ model: "hr.expense", method: action.method }],
      defaultVisible: false,
      alwaysLoad: false,
      sortOrder: action.name === "expenses_reset_draft" ? 610 : action.name === "expenses_submit" ? 620 : 630,
      input: z.object({ expense_ids: z.array(PositiveIdSchema).min(1).max(50), context: OdooContextSchema }).strict(),
      output: ActionOutputSchema,
      async handler({ expense_ids, context: requestedContext }, context, signal) {
        const common = rpcContext(requestedContext, context);
        const receipt = await client.call<unknown>(context, "hr.expense", action.method, {
          ids: expense_ids, context: common
        }, {
          kind: "mutation",
          signal,
          reconciliation: {
            targetModel: "hr.expense",
            knownIds: expense_ids,
            fields: ["state"],
            suggestedTool: "odoo_read_records",
            instructions: `Read each expense state. Repeat ${action.method} only for records whose current state proves the transition did not apply; otherwise continue from the observed state.`
          }
        });
        return receipt.finalize(async (result) => {
          const warnings: string[] = [];
          let observed: Record<string, unknown>[] = [];
          let outcome: "succeeded" | "requires_follow_up" | "unknown" = "succeeded";
          const methodResult = result && typeof result === "object" && !Array.isArray(result)
            ? result as Record<string, unknown>
            : null;
          const requiresWizard = methodResult?.type === "ir.actions.act_window";
          if (requiresWizard) {
            outcome = "requires_follow_up";
            warnings.push(
              `Odoo returned a follow-up wizard for ${action.method}. Inspect the method result and current expense states; do not assume the transition completed or repeat it blindly.`
            );
          }
          try {
            observed = await client.call<Record<string, unknown>[]>(context, "hr.expense", "read", {
              ids: expense_ids, fields: ["id", "display_name", "state"], context: common
            }, { signal });
            const unexpected = observed.filter((record) => !action.expectedStates.includes(String(record.state)));
            if (unexpected.length > 0 && !requiresWizard) {
              outcome = "requires_follow_up";
              warnings.push(
                `Odoo returned success for ${action.method}, but ${unexpected.map((record) => `hr.expense,${String(record.id)}=${String(record.state)}`).join(", ")} did not reach ${action.expectedStates.join(" or ")}. Inspect these current states and the method result before deciding the next transition.`
              );
            }
          } catch (error) {
            outcome = "unknown";
            warnings.push(
              `Odoo returned success for ${action.method}, but the final expense states could not be read: ${error instanceof Error ? error.message : String(error)}. Read these expense IDs before retrying; keep applied transitions and retry only records proven unchanged.`
            );
          }
          return {
            data: {
              result: { method_result: result, observed },
              correlation_id: context.correlationId,
              outcome
            },
            ...(warnings.length ? { warnings } : {})
          };
        });
      }
    }));
  }

  registry.add(defineCapability({
    id: "inventory.vendor_receipt.draft.create",
    name: "inventory_create_draft_vendor_receipt",
    title: "Create Draft Vendor Receipt",
    description:
      "Create one incoming stock picking and all move lines through one nested Odoo create transaction, leaving validation to a later explicit workflow. Supply the operation type and locations explicitly; dry_run returns the exact values without calling Odoo.",
    layer: "business_action",
    toolsets: ["inventory", "products"],
    profiles: [],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["inventory", "vendor receipt", "incoming", "stock picking", "draft"],
    requiredModules: ["stock"],
    requiredModelAccess: [{ model: "stock.picking", operation: "create" }],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 640,
    input: z.object({
      partner_id: PositiveIdSchema,
      picking_type_id: PositiveIdSchema,
      location_id: PositiveIdSchema,
      location_dest_id: PositiveIdSchema,
      scheduled_date: z.string().min(10).max(40),
      origin: z.string().trim().min(1).max(255).optional(),
      note: z.string().max(5000).optional(),
      company_id: PositiveIdSchema.optional(),
      lines: z.array(z.object({
        product_id: PositiveIdSchema,
        product_uom_id: PositiveIdSchema,
        quantity: z.number().positive().finite(),
        name: z.string().trim().min(1).max(500).optional()
      }).strict()).min(1).max(200),
      dry_run: z.boolean().default(false),
      context: OdooContextSchema
    }).strict(),
    output: z.object({
      dry_run: z.boolean(),
      planned_values: RecordSchema,
      result: z.unknown().optional(),
      record: z.object({ model: z.string(), id: z.number().int(), display_name: z.string(), url: z.string() }).strict().optional(),
      observed_state: z.string().optional(),
      warnings: z.array(z.string()),
      correlation_id: z.string()
    }).strict(),
    async handler(input, context, signal) {
      const scheduledDate = normalizeOdooDatetime(input.scheduled_date);
      const plannedValues = {
        partner_id: input.partner_id,
        picking_type_id: input.picking_type_id,
        location_id: input.location_id,
        location_dest_id: input.location_dest_id,
        scheduled_date: scheduledDate,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.company_id ? { company_id: input.company_id } : {}),
        move_ids: input.lines.map((line) => [0, 0, {
          name: line.name ?? `Product ${line.product_id}`,
          product_id: line.product_id,
          product_uom: line.product_uom_id,
          product_uom_qty: line.quantity,
          location_id: input.location_id,
          location_dest_id: input.location_dest_id
        }])
      };
      if (input.dry_run) {
        return { data: { dry_run: true, planned_values: plannedValues, warnings: [], correlation_id: context.correlationId } };
      }
      const common = rpcContext(input.context, context);
      const receipt = await client.call<unknown>(context, "stock.picking", "create", {
        vals_list: [plannedValues], context: common
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: "stock.picking",
          fields: ["partner_id", "picking_type_id", "location_id", "location_dest_id", "scheduled_date", "origin", "state", "move_ids"],
          suggestedTool: "odoo_search_records",
          instructions: "Search incoming pickings with the original partner, operation type, locations, scheduled date, and origin. If a matching picking exists, read its moves and continue with that record instead of creating another receipt."
        }
      });
      return receipt.finalize(async (result) => {
        const id = createdId(result);
        let rows: Record<string, unknown>[] = [];
        const warnings: string[] = [];
        try {
          rows = await client.call<Record<string, unknown>[]>(context, "stock.picking", "read", {
            ids: [id], fields: ["id", "display_name", "state", "picking_type_code", "move_ids"], context: common
          }, { signal });
          if (!rows[0]) {
            warnings.push(`Odoo created stock.picking,${id}, but the follow-up read returned no row. Fetch that exact picking before any further action; do not create another receipt.`);
          }
        } catch (error) {
          warnings.push(`Odoo created stock.picking,${id}, but its current state could not be read: ${error instanceof Error ? error.message : String(error)}. Fetch that exact picking before any further action; do not create another receipt.`);
        }
        const state = typeof rows[0]?.state === "string" ? rows[0].state : undefined;
        if (state && !["draft", "waiting", "confirmed", "assigned"].includes(state)) {
          warnings.push(`The receipt was created, but Odoo reports state=${state}; inspect it before continuing.`);
        }
        return {
          data: {
            dry_run: false,
            planned_values: plannedValues,
            result,
            record: recordRef(context, "stock.picking", id, String(rows[0]?.display_name ?? "")),
            ...(state ? { observed_state: state } : {}),
            warnings,
            correlation_id: context.correlationId
          }
        };
      }, (result) => ({ knownIds: [createdId(result)] }));
    }
  }));
}
