import { z } from "zod";
import type { RequestContext } from "../runtime/context.js";
import { emitEvent } from "../runtime/logging.js";
import { OdooClient } from "../odoo/client.js";
import {
  assertBoundedJson,
  attributedContext,
  CallScopeShape,
  decodeCursor,
  decodePageCursor,
  DomainSchema,
  encodeCursor,
  encodePageCursor,
  FieldNameSchema,
  FieldsSchema,
  htmlBodyContract,
  HTML_FLAG_CONTRACT,
  keysetDirection,
  ModelNameSchema,
  MethodNameSchema,
  normalizeWriteValues,
  OdooContextSchema,
  plaintextToParagraphHtml,
  type PageCursor,
  PositiveIdSchema,
  queryFingerprint,
  resolveCallScope,
  richTextHtml,
  SpecificationSchema
} from "../odoo/schemas.js";
import {
  CapabilityRegistry,
  defineCapability,
  type CapabilitySearchMatch
} from "./registry.js";

const RecordSchema = z.record(z.string(), z.unknown());
const RecordsSchema = z.array(RecordSchema);
const PageSchema = z.object({
  returned: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
  total: z.number().int().nonnegative().optional()
}).strict();
const ExecutionSchema = z.object({
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "unknown"])
}).strict();
// The escape hatch reports which contract Odoo's own readonly classification
// selected, so a caller can tell a retried read from a one-attempt mutation.
const MethodExecutionSchema = ExecutionSchema.extend({
  mode: z.enum(["read", "mutation"])
}).strict();

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

function recordReference(context: RequestContext, model: string, id: number, displayName?: unknown) {
  return {
    model,
    id,
    display_name: typeof displayName === "string" && displayName ? displayName : `${model},${id}`,
    url: `${context.principal.publicOrigin}/odoo/${model}/${id}`
  };
}

function decorateRecords(context: RequestContext, model: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Odoo ${model} result was not a record array`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Odoo ${model} returned an invalid record`);
    const record = item as Record<string, unknown>;
    const id = record.id;
    return Number.isInteger(id) && (id as number) > 0
      ? { ...record, _ref: recordReference(context, model, id as number, record.display_name ?? record.name) }
      : record;
  });
}

// `/doc-bearer` describes a field with roughly thirty attributes and a method with
// its full rendered documentation. On a model such as account.move that is over
// 150 KB, which no caller can use. Project to the attributes that change a
// decision, and report what was withheld so absence is never inferred from a cap.
const FIELD_ATTRIBUTES = [
  "type", "string", "relation", "required", "readonly", "store",
  "selection", "help", "groupable", "sortable", "company_dependent"
] as const;
const METHOD_ATTRIBUTES = ["signature", "api", "model", "module"] as const;

const SelectionPageSchema = z.object({
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  has_more: z.boolean(),
  detail: z.enum(["summary", "full"])
}).strict();

const emptySelectionPage = { total: 0, returned: 0, has_more: false, detail: "summary" as const };

function projectEntry(value: unknown, attributes: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const attribute of attributes) {
    if (source[attribute] !== undefined) projected[attribute] = source[attribute];
  }
  return projected;
}

const projectFieldEntry = (value: unknown) => projectEntry(value, FIELD_ATTRIBUTES);
const projectMethodEntry = (value: unknown) => projectEntry(value, METHOD_ATTRIBUTES);

interface SelectionOptions {
  names?: readonly string[];
  filter?: string;
  detail: "summary" | "full";
  limit: number;
  project(value: unknown): unknown;
}

function selectEntries(source: unknown, options: SelectionOptions): {
  entries: Record<string, unknown>;
  page: z.infer<typeof SelectionPageSchema>;
  warnings: string[];
} {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { entries: {}, page: { ...emptySelectionPage, detail: options.detail }, warnings: [] };
  }
  const all = source as Record<string, unknown>;
  const warnings: string[] = [];
  const filter = options.filter?.trim().toLowerCase();
  let names = Object.keys(all).sort();
  const total = names.length;
  if (options.names) {
    const requested = new Set(options.names);
    const missing = [...requested].filter((name) => !(name in all));
    if (missing.length > 0) {
      warnings.push(`${missing.slice(0, 20).join(", ")} ${missing.length === 1 ? "is" : "are"} not documented on this model.`);
    }
    names = names.filter((name) => requested.has(name));
  } else if (filter) {
    names = names.filter((name) => name.toLowerCase().includes(filter));
  }
  const selected = names.slice(0, options.limit);
  const hasMore = names.length > selected.length;
  if (hasMore) {
    warnings.push(
      `${names.length - selected.length} further entries matched but were withheld by the limit. `
      + "Filter by name or substring, or raise the limit, before concluding something is absent."
    );
  }
  const entries: Record<string, unknown> = {};
  for (const name of selected) {
    entries[name] = options.detail === "full" ? all[name] : options.project(all[name]);
  }
  return {
    entries,
    page: { total, returned: selected.length, has_more: hasMore, detail: options.detail },
    warnings
  };
}

// `create` answers with ids; `web_save` answers with the records read back,
// each carrying its id. Both prove which records now exist.
function resultIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  const ids = values
    .map((item) => (item && typeof item === "object" && !Array.isArray(item) ? (item as { id?: unknown }).id : item))
    .filter((item): item is number => Number.isInteger(item) && (item as number) > 0);
  if (ids.length === 0) throw new Error("Odoo did not return created record identifiers");
  return ids;
}

// web_search_read answers `{length, records}`; `length` is the total matching
// the domain (bounded by count_limit when one is passed), not the page size.
function webSearchReadRows(model: string, value: unknown): { rows: unknown[]; length: number | undefined } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Odoo ${model} web_search_read result was not an object`);
  }
  const result = value as { records?: unknown; length?: unknown };
  if (!Array.isArray(result.records)) throw new Error(`Odoo ${model} web_search_read result had no records`);
  return {
    rows: result.records,
    length: Number.isInteger(result.length) && (result.length as number) >= 0 ? result.length as number : undefined
  };
}

function recordId(record: Record<string, unknown>): number | undefined {
  return Number.isInteger(record.id) && (record.id as number) > 0 ? record.id as number : undefined;
}

const SELECTION_GUIDANCE =
  "Select output with fields (flat; many2one values are [id, display_name] pairs) or with specification, Odoo's nested read spec, e.g. {\"name\": {}, \"partner_id\": {\"fields\": {\"display_name\": {}, \"email\": {}}}, \"line_ids\": {\"fields\": {\"name\": {}}, \"limit\": 20}}: it follows relations to any depth in one call, and a bare {} on a relational field returns only ids.";


function capabilitySummary(match: CapabilitySearchMatch) {
  const { metadata } = match;
  return {
    id: metadata.id,
    name: metadata.name,
    title: metadata.title,
    description: metadata.description,
    layer: metadata.layer,
    toolsets: [...metadata.toolsets],
    effect: metadata.effect,
    availability: match.availability,
    visible_in_current_profile: match.visibleInCurrentProfile,
    callable_now: match.callableNow,
    profiles: [...metadata.profiles],
    always_load: metadata.alwaysLoad,
    required_modules: [...metadata.requiredModules],
    required_public_methods: metadata.requiredPublicMethods.map(({ model, method }) => ({ model, method })),
    required_any_public_methods: [...metadata.requiredAnyPublicMethods],
    required_model_access: metadata.requiredModelAccess.map(({ model, operation }) => ({
      ...(model ? { model } : {}),
      operation
    })),
    required_features: [...metadata.requiredFeatures]
  };
}

export function registerGenericCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "core.capabilities.search",
    name: "odoo_search_capabilities",
    title: "Search Odoo Capabilities",
    description:
      "Search the complete Odoo MCP catalogue by task, object, workflow, or domain. Results recommend callable tools and unknown-availability candidates, but never activate a tool, change the current profile, or alter tools/list. Tool visibility and Odoo authorization remain separate.",
    layer: "generic",
    toolsets: ["core"],
    // Absent from `default`, where every tool in the profile is already listed
    // statically and catalogue search only costs the caller context. It stays on
    // `all`, where deferred loading hides most schemas, and on the thematic and
    // read-only profiles, which each expose a subset of the catalogue.
    profiles: ["accounting", "projects", "documents", "b2c", "advanced"],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["discover", "tools", "workflow", "semantic", "business action"],
    requiredModules: [],
    defaultVisible: false,
    alwaysLoad: true,
    sortOrder: 0,
    input: z.object({
      query: z.string().max(300).default("").describe("Task, Odoo object, workflow, or capability to find"),
      limit: z.number().int().min(1).max(20).default(10)
    }).strict(),
    output: z.object({
      capabilities: z.array(z.object({
        id: z.string(),
        name: z.string(),
        title: z.string(),
        description: z.string(),
        layer: z.enum(["generic", "semantic", "business_action"]),
        toolsets: z.array(z.string()),
        effect: z.enum(["read", "write", "consequential", "irreversible"]),
        availability: z.enum(["available", "unknown"]),
        visible_in_current_profile: z.boolean(),
        callable_now: z.boolean(),
        profiles: z.array(z.string()),
        always_load: z.boolean(),
        required_modules: z.array(z.string()),
        required_public_methods: z.array(z.object({ model: z.string(), method: z.string() }).strict()),
        required_any_public_methods: z.array(z.string()),
        required_model_access: z.array(z.object({
          model: z.string().optional(),
          operation: z.enum(["read", "create", "write", "unlink"])
        }).strict()),
        required_features: z.array(z.string())
      }).strict()),
      recommended_fallback: z.object({
        name: z.string(),
        reason: z.string()
      }).strict().optional(),
      selection_note: z.string()
    }).strict(),
    async handler({ query, limit }, context) {
      const availability = {
        modules: context.availableModules,
        publicMethods: context.availablePublicMethods,
        modelAccess: context.availableModelAccess,
        enabledFeatures: context.enabledFeatures
      };
      const options = { profile: context.profile, availability } as const;
      const matches = registry.search(query, limit, options);
      const recommendedFallback = registry.recommendFallback(query, matches, options);
      emitEvent("mcp.capabilities.searched", {
        request_id: context.requestId,
        correlation_id: context.correlationId,
        profile: context.profile,
        target_id: context.principal.targetId,
        result_count: matches.length
      }, context.eventObserver);
      return {
        data: {
          capabilities: matches.map(capabilitySummary),
          ...(recommendedFallback ? { recommended_fallback: recommendedFallback } : {}),
          selection_note: "Catalogue results are advisory. This search does not activate tools, change profiles, or alter tools/list."
        }
      };
    }
  }));

  registry.add(defineCapability({
    id: "core.models.search",
    name: "odoo_search_models",
    title: "Search Odoo Models",
    description:
      "Find Odoo models visible to the current identity. Use before generic record operations when the technical model name is uncertain. Results prefer authenticated API documentation and include public-method and field counts when available.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["schema", "model discovery", "database", "objects"],
    requiredModules: [],
    defaultVisible: true,
    alwaysLoad: true,
    sortOrder: 10,
    input: z.object({
      query: z.string().max(200).default(""),
      limit: z.number().int().min(1).max(50).default(25),
      cursor: z.string().max(1000).optional()
    }).strict(),
    output: z.object({
      source: z.enum(["doc_bearer", "ir_model"]),
      models: z.array(z.object({
        model: z.string(),
        name: z.string(),
        documentation: z.string().optional(),
        field_count: z.number().int().nonnegative().optional(),
        method_count: z.number().int().nonnegative().optional()
      }).strict()),
      page: PageSchema
    }).strict(),
    async handler({ query, limit, cursor }, context, signal) {
      const normalized = query.trim().toLowerCase();
      const fingerprint = queryFingerprint({ query: normalized, limit });
      const offset = decodeCursor(cursor, fingerprint);
      try {
        const document = await client.fetchApiDocument<{ models?: unknown[] }>(context, undefined, signal);
        const all = (Array.isArray(document.models) ? document.models : [])
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
          .filter((item) => typeof item.model === "string")
          .map((item) => ({
            model: item.model as string,
            name: typeof item.name === "string" ? item.name : item.model as string,
            ...(typeof item.doc === "string" && item.doc ? { documentation: item.doc } : {}),
            field_count: item.fields && typeof item.fields === "object" ? Object.keys(item.fields).length : 0,
            method_count: Array.isArray(item.methods)
              ? item.methods.length
              : item.methods && typeof item.methods === "object" ? Object.keys(item.methods).length : 0
          }))
          .filter((item) => !normalized || `${item.model} ${item.name} ${item.documentation ?? ""}`.toLowerCase().includes(normalized))
          .sort((left, right) => left.model.localeCompare(right.model));
        const models = all.slice(offset, offset + limit);
        const hasMore = offset + models.length < all.length;
        return {
          data: {
            source: "doc_bearer" as const,
            models,
            page: {
              returned: models.length,
              has_more: hasMore,
              total: all.length,
              ...(hasMore ? { next_cursor: encodeCursor(offset + models.length, fingerprint) } : {})
            }
          }
        };
      } catch {
        const domain = normalized
          ? ["|", ["model", "ilike", query.trim()], ["name", "ilike", query.trim()]]
          : [];
        const rows = await client.call<unknown[]>(context, "ir.model", "search_read", {
          domain,
          fields: ["model", "name"],
          limit: limit + 1,
          offset,
          order: "model asc"
        }, { signal });
        const hasMore = rows.length > limit;
        const models = rows.slice(0, limit).flatMap((row) =>
          row && typeof row === "object" && !Array.isArray(row) && typeof (row as Record<string, unknown>).model === "string"
            ? [{
                model: (row as Record<string, unknown>).model as string,
                name: typeof (row as Record<string, unknown>).name === "string"
                  ? (row as Record<string, unknown>).name as string
                  : (row as Record<string, unknown>).model as string
              }]
            : []
        );
        return {
          data: {
            source: "ir_model" as const,
            models,
            page: {
              returned: models.length,
              has_more: hasMore,
              ...(hasMore ? { next_cursor: encodeCursor(offset + models.length, fingerprint) } : {})
            }
          },
          warnings: ["Authenticated API documentation was unavailable; method and field counts are omitted."]
        };
      }
    }
  }));

  registry.add(defineCapability({
    id: "core.models.describe",
    name: "odoo_describe_model",
    title: "Describe Odoo Model",
    description:
      "Return fields and Odoo-public JSON-2 methods for one model. Use before choosing fields, constructing relational traversals, or calling an unfamiliar public method. Results are projected and capped: filter with names or a substring, raise the caps, or set detail to \"full\" for complete metadata on the named entries. Check the returned totals and has_more flags before assuming a field or method is absent. This describes callable API metadata; it does not execute the method.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["schema", "fields", "methods", "signature", "API documentation"],
    requiredModules: [],
    defaultVisible: true,
    alwaysLoad: true,
    sortOrder: 20,
    input: z.object({
      model: ModelNameSchema,
      include_fields: z.boolean().default(true),
      include_methods: z.boolean().default(true),
      field_names: FieldsSchema.optional(),
      filter: z.string().max(100).optional(),
      field_limit: z.number().int().min(1).max(300).default(60),
      method_limit: z.number().int().min(1).max(300).default(60),
      detail: z.enum(["summary", "full"]).default("summary")
    }).strict(),
    output: z.object({
      source: z.enum(["doc_bearer", "fields_get"]),
      model: z.string(),
      name: z.string(),
      documentation: z.string(),
      fields: z.record(z.string(), z.unknown()),
      methods: z.record(z.string(), z.unknown()),
      fields_page: SelectionPageSchema,
      methods_page: SelectionPageSchema
    }).strict(),
    async handler(input, context, signal) {
      const { model, include_fields, include_methods, field_names, filter, field_limit, method_limit, detail } = input;
      const selection = { names: field_names, filter, detail } as const;
      try {
        const document = await client.fetchApiDocument<Record<string, unknown>>(context, model, signal);
        const fields = selectEntries(document.fields, {
          ...selection,
          limit: field_limit,
          project: projectFieldEntry
        });
        const methods = selectEntries(document.methods, {
          filter,
          detail,
          limit: method_limit,
          project: projectMethodEntry
        });
        return {
          data: {
            source: "doc_bearer" as const,
            model,
            name: typeof document.name === "string" ? document.name : model,
            documentation: typeof document.doc === "string" ? document.doc : "",
            fields: include_fields ? fields.entries : {},
            methods: include_methods ? methods.entries : {},
            fields_page: include_fields ? fields.page : emptySelectionPage,
            methods_page: include_methods ? methods.page : emptySelectionPage
          },
          warnings: [...(include_fields ? fields.warnings : []), ...(include_methods ? methods.warnings : [])]
        };
      } catch {
        const raw = include_fields
          ? await client.call<Record<string, unknown>>(context, model, "fields_get", {
              attributes: ["type", "string", "readonly", "required", "selection", "relation", "help"]
            }, { signal })
          : {};
        const fields = selectEntries(raw, { ...selection, limit: field_limit, project: projectFieldEntry });
        return {
          data: {
            source: "fields_get" as const,
            model,
            name: model,
            documentation: "",
            fields: fields.entries,
            methods: {},
            fields_page: include_fields ? fields.page : emptySelectionPage,
            methods_page: emptySelectionPage
          },
          warnings: [
            ...fields.warnings,
            ...(include_methods
              ? ["Authenticated API documentation was unavailable; public method metadata is omitted."]
              : [])
          ]
        };
      }
    }
  }));

  registry.add(defineCapability({
    id: "core.records.search",
    name: "odoo_search_records",
    title: "Search Odoo Records",
    description:
      "Search any accessible Odoo model with a typed domain. " + SELECTION_GUIDANCE
      + " Queries ordered by id alone page by keyset and never skip or repeat rows between pages. Use for cross-domain exploration and long-tail queries; prefer a specialized context tool when one performs the same common traversal more compactly.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["search_read", "web_search_read", "find", "filter", "records", "domain", "pagination", "specification", "relations"],
    requiredModules: [],
    defaultVisible: true,
    alwaysLoad: true,
    sortOrder: 30,
    input: z.object({
      model: ModelNameSchema,
      domain: DomainSchema,
      fields: FieldsSchema.optional(),
      specification: SpecificationSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      order: z.string().min(1).max(300).default("id asc"),
      cursor: z.string().max(1000).optional(),
      include_count: z.boolean().default(false),
      ...CallScopeShape,
      context: OdooContextSchema
    }).strict(),
    output: z.object({ records: RecordsSchema, page: PageSchema }).strict(),
    async handler(input, context, signal) {
      const { model, domain, fields, specification, limit, order, cursor, include_count, context: requestedContext, ...scope } = input;
      if (fields && specification) throw new Error("Pass either fields or specification, not both");
      const selection = specification ? { specification } : { fields: fields ?? ["display_name"] };
      const fingerprint = queryFingerprint({ model, domain, ...selection, order });
      const page = decodePageCursor(cursor, fingerprint);
      const direction = keysetDirection(order);
      if (page.kind === "keyset" && !direction) throw new Error("cursor does not match this query");
      const { context: rpcContext, warnings } = resolveCallScope({ ...scope, context: requestedContext }, context.correlationId);

      // A keyset page restricts the domain instead of skipping rows, so inserts
      // and deletes between pages cannot shift the window.
      const pageDomain = page.kind === "keyset"
        ? [["id", direction === "desc" ? "<" : ">", page.after], ...domain]
        : domain;
      const offset = page.kind === "offset" ? page.offset : 0;
      const countOriginalDomain = () =>
        client.call<number>(context, model, "search_count", { domain, context: rpcContext }, { signal });

      let rows: unknown[];
      let total: number | undefined;
      if (specification) {
        // web_search_read counts the domain it is given, which on a keyset page
        // is only the remainder; the exact total then needs the original domain.
        const exactTotalAvailable = include_count && page.kind === "offset";
        const result = await client.call<unknown>(context, model, "web_search_read", {
          domain: pageDomain,
          specification,
          offset,
          limit: limit + 1,
          order,
          ...(exactTotalAvailable ? {} : { count_limit: offset + limit + 1 }),
          context: rpcContext
        }, { signal });
        const parsed = webSearchReadRows(model, result);
        rows = parsed.rows;
        if (include_count) total = exactTotalAvailable ? parsed.length : await countOriginalDomain();
      } else {
        [rows, total] = await Promise.all([
          client.call<unknown[]>(context, model, "search_read", {
            domain: pageDomain,
            fields: selection.fields,
            limit: limit + 1,
            offset,
            order,
            context: rpcContext
          }, { signal }),
          include_count ? countOriginalDomain() : Promise.resolve(undefined)
        ]);
      }

      const hasMore = rows.length > limit;
      const records = decorateRecords(context, model, rows.slice(0, limit));
      const lastId = records.length > 0 ? recordId(records[records.length - 1]!) : undefined;
      const next: PageCursor | undefined = !hasMore
        ? undefined
        : direction && lastId !== undefined
          ? { kind: "keyset", after: lastId }
          : { kind: "offset", offset: offset + records.length };
      return {
        data: {
          records,
          page: {
            returned: records.length,
            has_more: hasMore,
            ...(total === undefined ? {} : { total }),
            ...(next ? { next_cursor: encodePageCursor(next, fingerprint) } : {})
          }
        },
        warnings
      };
    }
  }));

  registry.add(defineCapability({
    id: "core.records.read",
    name: "odoo_read_records",
    title: "Read Odoo Records",
    description:
      "Read known record IDs on one model, archived records included. " + SELECTION_GUIDANCE
      + " Use after a search or when a stable record reference is already known.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["read", "IDs", "fields", "record details", "specification", "relations"],
    requiredModules: [],
    defaultVisible: true,
    alwaysLoad: true,
    sortOrder: 40,
    input: z.object({
      model: ModelNameSchema,
      ids: z.array(PositiveIdSchema).min(1).max(100),
      fields: FieldsSchema.optional(),
      specification: SpecificationSchema.optional(),
      ...CallScopeShape,
      context: OdooContextSchema
    }).strict(),
    output: z.object({ records: RecordsSchema, missing_ids: z.array(z.number().int().positive()) }).strict(),
    async handler({ model, ids, fields, specification, context: requestedContext, ...scope }, context, signal) {
      if (fields && specification) throw new Error("Pass either fields or specification, not both");
      const uniqueIds = [...new Set(ids)];
      const { context: rpcContext, warnings } = resolveCallScope({ ...scope, context: requestedContext }, context.correlationId);
      let rows: unknown[];
      if (specification) {
        // Reading by id must see archived records, as `read` does. The search
        // behind web_search_read would hide them unless active_test is off.
        const readContext = "active_test" in rpcContext ? rpcContext : { ...rpcContext, active_test: false };
        const result = await client.call<unknown>(context, model, "web_search_read", {
          domain: [["id", "in", uniqueIds]],
          specification,
          limit: uniqueIds.length,
          order: "id asc",
          context: readContext
        }, { signal });
        rows = webSearchReadRows(model, result).rows;
      } else {
        rows = await client.call<unknown[]>(context, model, "read", {
          ids: uniqueIds,
          fields: fields ?? ["display_name"],
          context: rpcContext
        }, { signal });
      }
      const records = decorateRecords(context, model, rows);
      const returned = new Set(records.map((record) => record.id).filter((id): id is number => typeof id === "number"));
      return { data: { records, missing_ids: uniqueIds.filter((id) => !returned.has(id)) }, warnings };
    }
  }));

  registry.add(defineCapability({
    id: "core.records.expand",
    name: "odoo_expand_record",
    title: "Expand Odoo Record Relations",
    description:
      "Read one record and follow up to ten named many2one, one2many, or many2many fields by one hop. Superseded by specification on odoo_search_records and odoo_read_records, which follow relations to any depth in one call; retained for clients that already use it.",
    layer: "generic",
    toolsets: ["core"],
    // Off every static profile: `specification` on the search and read tools
    // does this to any depth in one call instead of one hop in N+1 calls.
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["relations", "traverse", "many2one", "one2many", "many2many", "context"],
    requiredModules: [],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 50,
    input: z.object({
      model: ModelNameSchema,
      id: PositiveIdSchema,
      fields: FieldsSchema.optional(),
      relations: z.array(z.object({
        field: FieldNameSchema,
        fields: FieldsSchema.max(20).optional(),
        limit: z.number().int().min(1).max(20).default(10)
      }).strict()).min(1).max(10),
      context: OdooContextSchema
    }).strict(),
    output: z.object({
      record: RecordSchema,
      relations: z.record(z.string(), z.object({
        model: z.string(),
        records: RecordsSchema,
        truncated: z.boolean()
      }).strict())
    }).strict(),
    async handler({ model, id, fields, relations, context: requestedContext }, context, signal) {
      const rpcContext = attributedContext(requestedContext, context.correlationId);
      const metadata = await client.call<Record<string, { type?: unknown; relation?: unknown }>>(context, model, "fields_get", {
        allfields: relations.map((relation) => relation.field),
        attributes: ["type", "relation"],
        context: rpcContext
      }, { signal });
      const baseFields = [...new Set(["display_name", ...(fields ?? []), ...relations.map((relation) => relation.field)])];
      const rows = await client.call<unknown[]>(context, model, "read", {
        ids: [id],
        fields: baseFields,
        context: rpcContext
      }, { signal });
      const [record] = decorateRecords(context, model, rows);
      if (!record) throw new Error(`${model},${id} was not found or is not readable`);
      const expanded: Record<string, { model: string; records: Record<string, unknown>[]; truncated: boolean }> = {};
      for (const relation of relations) {
        const field = metadata[relation.field];
        if (!field || typeof field.relation !== "string" || !["many2one", "one2many", "many2many"].includes(String(field.type))) {
          throw new Error(`${model}.${relation.field} is not a supported relational field`);
        }
        const raw = record[relation.field];
        const ids = String(field.type) === "many2one"
          ? Array.isArray(raw) && Number.isInteger(raw[0]) ? [raw[0] as number] : Number.isInteger(raw) ? [raw as number] : []
          : Array.isArray(raw) ? raw.filter((value): value is number => Number.isInteger(value) && (value as number) > 0) : [];
        const selected = ids.slice(0, relation.limit);
        const relatedRows = selected.length === 0
          ? []
          : await client.call<unknown[]>(context, field.relation, "read", {
              ids: selected,
              fields: relation.fields ?? ["display_name"],
              context: rpcContext
            }, { signal });
        expanded[relation.field] = {
          model: field.relation,
          records: decorateRecords(context, field.relation, relatedRows),
          truncated: ids.length > relation.limit
        };
      }
      return { data: { record, relations: expanded } };
    }
  }));

  registry.add(defineCapability({
    id: "core.records.aggregate",
    name: "odoo_aggregate_records",
    title: "Aggregate Odoo Records",
    description:
      "Group and aggregate accessible records on any model (Odoo formatted_read_group). groupby entries are field names, optionally with a date granularity such as \"invoice_date:month\"; aggregates are \"field:sum|avg|min|max|count\" or \"__count\", e.g. groupby [\"partner_id\", \"invoice_date:quarter\"] with aggregates [\"amount_total:sum\", \"__count\"]. Use for counts, sums, averages, and grouped cross-domain analysis; inspect field metadata first when groupability or aggregate support is uncertain.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["read_group", "sum", "count", "average", "group by", "analysis"],
    requiredModules: [],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 60,
    input: z.object({
      model: ModelNameSchema,
      domain: DomainSchema,
      groupby: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_]+)?$/)).max(5).default([]),
      aggregates: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_]+)?$/)).min(1).max(20),
      order: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      ...CallScopeShape,
      context: OdooContextSchema
    }).strict(),
    output: z.object({ rows: RecordsSchema }).strict(),
    async handler({ model, domain, groupby, aggregates, order, limit, context: requestedContext, ...scope }, context, signal) {
      const { context: rpcContext, warnings } = resolveCallScope({ ...scope, context: requestedContext }, context.correlationId);
      const rows = await client.call<unknown[]>(context, model, "formatted_read_group", {
        domain,
        groupby,
        aggregates,
        limit,
        ...(order ? { order } : {}),
        context: rpcContext
      }, { signal });
      return { data: { rows: decorateRecords(context, model, rows) }, warnings };
    }
  }));

  registry.add(defineCapability({
    id: "core.environment.describe",
    name: "odoo_describe_environment",
    title: "Describe Odoo Environment",
    description:
      "Describe the authenticated Odoo user, accessible companies, locale, and installed modules. Use before multi-company work or when a specialized capability may depend on an installed Distribution module.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "read",
    annotations: readAnnotations,
    keywords: ["user", "companies", "multi-company", "modules", "locale", "timezone"],
    requiredModules: ["usl_access_control"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 70,
    input: z.object({}).strict(),
    output: z.object({
      user: RecordSchema,
      companies: RecordsSchema,
      modules: z.array(z.string()),
      locale: z.object({ lang: z.string().optional(), tz: z.string().optional() }).strict(),
      principal_kind: z.literal("agent"),
      agent: z.object({
        id: z.number().int().positive(),
        name: z.string(),
        purpose: z.string(),
        access_mode: z.enum(["read_only", "read_write", "mixed"]),
        authority_reduced: z.boolean()
      }).strict(),
      owner: z.object({
        id: z.number().int().positive(),
        name: z.string()
      }).strict(),
      credential: z.object({
        id: z.number().int().positive(),
        name: z.string(),
        expires_at: z.string()
      }).strict(),
      effective_company_ids: z.array(z.number().int().positive()),
      effective_applications: z.array(z.object({
        id: z.union([z.number().int().positive(), z.literal("settings")]),
        name: z.string(),
        access: z.enum(["read_only", "read_write"])
      }).strict())
    }).strict(),
    async handler(_input, context, signal) {
      const identity = context.agentIdentity;
      if (!identity) throw new Error("The governed Agent identity was not resolved");
      const userContext = await client.call<Record<string, unknown>>(context, "res.users", "context_get", {}, { signal });
      const userId = userContext.uid;
      if (!Number.isInteger(userId) || (userId as number) <= 0) throw new Error("Odoo did not return the authenticated user id");
      const userRows = await client.call<unknown[]>(context, "res.users", "read", {
        ids: [userId],
        fields: ["display_name", "company_id", "company_ids", "lang", "tz"]
      }, { signal });
      const [user] = decorateRecords(context, "res.users", userRows);
      if (!user) throw new Error("The authenticated Odoo user is not readable");
      const companyIds = Array.isArray(user.company_ids)
        ? user.company_ids.filter((value): value is number => Number.isInteger(value) && (value as number) > 0)
        : [];
      const companyRows = companyIds.length === 0
        ? []
        : await client.call<unknown[]>(context, "res.company", "read", {
            ids: companyIds,
            fields: ["display_name", "parent_id", "currency_id"]
          }, { signal });
      const modules = [...(context.availableModules ?? [])];
      return {
        data: {
          user,
          companies: decorateRecords(context, "res.company", companyRows),
          modules,
          locale: {
            ...(typeof userContext.lang === "string" ? { lang: userContext.lang } : {}),
            ...(typeof userContext.tz === "string" ? { tz: userContext.tz } : {})
          },
          principal_kind: identity.principal_kind,
          agent: {
            id: identity.agent.id,
            name: identity.agent.name,
            purpose: identity.agent.purpose,
            access_mode: identity.agent.access_mode,
            authority_reduced: identity.agent.authority_reduced
          },
          owner: identity.owner,
          credential: identity.credential,
          effective_company_ids: identity.company_ids,
          effective_applications: identity.effective_applications
        },
        ...(modules.length === 0 ? { warnings: ["Installed module metadata was unavailable for this identity."] } : {})
      };
    }
  }));

  registry.add(defineCapability({
    id: "core.records.create",
    name: "odoo_create_records",
    title: "Create Odoo Records",
    description:
      "Create one or more records on one model in a single Odoo call and transaction. Use only after describing the model and required fields. Relational (x2many) fields accept either raw Odoo command tuples or the named form {link|unlink|delete|set: [ids]}, {create: [values]}, {update: [{id, values}]}, {clear: true}, which is validated and lowered to those tuples. Pass specification to read the created records back in the same transaction and skip a follow-up read. Do not use this to emulate a multi-step business workflow that has a purpose-built action.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "write",
    annotations: writeAnnotations,
    keywords: ["create", "insert", "new record"],
    requiredModules: [],
    requiredModelAccess: [{ operation: "create" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 80,
    input: z.object({
      model: ModelNameSchema,
      values: z.array(RecordSchema).min(1).max(100),
      specification: SpecificationSchema.optional(),
      ...CallScopeShape,
      context: OdooContextSchema
    }).strict(),
    output: z.object({
      ids: z.array(z.number().int().positive()),
      records: z.array(z.object({ model: z.string(), id: z.number().int().positive(), display_name: z.string(), url: z.string() }).strict()),
      read_back: RecordsSchema.optional(),
      execution: ExecutionSchema
    }).strict(),
    async handler({ model, values, specification, context: requestedContext, ...scope }, context, signal) {
      const normalized = values.map((entry) => normalizeWriteValues(entry));
      assertBoundedJson(normalized);
      const { context: rpcContext, warnings } = resolveCallScope({ ...scope, context: requestedContext }, context.correlationId);
      const mutation = {
        kind: "mutation" as const,
        signal,
        reconciliation: {
          targetModel: model,
          suggestedTool: "odoo_search_records",
          fields: [...new Set(values.flatMap((value) => Object.keys(value)))].slice(0, 100),
          instructions: "Search with a selective domain built from stable fields in the original values. If no stable unique fields exist, report that the create cannot be reconciled safely and do not repeat it."
        }
      };
      // `web_save` called without ids creates one record and reads it back in
      // the one transaction `create` would have used. Odoo's `web_save_multi`
      // only writes to records that already exist, so a batch is created with
      // `create` and then read back through `web_search_read` by id, the same
      // call odoo_read_records uses; a read-back failure after a successful
      // create reports an unknown outcome with the created ids.
      const singleReadBack = Boolean(specification) && normalized.length === 1;
      const receipt = singleReadBack
        ? await client.call<unknown>(context, model, "web_save", {
            vals: normalized[0],
            specification,
            context: rpcContext
          }, mutation)
        : await client.call<unknown>(context, model, "create", { vals_list: normalized, context: rpcContext }, mutation);
      return receipt.finalize(async (result) => {
        const ids = resultIds(result);
        let readBack: unknown = singleReadBack ? result : undefined;
        if (specification && !singleReadBack) {
          const result = await client.call<unknown>(context, model, "web_search_read", {
            domain: [["id", "in", ids]],
            specification,
            limit: ids.length,
            order: "id asc",
            context: "active_test" in rpcContext ? rpcContext : { ...rpcContext, active_test: false }
          }, { signal });
          readBack = webSearchReadRows(model, result).rows;
        }
        return {
          data: {
            ids,
            records: ids.map((id) => recordReference(context, model, id)),
            ...(specification ? { read_back: decorateRecords(context, model, readBack) } : {}),
            execution: { correlation_id: context.correlationId, outcome: "succeeded" as const }
          },
          warnings
        };
      }, (result) => ({ knownIds: resultIds(result) }));
    }
  }));

  registry.add(defineCapability({
    id: "core.records.update",
    name: "odoo_update_records",
    title: "Update Odoo Records",
    description:
      "Apply one values object to 1-100 records on one model in a single Odoo call and transaction. Read the records first. Relational (x2many) fields accept either raw Odoo command tuples or the named form {link|unlink|delete|set: [ids]}, {create: [values]}, {update: [{id, values}]}, {clear: true}, which is validated and lowered to those tuples. Pass specification to read the updated records back in the same transaction and skip a follow-up read. Heterogeneous updates and multi-step workflow transitions are intentionally not bundled here.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "write",
    annotations: writeAnnotations,
    keywords: ["write", "update", "edit", "change fields"],
    requiredModules: [],
    requiredModelAccess: [{ operation: "write" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 90,
    input: z.object({
      model: ModelNameSchema,
      ids: z.array(PositiveIdSchema).min(1).max(100),
      values: RecordSchema.describe("Field values, written exactly as given. An HTML field such as description is not escaped and not wrapped here."),
      specification: SpecificationSchema.optional(),
      ...CallScopeShape,
      context: OdooContextSchema
    }).strict(),
    output: z.object({
      updated: z.boolean(),
      ids: z.array(z.number().int().positive()),
      read_back: RecordsSchema.optional(),
      execution: ExecutionSchema
    }).strict(),
    async handler({ model, ids, values, specification, context: requestedContext, ...scope }, context, signal) {
      const normalized = normalizeWriteValues(values);
      assertBoundedJson(normalized);
      const uniqueIds = [...new Set(ids)];
      const { context: rpcContext, warnings } = resolveCallScope({ ...scope, context: requestedContext }, context.correlationId);
      const mutation = {
        kind: "mutation" as const,
        signal,
        reconciliation: {
          targetModel: model,
          knownIds: uniqueIds,
          fields: Object.keys(values).slice(0, 100),
          suggestedTool: "odoo_read_records",
          instructions: "Read these records and compare the named fields with the original patch. Keep matching values, and send only a minimal corrective patch for values that are still absent."
        }
      };
      // web_save on a recordset writes the one values object to every record
      // and reads them back in the same transaction `write` would have used.
      const receipt = specification
        ? await client.call<unknown>(context, model, "web_save", {
            ids: uniqueIds,
            vals: normalized,
            specification,
            context: rpcContext
          }, mutation)
        : await client.call<unknown>(context, model, "write", { ids: uniqueIds, vals: normalized, context: rpcContext }, mutation);
      return receipt.finalize((result) => ({
        data: {
          updated: specification ? Array.isArray(result) : Boolean(result),
          ids: uniqueIds,
          ...(specification ? { read_back: decorateRecords(context, model, result) } : {}),
          execution: { correlation_id: context.correlationId, outcome: "succeeded" as const }
        },
        warnings
      }));
    }
  }));

  registry.add(defineCapability({
    id: "core.records.archive",
    name: "odoo_archive_records",
    title: "Archive Odoo Records",
    description:
      "Archive 1-100 records through Odoo's inherited action_archive in one transaction. Prefer this reversible operation to deletion. Models without an active field return an Odoo validation error.",
    layer: "generic",
    toolsets: ["core"],
    profiles: [],
    effect: "write",
    annotations: writeAnnotations,
    keywords: ["archive", "deactivate", "reversible removal"],
    requiredModules: [],
    requiredAnyPublicMethods: ["action_archive"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 100,
    input: z.object({ model: ModelNameSchema, ids: z.array(PositiveIdSchema).min(1).max(100), context: OdooContextSchema }).strict(),
    output: z.object({ archived: z.boolean(), ids: z.array(z.number().int().positive()), execution: ExecutionSchema }).strict(),
    async handler({ model, ids, context: requestedContext }, context, signal) {
      const uniqueIds = [...new Set(ids)];
      const receipt = await client.call(context, model, "action_archive", {
        ids: uniqueIds,
        context: attributedContext(requestedContext, context.correlationId)
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: model,
          knownIds: uniqueIds,
          fields: ["active"],
          suggestedTool: "odoo_read_records",
          instructions: "Read the active field for these records. Retry only records that are still active and readable."
        }
      });
      return receipt.finalize(() => ({ data: { archived: true, ids: uniqueIds, execution: { correlation_id: context.correlationId, outcome: "succeeded" as const } } }));
    }
  }));

  registry.add(defineCapability({
    id: "core.messages.post",
    name: "odoo_post_message",
    title: "Post Odoo Message",
    description:
      "Post one note or message to one chatter-enabled record. Use a separate call for each record so failures and side effects remain clear. Plain text is escaped before being sent as HTML.",
    layer: "generic",
    toolsets: ["core", "activities"],
    profiles: [],
    effect: "write",
    annotations: writeAnnotations,
    keywords: ["chatter", "note", "comment", "message_post"],
    requiredModules: ["mail"],
    requiredAnyPublicMethods: ["message_post"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 110,
    input: z.object({
      model: ModelNameSchema,
      id: PositiveIdSchema,
      body: z.string().min(1).max(50_000).describe(htmlBodyContract("body_is_html")),
      subtype: z.enum(["mail.mt_note", "mail.mt_comment"]).default("mail.mt_note"),
      body_is_html: z.boolean().default(false).describe(HTML_FLAG_CONTRACT),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ result: z.unknown(), execution: ExecutionSchema }).strict(),
    async handler({ model, id, body, subtype, body_is_html, context: requestedContext }, context, signal) {
      const message = richTextHtml({
        value: body,
        isHtml: body_is_html,
        field: "body",
        flagField: "body_is_html",
        plaintext: plaintextToParagraphHtml
      });
      const receipt = await client.call<unknown>(context, model, "message_post", {
        ids: [id],
        body: message.html,
        body_is_html: true,
        subtype_xmlid: subtype,
        context: attributedContext(requestedContext, context.correlationId)
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: model,
          knownIds: [id],
          fields: ["message_ids"],
          suggestedTool: "odoo_read_records",
          instructions: "Read the record's chatter references and inspect recent messages for the original note before posting it again."
        }
      });
      return receipt.finalize((result) => ({
        data: { result, execution: { correlation_id: context.correlationId, outcome: "succeeded" as const } },
        ...(message.warnings.length ? { warnings: message.warnings } : {})
      }));
    }
  }));

  registry.add(defineCapability({
    id: "core.following.self",
    name: "odoo_set_self_following",
    title: "Follow or Unfollow Odoo Record",
    description:
      "Follow or unfollow the authenticated Agent on one readable Chatter record. This cannot add or remove any other follower.",
    layer: "generic",
    toolsets: ["core", "activities"],
    profiles: [],
    effect: "write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    keywords: ["follow", "unfollow", "follower", "chatter", "subscribe"],
    requiredModules: ["mail"],
    requiredAnyPublicMethods: ["message_subscribe", "message_unsubscribe"],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 115,
    input: z.object({
      model: ModelNameSchema,
      id: PositiveIdSchema,
      following: z.boolean(),
      context: OdooContextSchema
    }).strict(),
    output: z.object({ following: z.boolean(), execution: ExecutionSchema }).strict(),
    async handler({ model, id, following, context: requestedContext }, context, signal) {
      const partnerId = context.agentIdentity?.agent.partner_id;
      if (!partnerId) throw new Error("The governed Agent partner identity was not resolved");
      const receipt = await client.call<unknown>(
        context,
        model,
        following ? "message_subscribe" : "message_unsubscribe",
        {
          ids: [id],
          partner_ids: [partnerId],
          context: attributedContext(requestedContext, context.correlationId)
        },
        {
          kind: "mutation",
          signal,
          reconciliation: {
            targetModel: model,
            knownIds: [id],
            fields: ["message_partner_ids"],
            suggestedTool: "odoo_read_records",
            instructions: "Read the record's followers before repeating the subscription change."
          }
        }
      );
      return receipt.finalize(() => ({
        data: {
          following,
          execution: { correlation_id: context.correlationId, outcome: "succeeded" as const }
        }
      }));
    }
  }));

  registry.add(defineCapability({
    id: "advanced.records.delete",
    name: "odoo_delete_records",
    title: "Delete Odoo Records",
    description:
      "Permanently unlink 1-100 records in one Odoo transaction. This advanced tool is excluded from the default profile; prefer odoo_archive_records whenever the model supports archival. Odoo permissions and irreversible-action policy remain authoritative.",
    layer: "generic",
    toolsets: ["advanced"],
    profiles: ["advanced"],
    effect: "irreversible",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    keywords: ["delete", "unlink", "permanent", "irreversible"],
    requiredModules: [],
    requiredModelAccess: [{ operation: "unlink" }],
    defaultVisible: false,
    alwaysLoad: false,
    sortOrder: 900,
    input: z.object({ model: ModelNameSchema, ids: z.array(PositiveIdSchema).min(1).max(100), context: OdooContextSchema }).strict(),
    output: z.object({ deleted: z.boolean(), ids: z.array(z.number().int().positive()), execution: ExecutionSchema }).strict(),
    async handler({ model, ids, context: requestedContext }, context, signal) {
      const uniqueIds = [...new Set(ids)];
      const receipt = await client.call<boolean>(context, model, "unlink", {
        ids: uniqueIds,
        context: attributedContext(requestedContext, context.correlationId)
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: model,
          knownIds: uniqueIds,
          fields: ["display_name"],
          suggestedTool: "odoo_read_records",
          instructions: "Read the IDs before any repeat. A missing record may be deleted or merely inaccessible; do not claim deletion unless access and surrounding records establish it."
        }
      });
      return receipt.finalize((deleted) => ({ data: { deleted: Boolean(deleted), ids: uniqueIds, execution: { correlation_id: context.correlationId, outcome: "succeeded" as const } } }));
    }
  }));

  registry.add(defineCapability({
    id: "advanced.methods.call",
    name: "odoo_call_method",
    title: "Call Public Odoo Method",
    description:
      "Call any Odoo-public JSON-2 model method with named kwargs and optional record IDs. Use as an advanced escape hatch for long-tail Distribution functionality, and for ORM methods with no dedicated tool such as onchange (Odoo-computed defaults and derived values for a draft), name_search (resolve a label to an id the way Odoo does), has_access, copy or get_external_id, after inspecting odoo_describe_model when possible. Odoo's own readonly classification decides the execution contract: a method Odoo publishes as readonly is retried like a read, anything else gets one attempt and may report an unknown outcome. Do not use it to chain a supposedly atomic workflow; use one purpose-built business action instead. Private and @api.private methods remain unavailable through Odoo.",
    layer: "generic",
    toolsets: ["core", "advanced"],
    profiles: ["advanced"],
    effect: "consequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    keywords: ["public method", "JSON-2", "escape hatch", "model action", "workflow", "ORM"],
    requiredModules: [],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 910,
    input: z.object({
      model: ModelNameSchema,
      method: MethodNameSchema,
      ids: z.array(PositiveIdSchema).min(1).max(100).optional(),
      kwargs: RecordSchema.default({}),
      ...CallScopeShape,
      context: OdooContextSchema
    }).strict(),
    output: z.object({ result: z.unknown(), execution: MethodExecutionSchema }).strict(),
    async handler({ model, method, ids, kwargs, context: requestedContext, ...scope }, context, signal) {
      if ("ids" in kwargs || "context" in kwargs) {
        throw new Error("Pass ids and context through their dedicated parameters, not kwargs");
      }
      assertBoundedJson(kwargs);
      const uniqueIds = ids ? [...new Set(ids)] : undefined;
      const { context: rpcContext, warnings } = resolveCallScope({ ...scope, context: requestedContext }, context.correlationId);
      const payload = {
        ...kwargs,
        ...(uniqueIds ? { ids: uniqueIds } : {}),
        context: rpcContext
      };
      // Odoo publishes each public method's `api` classification. A method it
      // states is readonly cannot commit, so executing it under the mutation
      // contract would deny it retries and label a plain read destructive.
      // Anything Odoo does not explicitly classify keeps the mutation contract.
      const readonly = await client.methodIsReadonly(context, model, method, signal);
      if (readonly === true) {
        const result = await client.call<unknown>(context, model, method, payload, { signal });
        return {
          data: {
            result,
            execution: { correlation_id: context.correlationId, outcome: "succeeded" as const, mode: "read" as const }
          },
          warnings
        };
      }
      const receipt = await client.call<unknown>(context, model, method, payload, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: model,
          ...(uniqueIds ? { knownIds: uniqueIds } : {}),
          suggestedTool: uniqueIds ? "odoo_read_records" : "odoo_search_records",
          instructions: "Inspect the method's documented effects and fetch the affected records. Because this is an arbitrary public method, retry only after its business effect is proven absent."
        }
      });
      return receipt.finalize((result) => ({
        data: {
          result,
          execution: { correlation_id: context.correlationId, outcome: "succeeded" as const, mode: "mutation" as const }
        },
        warnings
      }));
    }
  }));
}
