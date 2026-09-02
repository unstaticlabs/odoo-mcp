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
const ContextOutputSchema = z.object({ context: RecordSchema }).strict();
const ActionOutputSchema = z.object({
  result: z.unknown(),
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "unknown"])
}).strict();
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an Odoo date in YYYY-MM-DD form");
const DateTimeSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "Expected an ISO-8601 UTC timestamp");
const RecordReferenceSchema = z.object({
  model: z.string(),
  id: PositiveIdSchema,
  display_name: z.string(),
  url: z.string().url()
}).strict();
const DownloadVersionSchema = z.object({
  id: PositiveIdSchema,
  paperless_version_id: z.string().min(1).max(200),
  label: z.string().max(500),
  is_current_at_issuance: z.boolean()
}).strict();
const DownloadGrantOutputSchema = z.object({
  grant_id: z.string().uuid(),
  url: z.string().url().refine((value) => value.startsWith("https://"), "Expected an HTTPS URL"),
  expires_at: DateTimeSchema,
  ttl_seconds: z.number().int().min(30).max(900),
  document: RecordReferenceSchema,
  version: DownloadVersionSchema,
  variant: z.enum(["original", "archive"]),
  filename: z.string().min(1).max(1024),
  mime_type: z.string().min(1).max(255),
  size_bytes: z.number().int().nonnegative().nullable(),
  checksum: z.string().nullable(),
  correlation_id: z.string(),
  outcome: z.literal("succeeded")
}).strict();

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const actionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

function rpcContext(requested: Record<string, unknown>, context: RequestContext) {
  return attributedContext(requested, context.correlationId);
}

function ref(context: RequestContext, model: string, id: number, displayName?: unknown) {
  return {
    model,
    id,
    display_name: typeof displayName === "string" && displayName ? displayName : `${model},${id}`,
    url: `${context.principal.publicOrigin}/odoo/${model}/${id}`
  };
}

async function recordActivities(
  client: OdooClient,
  context: RequestContext,
  model: string,
  id: number,
  limit: number,
  requestedContext: Record<string, unknown>,
  signal: AbortSignal
) {
  return client.call<Record<string, unknown>[]>(context, "mail.activity", "search_read", {
    domain: [["res_model", "=", model], ["res_id", "=", id]],
    fields: ["display_name", "activity_type_id", "summary", "note", "date_deadline", "user_id", "state"],
    order: "date_deadline asc, id asc",
    limit,
    context: rpcContext(requestedContext, context)
  }, { signal });
}

async function recordMessages(
  client: OdooClient,
  context: RequestContext,
  model: string,
  id: number,
  limit: number,
  requestedContext: Record<string, unknown>,
  signal: AbortSignal
) {
  return client.call<Record<string, unknown>[]>(context, "mail.message", "search_read", {
    domain: [["model", "=", model], ["res_id", "=", id], ["message_type", "!=", "user_notification"]],
    fields: ["date", "author_id", "body", "subtype_id", "message_type"],
    order: "date desc, id desc",
    limit,
    context: rpcContext(requestedContext, context)
  }, { signal });
}

const DOCUMENT_LINK_MODULE = "usl_documents";

async function optionalDocumentLinks(
  client: OdooClient,
  context: RequestContext,
  model: string,
  id: number,
  common: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ records: unknown[]; warning?: string }> {
  if (context.availableModules && !context.availableModules.has(DOCUMENT_LINK_MODULE)) {
    return { records: [] };
  }
  try {
    const records = await client.call<unknown[]>(context, "usl.document.link", "search_read", {
      domain: [["res_model", "=", model], ["res_id", "=", id], ["active", "=", true]],
      fields: ["document_id", "document_role", "linked_at", "version_id"],
      limit: 20,
      order: "linked_at desc, id desc",
      context: common
    }, { signal });
    return { records };
  } catch (error) {
    return {
      records: [],
      warning: `Document links were unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function registerSemanticCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "contacts.partner.context",
    name: "contacts_get_partner_context",
    title: "Get Contact Context",
    description:
      "Read one contact or company with its immediate parent/children and open activities. Use for a compact relationship view around a known res.partner ID; use generic record tools for arbitrary partner fields or deeper traversal.",
    layer: "semantic",
    toolsets: ["contacts", "activities"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["partner", "contact", "company", "customer", "vendor", "activities"],
    requiredModules: ["contacts", "mail"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 200,
    input: z.object({
      partner_id: PositiveIdSchema,
      activity_limit: z.number().int().min(1).max(50).default(20),
      context: OdooContextSchema
    }).strict(),
    output: ContextOutputSchema,
    async handler({ partner_id, activity_limit, context: requestedContext }, context, signal) {
      const common = rpcContext(requestedContext, context);
      const rows = await client.call<unknown[]>(context, "res.partner", "read", {
        ids: [partner_id],
        fields: [
          "display_name", "is_company", "parent_id", "child_ids", "email", "phone", "mobile", "website",
          "street", "street2", "city", "zip", "state_id", "country_id", "company_id", "user_id", "category_id", "active"
        ],
        context: common
      }, { signal });
      const partner = rows[0] as Record<string, unknown> | undefined;
      if (!partner) throw new Error(`res.partner,${partner_id} was not found or is not readable`);
      const relatedIds = new Set<number>();
      const parent = partner.parent_id;
      if (Array.isArray(parent) && Number.isInteger(parent[0])) relatedIds.add(parent[0] as number);
      for (const child of Array.isArray(partner.child_ids) ? partner.child_ids : []) {
        if (Number.isInteger(child)) relatedIds.add(child as number);
      }
      const [relations, activities] = await Promise.all([
        relatedIds.size > 0
          ? client.call<unknown[]>(context, "res.partner", "read", {
              ids: [...relatedIds],
              fields: ["display_name", "is_company", "email", "phone", "parent_id", "active"],
              context: common
            }, { signal })
          : Promise.resolve([]),
        recordActivities(client, context, "res.partner", partner_id, activity_limit, requestedContext, signal)
      ]);
      return {
        data: {
          context: {
            partner: { ...partner, _ref: ref(context, "res.partner", partner_id, partner.display_name) },
            immediate_relations: relations,
            activities
          }
        }
      };
    }
  }));

  registry.add(defineCapability({
    id: "activities.record.list",
    name: "activities_list_for_record",
    title: "List Activities for Record",
    description:
      "List bounded scheduled activities for one record on any chatter-enabled model. Use when the record is known and activity context matters; use odoo_search_records for cross-record activity analysis.",
    layer: "semantic",
    toolsets: ["activities"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["todo", "follow-up", "deadline", "mail activity"],
    requiredModules: ["mail"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 210,
    input: z.object({
      model: ModelNameSchema,
      id: PositiveIdSchema,
      limit: z.number().int().min(1).max(100).default(20),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ record: z.object({ model: z.string(), id: z.number(), url: z.string() }).strict(), activities: RecordsSchema }).strict(),
    async handler({ model, id, limit, context: requestedContext }, context, signal) {
      const activities = await recordActivities(client, context, model, id, limit, requestedContext, signal);
      return { data: { record: { model, id, url: `${context.principal.publicOrigin}/odoo/${model}/${id}` }, activities } };
    }
  }));

  registry.add(defineCapability({
    id: "projects.task.context",
    name: "projects_get_task_context",
    title: "Get Project Task Context",
    description:
      "Read one project task with assignments, stage, tags, immediate hierarchy, recent chatter, activities, and archived-document links. Use for common task review; use generic traversal when different relations or fields matter.",
    layer: "semantic",
    toolsets: ["projects", "activities", "documents"],
    profiles: ["projects"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["task", "project", "chatter", "activity", "documents", "context"],
    requiredModules: ["project", "mail"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 220,
    input: z.object({
      task_id: PositiveIdSchema,
      chatter_limit: z.number().int().min(1).max(50).default(10),
      context: OdooContextSchema
    }).strict(),
    output: ContextOutputSchema,
    async handler({ task_id, chatter_limit, context: requestedContext }, context, signal) {
      const common = rpcContext(requestedContext, context);
      const [rows, activities, messages, documentLinks] = await Promise.all([
        client.call<unknown[]>(context, "project.task", "read", {
          ids: [task_id],
          fields: [
            "display_name", "project_id", "stage_id", "state", "user_ids", "partner_id", "date_deadline",
            "description", "tag_ids", "parent_id", "child_ids", "company_id", "priority", "create_date", "write_date"
          ],
          context: common
        }, { signal }),
        recordActivities(client, context, "project.task", task_id, chatter_limit, requestedContext, signal),
        recordMessages(client, context, "project.task", task_id, chatter_limit, requestedContext, signal),
        optionalDocumentLinks(client, context, "project.task", task_id, common, signal)
      ]);
      const task = rows[0] as Record<string, unknown> | undefined;
      if (!task) throw new Error(`project.task,${task_id} was not found or is not readable`);
      return {
        data: { context: { task: { ...task, _ref: ref(context, "project.task", task_id, task.display_name) }, activities, messages, document_links: documentLinks.records } },
        ...(documentLinks.warning ? { warnings: [documentLinks.warning] } : {})
      };
    }
  }));

  registry.add(defineCapability({
    id: "accounting.invoice.context",
    name: "accounting_get_invoice_context",
    title: "Get Invoice Context",
    description:
      "Read one invoice or vendor bill with lines, payment state, activities, recent chatter, and archived-document links. Use for common invoice review; this is read-only and does not post, pay, or reconcile the move.",
    layer: "semantic",
    toolsets: ["accounting", "activities", "documents"],
    profiles: ["accounting"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["invoice", "vendor bill", "account move", "payment state", "lines", "documents"],
    requiredModules: ["account", "mail"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 230,
    input: z.object({
      move_id: PositiveIdSchema,
      chatter_limit: z.number().int().min(1).max(50).default(10),
      context: OdooContextSchema
    }).strict(),
    output: ContextOutputSchema,
    async handler({ move_id, chatter_limit, context: requestedContext }, context, signal) {
      const common = rpcContext(requestedContext, context);
      const [moves, lines, activities, messages, documentLinks] = await Promise.all([
        client.call<unknown[]>(context, "account.move", "read", {
          ids: [move_id],
          fields: [
            "display_name", "move_type", "state", "partner_id", "invoice_date", "invoice_date_due", "currency_id",
            "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "invoice_origin", "ref",
            "company_id", "journal_id", "invoice_line_ids", "line_ids", "create_date", "write_date"
          ],
          context: common
        }, { signal }),
        client.call<unknown[]>(context, "account.move.line", "search_read", {
          domain: [["move_id", "=", move_id], ["display_type", "in", ["product", "tax", "payment_term"]]],
          fields: [
            "display_type", "name", "product_id", "quantity", "price_unit", "price_subtotal", "price_total",
            "account_id", "analytic_distribution", "tax_ids", "debit", "credit", "amount_currency", "reconciled"
          ],
          order: "sequence asc, id asc",
          limit: 100,
          context: common
        }, { signal }),
        recordActivities(client, context, "account.move", move_id, chatter_limit, requestedContext, signal),
        recordMessages(client, context, "account.move", move_id, chatter_limit, requestedContext, signal),
        optionalDocumentLinks(client, context, "account.move", move_id, common, signal)
      ]);
      const move = moves[0] as Record<string, unknown> | undefined;
      if (!move) throw new Error(`account.move,${move_id} was not found or is not readable`);
      return {
        data: { context: { invoice: { ...move, _ref: ref(context, "account.move", move_id, move.display_name) }, lines, activities, messages, document_links: documentLinks.records } },
        ...(documentLinks.warning ? { warnings: [documentLinks.warning] } : {})
      };
    }
  }));

  registry.add(defineCapability({
    id: "expenses.batch.context",
    name: "expense_batches_get_context",
    title: "Get Expense Batch Context",
    description:
      "Return the Distribution's authoritative review summary for one expense batch, including readiness, exceptions, analytics, products, totals, attention, and accounting reconciliation. Use before any batch action.",
    layer: "semantic",
    toolsets: ["expenses", "accounting"],
    profiles: ["accounting"],
    effect: "read",
    agentReadonly: false,
    annotations: readAnnotations,
    keywords: ["expense batch", "review", "receipts", "exceptions", "analytics", "accounting"],
    requiredModules: ["usl_expense_batch"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 240,
    input: z.object({ batch_id: PositiveIdSchema, context: OdooContextSchema }).strict(),
    output: ContextOutputSchema,
    async handler({ batch_id, context: requestedContext }, context, signal) {
      const summary = await client.call<Record<string, unknown>>(context, "usl.expense.batch", "get_review_summary", {
        ids: [batch_id],
        context: rpcContext(requestedContext, context)
      }, { signal });
      return { data: { context: { ...summary, _ref: ref(context, "usl.expense.batch", batch_id, summary.name) } } };
    }
  }));

  registry.add(defineCapability({
    id: "home.attention.get",
    name: "home_get_attention",
    title: "Get Home Attention Items",
    description:
      "Return the current internal user's bounded AI-pipeline attention list from the Distribution Home service. Use for failed, blocked, or human-review tasks assigned to this identity.",
    layer: "semantic",
    toolsets: ["projects"],
    profiles: ["projects"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["home", "attention", "AI pipeline", "blocked", "failed", "review"],
    requiredModules: ["usl_home"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 250,
    input: z.object({ context: OdooContextSchema }).strict(),
    output: ContextOutputSchema,
    async handler({ context: requestedContext }, context, signal) {
      const result = await client.call<Record<string, unknown>>(context, "usl.home.service", "get_ai_attention", {
        context: rpcContext(requestedContext, context)
      }, { signal });
      return { data: { context: result } };
    }
  }));

  registry.add(defineCapability({
    id: "b2c.order.context",
    name: "b2c_get_order_context",
    title: "Get B2C Order Context",
    description:
      "Read one canonical B2C order with lines, payment/refund events, fulfilment events, accounting links, and source evidence. Use for a bounded end-to-end order view across B2C workflows.",
    layer: "semantic",
    toolsets: ["b2c", "accounting", "inventory", "documents"],
    profiles: ["b2c"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["B2C", "order", "payment", "refund", "fulfilment", "accounting", "evidence"],
    requiredModules: ["usl_b2c"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 260,
    input: z.object({ order_id: PositiveIdSchema, context: OdooContextSchema }).strict(),
    output: ContextOutputSchema,
    async handler({ order_id, context: requestedContext }, context, signal) {
      const common = rpcContext(requestedContext, context);
      const [orders, lines, payments, fulfilments, accountingLinks, sources] = await Promise.all([
        client.call<unknown[]>(context, "b2c.order", "read", {
          ids: [order_id],
          fields: [
            "display_name", "canonical_key", "company_id", "channel_id", "source_provider", "origin", "external_order_id",
            "state", "order_date", "payment_date", "refund_date", "fulfilment_date", "country_id", "currency_id",
            "subtotal_amount", "shipping_amount", "discount_amount", "tax_amount", "fee_amount", "refund_amount",
            "revenue_amount", "total_amount", "net_amount", "conversion_state", "amount_completeness", "mapping_state",
            "review_state", "fulfilment_mode", "accounting_link_state", "bank_link_state", "payment_link_state",
            "fulfilment_link_state", "document_link_state", "sale_order_id", "supporting_attachment_id", "company_id"
          ],
          context: common
        }, { signal }),
        client.call<unknown[]>(context, "b2c.order.line", "search_read", {
          domain: [["order_id", "=", order_id]], fields: ["line_key", "original_sku", "original_name", "quantity", "unit_price", "revenue_amount", "product_id", "alias_id", "mapping_state", "amount_completeness"], order: "sequence asc, id asc", limit: 100, context: common
        }, { signal }),
        client.call<unknown[]>(context, "b2c.payment.event", "search_read", {
          domain: [["order_id", "=", order_id]], fields: ["display_name", "event_type", "event_date", "amount", "currency_id", "mapping_state", "accounting_link_state", "evidence_id"], order: "event_date asc, id asc", limit: 100, context: common
        }, { signal }),
        client.call<unknown[]>(context, "b2c.fulfilment.event", "search_read", {
          domain: [["order_id", "=", order_id]], fields: ["display_name", "event_date", "state", "fulfilment_mode", "cogs_amount", "company_cogs_amount", "completeness_state", "review_state", "order_link_state", "accounting_link_state", "stock_picking_id", "stock_move_id", "purchase_order_id", "evidence_id"], order: "event_date asc, id asc", limit: 100, context: common
        }, { signal }),
        client.call<unknown[]>(context, "b2c.accounting.link", "search_read", {
          domain: [["order_id", "=", order_id]], fields: ["display_name", "link_type", "link_state", "account_move_id", "account_move_line_id", "account_payment_id", "bank_statement_line_id", "payment_transaction_id", "sale_order_id", "stock_picking_id", "stock_move_id", "session_id"], order: "id asc", limit: 100, context: common
        }, { signal }),
        client.call<unknown[]>(context, "b2c.order.source", "search_read", {
          domain: [["order_id", "=", order_id]], fields: ["source_provider", "source_record_key", "external_order_id", "external_transaction_id", "external_fulfilment_id", "source_precedence", "is_primary", "completeness_state", "evidence_id"], order: "source_precedence desc, id asc", limit: 100, context: common
        }, { signal })
      ]);
      const order = orders[0] as Record<string, unknown> | undefined;
      if (!order) throw new Error(`b2c.order,${order_id} was not found or is not readable`);
      return { data: { context: { order: { ...order, _ref: ref(context, "b2c.order", order_id, order.display_name) }, lines, payment_events: payments, fulfilment_events: fulfilments, accounting_links: accountingLinks, sources } } };
    }
  }));
}

export function registerDocumentCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "documents.search",
    name: "documents_search",
    title: "Search Documents",
    description:
      "Search the USL document archive through the Distribution's bounded hybrid, exact, or semantic facade. Use this purpose-built archive interface for document content and metadata discovery.",
    layer: "semantic",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["archive", "document", "hybrid search", "semantic", "exact", "Paperless"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 300,
    input: z.object({
      query: z.string().max(2048).default(""),
      mode: z.enum(["hybrid", "exact", "semantic"]).default("hybrid"),
      limit: z.number().int().min(1).max(25).default(10),
      offset: z.number().int().min(0).max(49).default(0),
      saved_view_id: PositiveIdSchema.optional(),
      company_id: PositiveIdSchema.optional(),
      tag_ids: z.array(PositiveIdSchema).max(50).optional(),
      correspondent_id: PositiveIdSchema.optional(),
      document_type_id: PositiveIdSchema.optional(),
      date_from: DateSchema.optional(),
      date_to: DateSchema.optional(),
      added_from: DateSchema.optional(),
      added_to: DateSchema.optional(),
      source: z.string().max(64).optional(),
      confidentiality: z.string().max(64).optional(),
      review_state: z.string().max(64).optional(),
      linked_state: z.string().max(64).optional(),
      linked_model: ModelNameSchema.optional(),
      linked_id: PositiveIdSchema.optional(),
      background_mode: z.enum(["include", "exclude", "only"]).default("include"),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ result: RecordSchema }).strict(),
    async handler({ context: requestedContext, ...input }, context, signal) {
      if (!input.query.trim() && !input.saved_view_id) throw new Error("Document search requires query or saved_view_id");
      if ((input.linked_model && !input.linked_id) || (!input.linked_model && input.linked_id)) {
        throw new Error("linked_model and linked_id must be supplied together");
      }
      if (input.offset + input.limit > 50) throw new Error("Document search offset plus limit may not exceed 50");
      const result = await client.call<Record<string, unknown>>(context, "usl.document", "mcp_search", {
        ...input,
        context: rpcContext(requestedContext, context)
      }, { signal });
      return { data: { result } };
    }
  }));

  registry.add(defineCapability({
    id: "documents.context.get",
    name: "documents_get_context",
    title: "Get Document Context",
    description:
      "Get one USL document's metadata, versions, and linked Odoo records in one agent call. Use after document search; fetch paginated extracted text separately with documents_get_content.",
    layer: "semantic",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["document metadata", "versions", "linked records", "archive context"],
    requiredModules: ["usl_documents"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 310,
    input: z.object({ document_id: PositiveIdSchema, context: OdooContextSchema }).strict(),
    output: ContextOutputSchema,
    async handler({ document_id, context: requestedContext }, context, signal) {
      const common = rpcContext(requestedContext, context);
      const [document, versions, links] = await Promise.all([
        client.call<Record<string, unknown>>(context, "usl.document", "mcp_get", { document_id, context: common }, { signal }),
        client.call<Record<string, unknown>>(context, "usl.document", "mcp_get_versions", { document_id, context: common }, { signal }),
        client.call<Record<string, unknown>>(context, "usl.document", "mcp_get_links", { document_id, context: common }, { signal })
      ]);
      return { data: { context: { document: { ...document, _ref: ref(context, "usl.document", document_id, document.name) }, versions: versions.versions ?? [], links: links.links ?? [] } } };
    }
  }));

  registry.add(defineCapability({
    id: "documents.content.get",
    name: "documents_get_content",
    title: "Get Document Text",
    description:
      "Read one bounded page of extracted text from a USL document. Use after documents_search/documents_get_context and continue with next_offset; this does not return arbitrary binary attachments.",
    layer: "semantic",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["document text", "OCR", "content", "pagination"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 320,
    input: z.object({
      document_id: PositiveIdSchema,
      offset: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(8000).default(4000),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ result: RecordSchema }).strict(),
    async handler({ document_id, offset, limit, context: requestedContext }, context, signal) {
      const result = await client.call<Record<string, unknown>>(context, "usl.document", "mcp_get_content", {
        document_id, offset, limit, context: rpcContext(requestedContext, context)
      }, { signal });
      return { data: { result } };
    }
  }));

  registry.add(defineCapability({
    id: "documents.similar.find",
    name: "documents_find_similar",
    title: "Find Similar Documents",
    description:
      "Find semantically similar accessible USL documents for one source document. Use for archive exploration and duplicate/context research, not as proof that records are duplicates.",
    layer: "semantic",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["similar", "semantic", "related documents", "duplicates"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 330,
    input: z.object({ document_id: PositiveIdSchema, limit: z.number().int().min(1).max(25).default(10), context: OdooContextSchema }).strict(),
    output: z.object({ result: RecordSchema }).strict(),
    async handler({ document_id, limit, context: requestedContext }, context, signal) {
      const result = await client.call<Record<string, unknown>>(context, "usl.document", "mcp_find_similar", {
        document_id, limit, context: rpcContext(requestedContext, context)
      }, { signal });
      return { data: { result } };
    }
  }));

  const catalogMethods = {
    saved_views: "mcp_list_saved_views",
    tags: "mcp_list_tags",
    correspondents: "mcp_list_correspondents",
    types: "mcp_list_types"
  } as const;
  registry.add(defineCapability({
    id: "documents.catalog.list",
    name: "documents_list_catalog",
    title: "List Document Catalogue",
    description:
      "List one bounded USL Documents catalogue: saved views, tags, correspondents, or document types. Use to discover stable filter IDs before documents_search.",
    layer: "semantic",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["saved views", "tags", "correspondents", "document types", "filters"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 340,
    input: z.object({
      kind: z.enum(["saved_views", "tags", "correspondents", "types"]),
      scope: z.enum(["all", "shared", "personal"]).default("all"),
      query: z.string().max(200).default(""),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(1000).default(0),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ result: RecordSchema }).strict(),
    async handler({ kind, scope, query, limit, offset, context: requestedContext }, context, signal) {
      const result = await client.call<Record<string, unknown>>(context, "usl.document", catalogMethods[kind], {
        query, limit, offset, ...(kind === "saved_views" ? { scope } : {}), context: rpcContext(requestedContext, context)
      }, { signal });
      return { data: { result } };
    }
  }));
}

export function registerBusinessActions(registry: CapabilityRegistry, client: OdooClient): void {
  const documentLinkInput = z.object({
    document_id: PositiveIdSchema,
    model: ModelNameSchema,
    id: PositiveIdSchema,
    context: OdooContextSchema
  }).strict();

  registry.add(defineCapability({
    id: "documents.record.link",
    name: "documents_link_to_record",
    title: "Link Document to Record",
    description:
      "Create one authoritative USL document link to one supported Odoo record in a single Odoo transaction. Use only when the intended document and record are known; this does not copy bytes or alter the source document.",
    layer: "business_action",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["link document", "record relationship", "archive"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 500,
    input: documentLinkInput,
    output: ActionOutputSchema,
    async handler({ document_id, model, id, context: requestedContext }, context, signal) {
      const result = await client.call<unknown>(context, "usl.document", "link_to_record", {
        ids: [document_id], res_model: model, res_id: id, context: rpcContext(requestedContext, context)
      }, { kind: "mutation", signal });
      return { data: { result, correlation_id: context.correlationId, outcome: "succeeded" as const } };
    }
  }));

  registry.add(defineCapability({
    id: "documents.download_url.create",
    name: "documents_create_download_url",
    title: "Create Document Download URL",
    description:
      "Create one short-lived HTTPS bearer URL for the exact authorized binary of a known USL document. Use only when an agent needs the PDF/image bytes; document search, metadata, and OCR text do not require materialization. The URL is a temporary secret and issuance is not retried automatically.",
    layer: "business_action",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "consequential",
    annotations: actionAnnotations,
    keywords: ["download", "materialize", "PDF", "image", "binary", "short-lived URL"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 515,
    input: z.object({
      document_id: PositiveIdSchema,
      document_version_id: PositiveIdSchema.optional(),
      variant: z.enum(["original", "archive"]).default("original"),
      ttl_seconds: z.number().int().min(30).max(900).default(300),
      context: OdooContextSchema
    }).strict(),
    output: DownloadGrantOutputSchema,
    async handler({ document_id, document_version_id, variant, ttl_seconds, context: requestedContext }, context, signal) {
      const result = await client.call<{
        grant_id: string;
        url: string;
        expires_at: string;
        ttl_seconds: number;
        document: { id: number; name: string };
        version: z.infer<typeof DownloadVersionSchema>;
        variant: "original" | "archive";
        filename: string;
        mime_type: string;
        size_bytes: number | false | null;
        checksum: string | false | null;
      }>(context, "usl.document", "mcp_create_download_grant", {
        document_id,
        ...(document_version_id ? { document_version_id } : {}),
        variant,
        ttl_seconds,
        context: rpcContext(requestedContext, context)
      }, { kind: "mutation", signal });
      return {
        data: DownloadGrantOutputSchema.parse({
          ...result,
          document: ref(context, "usl.document", result.document.id, result.document.name),
          size_bytes: result.size_bytes === false ? null : result.size_bytes,
          checksum: result.checksum === false ? null : result.checksum,
          correlation_id: context.correlationId,
          outcome: "succeeded"
        })
      };
    }
  }));

  registry.add(defineCapability({
    id: "documents.download_url.revoke",
    name: "documents_revoke_download_url",
    title: "Revoke Document Download URL",
    description:
      "Immediately revoke one previously issued document download URL using its non-secret grant ID. Use after early completion or suspected disclosure; this does not delete or alter the document.",
    layer: "business_action",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    keywords: ["revoke", "download URL", "grant", "materialization"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 516,
    input: z.object({
      grant_id: z.string().uuid(),
      reason: z.string().max(500).optional(),
      context: OdooContextSchema
    }).strict(),
    output: z.object({
      grant_id: z.string().uuid(),
      revoked: z.literal(true),
      revoked_at: DateTimeSchema,
      correlation_id: z.string(),
      outcome: z.literal("succeeded")
    }).strict(),
    async handler({ grant_id, reason, context: requestedContext }, context, signal) {
      const result = await client.call<{
        grant_id: string;
        revoked: true;
        revoked_at: string;
      }>(context, "usl.document", "mcp_revoke_download_grant", {
        grant_id,
        ...(reason ? { reason } : {}),
        context: rpcContext(requestedContext, context)
      }, { kind: "mutation", signal });
      return {
        data: {
          ...result,
          correlation_id: context.correlationId,
          outcome: "succeeded" as const
        }
      };
    }
  }));

  registry.add(defineCapability({
    id: "documents.record.unlink",
    name: "documents_unlink_from_record",
    title: "Unlink Document from Record",
    description:
      "Remove one active USL document relationship from one supported Odoo record in a single Odoo transaction. This removes the link only; it does not delete the document or business record.",
    layer: "business_action",
    toolsets: ["documents"],
    profiles: ["documents"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["unlink document", "remove relationship", "archive"],
    requiredModules: ["usl_documents"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 510,
    input: documentLinkInput,
    output: ActionOutputSchema,
    async handler({ document_id, model, id, context: requestedContext }, context, signal) {
      const result = await client.call<unknown>(context, "usl.document", "unlink_from_record", {
        ids: [document_id], res_model: model, res_id: id, context: rpcContext(requestedContext, context)
      }, { kind: "mutation", signal });
      return { data: { result, correlation_id: context.correlationId, outcome: "succeeded" as const } };
    }
  }));

  registry.add(defineCapability({
    id: "expenses.batch.context.apply",
    name: "expense_batches_apply_context",
    title: "Apply Expense Batch Context",
    description:
      "Atomically apply one expense batch's shared account/analytic context after a preview. Pass expected_revision to reject stale state; explicit exceptions are preserved unless their IDs are intentionally forced.",
    layer: "business_action",
    toolsets: ["expenses", "accounting"],
    profiles: ["accounting"],
    effect: "consequential",
    annotations: actionAnnotations,
    keywords: ["expense batch", "apply context", "revision", "atomic", "analytic"],
    requiredModules: ["usl_expense_batch"],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 520,
    input: z.object({
      batch_id: PositiveIdSchema,
      expense_ids: z.array(PositiveIdSchema).max(100).optional(),
      force_expense_ids: z.array(PositiveIdSchema).max(100).optional(),
      expected_revision: z.number().int().positive(),
      context: OdooContextSchema
    }).strict(),
    output: ActionOutputSchema,
    async handler({ batch_id, expense_ids, force_expense_ids, expected_revision, context: requestedContext }, context, signal) {
      const result = await client.call<unknown>(context, "usl.expense.batch", "apply_context", {
        ids: [batch_id],
        ...(expense_ids ? { expense_ids } : {}),
        ...(force_expense_ids ? { force_expense_ids } : {}),
        expected_revision,
        context: rpcContext(requestedContext, context)
      }, { kind: "mutation", signal });
      return { data: { result, correlation_id: context.correlationId, outcome: "succeeded" as const } };
    }
  }));

  for (const action of [
    { name: "expense_batches_submit", id: "expenses.batch.submit", method: "action_submit", effect: "consequential" as const, title: "Submit Expense Batch", verb: "submit draft expenses for manager review" },
    { name: "expense_batches_approve", id: "expenses.batch.approve", method: "action_approve", effect: "consequential" as const, title: "Approve Expense Batch", verb: "approve submitted expenses" },
    { name: "expense_batches_post", id: "expenses.batch.post", method: "action_post", effect: "consequential" as const, title: "Post Expense Batch", verb: "post accounting entries for approved expenses" }
  ]) {
    registry.add(defineCapability({
      id: action.id,
      name: action.name,
      title: action.title,
      description: `Run the Distribution's atomic expense-batch workflow to ${action.verb}. Use expense_batches_get_context immediately beforehand; Odoo validates the current state and performs the operation in one transaction.`,
      layer: "business_action",
      toolsets: ["expenses", "accounting"],
      profiles: ["accounting"],
      effect: action.effect,
      annotations: actionAnnotations,
      keywords: ["expense batch", action.method, "workflow", "atomic"],
      requiredModules: ["usl_expense_batch"],
      defaultVisible: false,
      alwaysLoad: false,
      sortOrder: action.name === "expense_batches_submit" ? 530 : action.name === "expense_batches_approve" ? 540 : 550,
      input: z.object({ batch_id: PositiveIdSchema, context: OdooContextSchema }).strict(),
      output: ActionOutputSchema,
      async handler({ batch_id, context: requestedContext }, context, signal) {
        const result = await client.call<unknown>(context, "usl.expense.batch", action.method, {
          ids: [batch_id], context: rpcContext(requestedContext, context)
        }, { kind: "mutation", signal });
        return { data: { result, correlation_id: context.correlationId, outcome: "succeeded" as const } };
      }
    }));
  }
}
