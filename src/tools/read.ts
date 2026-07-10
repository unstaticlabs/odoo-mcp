import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { CURATED_MODEL_ACTIONS, type CuratedAction } from "./actions-map";
import {
  CORE_MODEL_ALLOWLIST,
  DEFAULT_TASK_FIELDS,
  NAMED_FIELD_PRESET_VALUES,
  browseRecords,
  countRecords,
  decodeBrowseCursor,
  fetchRecordChatter,
  MAX_ODOO_CALLS_PER_READ_EXPANSION,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  pickSmartFields,
  requireConnection,
  searchRecords,
  searchRecordsCompact,
  zCompactReadEnvelope,
  zOdooRecord,
  zOdooRecords,
  zWarnings
} from "./shared";
import { aggregateRecords } from "../aggregation";
import { deriveWorkflowStatus, normalizeRecords } from "../normalizer";
import { type CachedFieldMeta, type TtlCache, getFieldsCached } from "../cache";
import { OdooError } from "../odoo";

const zFieldOmission = z.object({ field: z.string(), reason: z.string() });
const zFieldsReport = {
  returned_fields: z.array(z.string()).describe("List of fields successfully returned by Odoo"),
  omitted_fields: z
    .array(zFieldOmission)
    .describe("Fields requested but omitted from Odoo response"),
  warnings: zWarnings
};

export interface ModelAction {
  method: string;
  label?: string;
  confirm?: string;
  source: "view" | "curated";
}

const BUTTON_TAG_RE = /<button\b([^>]*)>/gi;
const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;

/** Exported for unit testing. Regex-based (no XML parser dependency): extracts type="object" button methods from a form-view arch string. */
export function parseButtonsFromArch(arch: string | undefined | null): ModelAction[] {
  if (!arch) return [];
  const seen = new Set<string>();
  const buttons: ModelAction[] = [];
  const tagRe = new RegExp(BUTTON_TAG_RE.source, BUTTON_TAG_RE.flags);
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(arch)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = new RegExp(ATTR_RE.source, ATTR_RE.flags);
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(tagMatch[1])) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    if (attrs.type !== "object") continue;
    const method = attrs.name;
    if (!method || seen.has(method)) continue;
    seen.add(method);
    buttons.push({
      method,
      ...(attrs.string ? { label: attrs.string } : {}),
      ...(attrs.confirm ? { confirm: attrs.confirm } : {}),
      source: "view"
    });
  }
  return buttons;
}

/** Exported for unit testing. Merges curated actions with view-discovered ones; on duplicate method the view entry wins. */
export function mergeModelActions(curated: CuratedAction[], viewActions: ModelAction[]): ModelAction[] {
  const merged = new Map<string, ModelAction>();
  for (const action of curated) {
    merged.set(action.method, {
      method: action.method,
      ...(action.label ? { label: action.label } : {}),
      ...(action.confirm ? { confirm: action.confirm } : {}),
      source: "curated"
    });
  }
  for (const action of viewActions) {
    merged.set(action.method, action);
  }
  return Array.from(merged.values());
}

export function registerReadTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue, cache: TtlCache) {
  server.registerTool(
    "projects.list_tasks",
    {
      title: "List Project Tasks",
      description: "Read-only: list Odoo project.task records matching a domain.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_TASK_FIELDS)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.task records"),
        ...zFieldsReport
      }
    },
    async ({ domain, fields }) => {
      try {
        const warnings: string[] = [];
        const { rows: tasks, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          "project.task",
          domain,
          fields,
          100,
          undefined,
          undefined,
          cache,
          warnings
        );
        return mcpStructured(
          {
            records: tasks as Record<string, unknown>[],
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(tasks, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "search_read" });
      }
    }
  );

  server.registerTool(
    "projects.list_chatter",
    {
      title: "List Project Task Chatter",
      description:
        "Read-only: canonical multi-task project-management chatter path for project.task. " +
        "Fetches mail.message entries per task id with one scoped search_read each (never batches res_id in [...] with body). " +
        "Do not use search_records or browse_records on mail.message with res_id in [...] and body/preview — MCP hosts may block finance-keyword content. " +
        "For a single task, expand_record({ model: \"project.task\", record_id, include_chatter: true, include_attachments: false }) is equivalent. " +
        "Accounting chatter on invoices/journals → bookkeeping.*, not this tool. " +
        `Caps at ${MAX_ODOO_CALLS_PER_READ_EXPANSION} Odoo calls per invocation; remaining task_ids are returned in metadata.truncated_task_ids.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        task_ids: z.array(z.number().int().positive()).min(1).max(25),
        limit_per_task: z.number().int().min(1).max(50).default(20),
        order: z.string().default("date desc")
      },
      outputSchema: {
        chatter_by_task_id: z.record(z.string(), z.unknown()),
        metadata: z.object({
          model: z.literal("project.task"),
          requested_task_ids: z.array(z.number()),
          fetched_task_ids: z.array(z.number()),
          odoo_calls: z.number(),
          truncated_task_ids: z.array(z.number()).optional()
        }),
        warnings: zWarnings
      }
    },
    async ({ task_ids, limit_per_task, order }) => {
      const conn = requireConnection(getProps());
      const seen = new Set<number>();
      const requestedTaskIds: number[] = [];
      for (const id of task_ids) {
        if (!seen.has(id)) {
          seen.add(id);
          requestedTaskIds.push(id);
        }
      }

      const startSnapshot = queue.snapshot();
      const callsUsed = () => queue.delta(startSnapshot).odoo_calls;
      const chatterByTaskId: Record<string, unknown> = {};
      const fetchedTaskIds: number[] = [];
      const truncatedTaskIds: number[] = [];
      const warnings: string[] = [];

      for (const taskId of requestedTaskIds) {
        if (callsUsed() >= MAX_ODOO_CALLS_PER_READ_EXPANSION) {
          truncatedTaskIds.push(taskId);
          continue;
        }
        chatterByTaskId[String(taskId)] = await fetchRecordChatter(queue, conn, "project.task", taskId, {
          limit: limit_per_task,
          order
        });
        fetchedTaskIds.push(taskId);
      }

      if (truncatedTaskIds.length > 0) {
        warnings.push("call budget exceeded; re-invoke for remaining task_ids");
      }

      return mcpStructured({
        chatter_by_task_id: chatterByTaskId,
        metadata: {
          model: "project.task" as const,
          requested_task_ids: requestedTaskIds,
          fetched_task_ids: fetchedTaskIds,
          odoo_calls: callsUsed(),
          ...(truncatedTaskIds.length > 0 ? { truncated_task_ids: truncatedTaskIds } : {})
        },
        warnings
      });
    }
  );

  server.registerTool(
    "list_models",
    {
      title: "List Models",
      description: "Read-only: list enabled/installed Odoo models (name and technical model name).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
      outputSchema: {
        records: zOdooRecords.describe("Installed models (technical `model` name, plus `name` when available)")
      }
    },
    async () => {
      const conn = requireConnection(getProps());
      try {
        const { rows } = await searchRecords(queue, conn, "ir.model", [], ["model", "name"], 100);
        return mcpStructured({ records: rows as Record<string, unknown>[] }, JSON.stringify(rows, null, 2));
      } catch {
        const fallback = CORE_MODEL_ALLOWLIST.map((model) => ({ model }));
        return mcpStructured({ records: fallback }, JSON.stringify(fallback, null, 2));
      }
    }
  );

  server.registerTool(
    "search_records",
    {
      title: "Search Records",
      description:
        "Read-only: model-agnostic Odoo search_read. " +
        "For project.task chatter, use projects.list_chatter or per-id expand_record — not bulk mail.message reads with body/preview.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).nullable().default(null),
        limit: z.number().int().min(1).max(100).default(10),
        order: z.string().optional(),
        offset: z.number().int().min(0).default(0)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching records with the requested (or preset-default) fields"),
        ...zFieldsReport
      }
    },
    async ({ model, domain, fields, limit, order, offset }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const warnings: string[] = [];
        const { rows, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          model,
          domain,
          fields,
          limit,
          order,
          offset,
          cache,
          warnings
        );
        return mcpStructured(
          {
            records: rows as Record<string, unknown>[],
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(rows, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
    }
  );

  const zNamedFieldPreset = z.enum(NAMED_FIELD_PRESET_VALUES);

  const zSearchRecordsCompactInput = z
    .object({
      model: z.string(),
      domain: z.array(z.any()).default([]),
      field_preset: zNamedFieldPreset.default("minimal"),
      fields: z.array(z.string()).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
      order: z.string().optional(),
      search_count: z.boolean().default(true)
    })
    .refine(
      (data) =>
        data.fields == null || data.fields.length === 0 || data.field_preset === "minimal",
      { message: "cannot set both explicit fields and a non-default field_preset" }
    );

  server.registerTool(
    "search_records_compact",
    {
      title: "Search Records (compact)",
      description:
        "Read-only: compact paginated Odoo search_read for triage. Defaults to field_preset=minimal, limit=25. " +
        "Returns CompactReadEnvelope with nested fields manifest and page metadata. " +
        "Drill into selected ids via batch_read or get_record. " +
        'Pass stable order (e.g. "id asc") when paging.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: zSearchRecordsCompactInput,
      outputSchema: zCompactReadEnvelope
    },
    async (input) => {
      if (!input.model?.trim()) return mcpError("model must be a non-empty string");
      try {
        const warnings: string[] = [];
        const envelope = await searchRecordsCompact(
          queue,
          requireConnection(getProps()),
          input,
          warnings
        );
        return mcpStructured(envelope as unknown as Record<string, unknown>);
      } catch (err) {
        return mcpErrorFromException(err, { model: input.model, method: "search_read" });
      }
    }
  );

  const zBrowseRecordsInput = z
    .object({
      model: z.string(),
      domain: z.array(z.any()).default([]),
      field_preset: zNamedFieldPreset.default("minimal"),
      fields: z.array(z.string()).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
      cursor: z.string().nullable().default(null),
      order: z.string().optional()
    })
    .refine(
      (data) =>
        data.fields == null || data.fields.length === 0 || data.field_preset === "minimal",
      { message: "cannot set both explicit fields and a non-default field_preset" }
    );

  server.registerTool(
    "browse_records",
    {
      title: "Browse Records (compact)",
      description:
        "Read-only: compact, paginated Odoo search for triage at scale. Defaults to `field_preset=\"minimal\"` " +
        "and `limit=25` with mandatory page metadata (`count`, `has_more`, `next_offset`). " +
        "Use `batch_read` or `get_record` on selected ids for full detail. " +
        "Pass a stable `order` (e.g. `\"id asc\"`) when paging across multiple calls.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: zBrowseRecordsInput,
      outputSchema: {
        records: zOdooRecords.describe("Compact matching records for the resolved field preset"),
        page: z.object({
          offset: z.number().int(),
          limit: z.number().int(),
          count: z.number().int(),
          returned: z.number().int(),
          has_more: z.boolean(),
          next_offset: z.number().int().nullable(),
          next_cursor: z.string().nullable().optional()
        }),
        field_preset: zNamedFieldPreset.nullable(),
        fields_resolution: z.object({
          source: z.enum(["explicit", "preset", "fallback"]),
          model: z.string()
        }),
        returned_fields: z.array(z.string()),
        omitted_fields: z.array(z.object({ field: z.string(), reason: z.string() })),
        warnings: zWarnings,
        safeguard_applied: z.string().optional()
      }
    },
    async ({ model, domain, field_preset, fields, limit, offset, cursor, order }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      const effectivePreset = field_preset ?? "minimal";

      let effectiveOffset = offset;
      if (cursor) {
        const decoded = decodeBrowseCursor(cursor, { model, domain, order });
        if ("error" in decoded) return mcpError(decoded.error);
        effectiveOffset = decoded.offset;
      }

      try {
        const warnings: string[] = [];
        const result = await browseRecords(queue, requireConnection(getProps()), {
          model,
          domain,
          fieldPreset: effectivePreset,
          fields,
          limit,
          offset: effectiveOffset,
          order
        }, warnings);
        return mcpStructured(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Result too large")) {
          return mcpError(err.message);
        }
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
    }
  );

  server.registerTool(
    "search_count",
    {
      title: "Search Count",
      description: "Read-only: model-agnostic Odoo search_count — count records matching a domain without fetching them.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).default([])
      },
      outputSchema: {
        count: z.number().int().describe("Number of records matching the domain")
      }
    },
    async ({ model, domain }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const count = await countRecords(queue, requireConnection(getProps()), model, domain);
        return mcpStructured({ count }, JSON.stringify({ count }));
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "search_count failed");
      }
    }
  );

  server.registerTool(
    "aggregate_records",
    {
      title: "Aggregate Records",
      description:
        "Read-only: model-agnostic Odoo grouped aggregation via native `read_group`, with a bounded connector-side " +
        "fallback when read_group is unavailable. Fallback scans at most 100 records per call (`limit`/`offset`); " +
        "check `metadata.fallback` and `warnings` in the response. See README for groupby matrix and error codes.\n\n" +
        "`groupby` and `aggregates` follow Odoo read_group syntax (e.g. `amount_total:sum`, `invoice_date:month`, `__count`).\n\n" +
        "Example 1 — group vendor bills by month:\n" +
        '{ "model": "account.move", "domain": [["move_type", "=", "in_invoice"]], ' +
        '"groupby": ["invoice_date:month"], "aggregates": ["amount_total:sum"] }\n\n' +
        "Example 2 — count tasks per stage (native path):\n" +
        '{ "model": "project.task", "groupby": ["stage_id"], "aggregates": ["__count"] } → metadata.fallback=false\n\n' +
        "Example 3 — fallback with pagination when has_more is true:\n" +
        '{ "model": "custom.model", "groupby": ["state"], "aggregates": ["__count"], "limit": 100, "offset": 100 }',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).default([]),
        groupby: z.array(z.string()).min(1),
        aggregates: z.array(z.string()).min(1),
        lazy: z.boolean().default(true),
        orderby: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(100),
        offset: z.number().int().min(0).default(0)
      },
      outputSchema: {
        groups: zOdooRecords.describe("read_group-compatible rows: groupby keys and aggregate values per group"),
        metadata: z
          .object({
            fallback: z.boolean().describe("true when connector-side in-memory grouping was used instead of native read_group"),
            records_scanned: z.number().int().describe("Records read in fallback (0 for native read_group)"),
            total_matching: z.number().int().optional().describe("search_count total when fallback was used"),
            has_more: z.boolean().describe("true when more matching records exist beyond this page"),
            groupby: z.array(z.string()),
            aggregates: z.array(z.string())
          })
          .describe("Aggregation path metadata"),
        warnings: zWarnings
      }
    },
    async ({ model, domain, groupby, aggregates, lazy, orderby, limit, offset }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const result = await aggregateRecords(queue, cache, requireConnection(getProps()), {
          model,
          domain,
          groupby,
          aggregates,
          lazy,
          orderby,
          limit,
          offset
        });
        return mcpStructured(
          result as unknown as Record<string, unknown>,
          JSON.stringify(result.groups, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "read_group" });
      }
    }
  );

  server.registerTool(
    "get_record",
    {
      title: "Get Record",
      description:
        "Read-only: fetch a single Odoo record by id. Many transactional models expose a workflow/lifecycle " +
        "field (here called `_workflow_status`, though its real name varies — commonly `state` or `stage_id`) " +
        "showing where the record sits (e.g. draft, confirmed, posted, done, cancelled). By convention, records " +
        "where this field is `'draft'` are unconfirmed and generally safe to edit or remove via `update_record`/" +
        "`delete_record`; records past `draft` are higher risk — Odoo may block the write or it may trigger real " +
        "side effects (linked accounting entries, downstream automations), so check this field before mutating.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        record_id: z.number(),
        fields: z.array(z.string()).nullable().default(null)
      },
      outputSchema: {
        record: zOdooRecord.nullable().describe("The record (with `_workflow_status` when derivable), or null when the id does not exist"),
        ...zFieldsReport
      }
    },
    async ({ model, record_id, fields }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!Number.isInteger(record_id) || record_id <= 0) return mcpError("record_id must be a positive integer");
      try {
        const warnings: string[] = [];
        const { rows, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          model,
          [["id", "=", record_id]],
          fields,
          1,
          undefined,
          undefined,
          cache,
          warnings
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          return mcpStructured(
            {
              record: null,
              returned_fields: fieldsReport.returned_fields,
              omitted_fields: fieldsReport.omitted_fields,
              warnings
            },
            JSON.stringify([], null, 2)
          );
        }
        const record = rows[0] as Record<string, unknown>;
        const workflowStatus = deriveWorkflowStatus(record);
        const result = workflowStatus != null ? { ...record, _workflow_status: workflowStatus } : record;
        return mcpStructured(
          {
            record: result,
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(result, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
    }
  );

  server.registerTool(
    "batch_read",
    {
      title: "Batch Read Records",
      description:
        "Read-only: fetch multiple Odoo records of one model by id in a single call. " +
        "`fields` omitted/null → curated per-model preset (see Field selection); a string array → exactly those fields. " +
        "At most 100 ids are read (extra ids are ignored); return order follows Odoo search_read, not input order.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        ids: z.array(z.number().int().positive()).min(1),
        fields: z.array(z.string()).nullable().default(null)
      },
      outputSchema: {
        records: zOdooRecords.describe("Found records in Odoo search_read order (missing ids are silently absent)"),
        ...zFieldsReport
      }
    },
    async ({ model, ids, fields }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const warnings: string[] = [];
        const { rows, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          model,
          [["id", "in", ids]],
          fields,
          Math.min(ids.length, 100),
          undefined,
          undefined,
          cache,
          warnings
        );
        return mcpStructured(
          {
            records: rows as Record<string, unknown>[],
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(rows, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
    }
  );

  server.registerTool(
    "expand_record",
    {
      title: "Expand Record",
      description:
        "Read-only: fetch a record plus its related context (x2many relations, chatter, attachments) in one call, " +
        "replacing the get_record → search_records → ... relation-chasing chain. Each hop through OdooQueue costs " +
        "≥1s, so this tool caps itself at 8 Odoo calls per invocation; once the cap is hit, remaining sections " +
        'degrade to {"error": "call budget exceeded (max 8 Odoo calls per invocation)"} instead of failing the ' +
        "whole call.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        record_id: z.number(),
        relations: z.array(z.string()).default([]),
        include_chatter: z.boolean().default(true),
        include_attachments: z.boolean().default(true),
        relation_limit: z.number().int().min(1).max(50).default(10)
      },
      outputSchema: {
        record: zOdooRecord.nullable().describe("The normalized record, or null when the id does not exist"),
        relations: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Per requested relation field: related records, or an {error} object (bad field / call budget)"),
        chatter: z.unknown().optional().describe("Latest mail.message entries, or an {error} object; absent when include_chatter=false"),
        attachments: z.unknown().optional().describe("ir.attachment metadata, or an {error} object; absent when include_attachments=false")
      }
    },
    async ({ model, record_id, relations, include_chatter, include_attachments, relation_limit }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!Number.isInteger(record_id) || record_id <= 0) return mcpError("record_id must be a positive integer");

      const conn = requireConnection(getProps());
      const MAX_ODOO_CALLS = MAX_ODOO_CALLS_PER_READ_EXPANSION;
      const startSnapshot = queue.snapshot();
      const callsUsed = () => queue.delta(startSnapshot).odoo_calls;
      const budgetError = () => ({ error: `call budget exceeded (max ${MAX_ODOO_CALLS} Odoo calls per invocation)` });

      let fieldsMeta: Record<string, CachedFieldMeta>;
      let rawRecord: Record<string, unknown>;
      try {
        fieldsMeta = await getFieldsCached(cache, queue, conn, model);
        const smartFields = pickSmartFields(fieldsMeta);
        const rows = (await queue.enqueue(conn, model, "search_read", {
          domain: [["id", "=", record_id]],
          fields: smartFields,
          limit: 1
        })) as Record<string, unknown>[];
        if (!Array.isArray(rows) || rows.length === 0) {
          return mcpStructured({ record: null });
        }
        rawRecord = rows[0];
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }

      const record = normalizeRecords([rawRecord], fieldsMeta)[0];

      const relationResults: Record<string, unknown> = {};
      for (const field of relations) {
        if (callsUsed() >= MAX_ODOO_CALLS) {
          relationResults[field] = budgetError();
          continue;
        }
        const meta = fieldsMeta[field];
        if (!meta || (meta.type !== "one2many" && meta.type !== "many2many") || !meta.relation) {
          relationResults[field] = { error: `field '${field}' is not a relational (x2many) field on ${model}` };
          continue;
        }
        const rawIds = rawRecord[field];
        if (!Array.isArray(rawIds) || rawIds.length === 0) {
          relationResults[field] = [];
          continue;
        }
        const ids = (rawIds as number[]).slice(0, relation_limit);
        const comodel = meta.relation;
        try {
          const rows = (await queue.enqueue(conn, comodel, "search_read", {
            domain: [["id", "in", ids]],
            fields: ["id", "display_name", "state"]
          })) as Record<string, unknown>[];
          relationResults[field] = normalizeRecords(rows);
        } catch (err) {
          if (err instanceof OdooError && callsUsed() < MAX_ODOO_CALLS) {
            try {
              const rows = (await queue.enqueue(conn, comodel, "search_read", {
                domain: [["id", "in", ids]],
                fields: ["id", "display_name"]
              })) as Record<string, unknown>[];
              relationResults[field] = normalizeRecords(rows);
            } catch (err2) {
              relationResults[field] = { error: err2 instanceof Error ? err2.message : String(err2) };
            }
          } else {
            relationResults[field] = { error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      let chatter: unknown;
      if (include_chatter) {
        if (callsUsed() >= MAX_ODOO_CALLS) {
          chatter = budgetError();
        } else {
          chatter = await fetchRecordChatter(queue, conn, model, record_id);
        }
      }

      let attachments: unknown;
      if (include_attachments) {
        if (callsUsed() >= MAX_ODOO_CALLS) {
          attachments = budgetError();
        } else {
          try {
            const rows = (await queue.enqueue(conn, "ir.attachment", "search_read", {
              domain: [
                ["res_model", "=", model],
                ["res_id", record_id]
              ],
              fields: ["name", "mimetype", "file_size", "create_date"]
            })) as Record<string, unknown>[];
            attachments = normalizeRecords(rows);
          } catch (err) {
            attachments = { error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      return mcpStructured({ record, relations: relationResults, chatter, attachments });
    }
  );

  server.registerTool(
    "get_fields",
    {
      title: "Get Fields",
      description:
        "Read-only: get field schema for an Odoo model. Fields with readonly=true cannot be written via update_record; selection lists the allowed values.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        fields: z.array(z.string()).nullable().default(null)
      },
      outputSchema: {
        fields: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .describe("fields_get result: field name → attributes (type, string, readonly, required, selection, relation, ...)")
      }
    },
    async ({ model, fields }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const result = await queue.enqueue(requireConnection(getProps()), model, "fields_get", {
          attributes: ["type", "string", "readonly", "required", "store", "selection", "relation", "help", "searchable", "sortable"],
          ...(fields && fields.length > 0 ? { allfields: fields } : {})
        });
        return mcpStructured(
          { fields: result as Record<string, Record<string, unknown>> },
          JSON.stringify(result, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "fields_get" });
      }
    }
  );

  server.registerTool(
    "list_model_actions",
    {
      title: "List Model Actions",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read-only: discover valid action methods (e.g. action_post, button_draft) for an Odoo model, combining form-view buttons with a curated list. Discovery only — execute these via call_model_method; they change record state.",
      inputSchema: {
        model: z.string()
      },
      outputSchema: {
        actions: z
          .array(
            z.object({
              method: z.string().describe("Model method name to pass to call_model_method"),
              label: z.string().optional().describe("Human-readable button label"),
              confirm: z.string().optional().describe("Confirmation prompt Odoo shows before this action"),
              source: z.enum(["view", "curated"]).describe("Discovered from the form view or from the curated map")
            })
          )
          .describe("Action methods available on this model"),
        note: z.string().optional().describe("Present when view discovery failed and only curated actions are returned")
      }
    },
    async ({ model }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      const conn = requireConnection(getProps());

      let viewActions: ModelAction[] = [];
      let note: string | undefined;
      try {
        const result = (await queue.enqueue(conn, model, "get_views", {
          views: [[false, "form"]]
        })) as { views?: { form?: { arch?: string } } };
        viewActions = parseButtonsFromArch(result?.views?.form?.arch);
      } catch (err) {
        note = `get_views failed (${err instanceof Error ? err.message : String(err)}); returning curated actions only.`;
      }

      const curated = CURATED_MODEL_ACTIONS[model] ?? [];
      const actions = mergeModelActions(curated, viewActions);
      return mcpStructured({ actions, ...(note ? { note } : {}) });
    }
  );

  server.registerTool(
    "describe_database",
    {
      title: "Describe Database",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read-only: summarize what this Odoo instance contains — installed modules, custom/Studio models, " +
        "Studio-added fields, server actions, and automated actions. Costs one Odoo call per requested section " +
        "(each call goes through the rate-limited queue, so requesting all 5 sections takes ~5x the per-call delay).",
      inputSchema: {
        include: z.array(z.enum(["modules", "custom_models", "studio_fields", "server_actions", "automations"])).optional()
      },
      outputSchema: Object.fromEntries(
        ALL_DESCRIBE_SECTIONS.map((key) => [
          key,
          zDescribeSection.optional().describe(`${key} section: {count, records}, or {error} if the query failed; absent when not requested`)
        ])
      )
    },
    async ({ include }) => {
      const conn = requireConnection(getProps());
      const sections = (include && include.length > 0 ? include : ALL_DESCRIBE_SECTIONS) as DescribeSection[];

      const result: Record<string, unknown> = {};
      for (const key of sections) {
        const { model, domain, fields, limit } = DESCRIBE_SECTIONS[key];
        try {
          const rows = (await queue.enqueue(conn, model, "search_read", { domain, fields, limit })) as unknown[];
          result[key] = { count: rows.length, records: rows };
        } catch (err) {
          result[key] = { error: err instanceof Error ? err.message : `${key} failed` };
        }
      }

      return mcpStructured(result);
    }
  );
}

const DESCRIBE_SECTIONS = {
  modules: {
    model: "ir.module.module",
    domain: [["state", "=", "installed"]],
    fields: ["name", "shortdesc"],
    limit: 200
  },
  custom_models: {
    model: "ir.model",
    domain: ["|", ["state", "=", "manual"], ["model", "like", "x_%"]],
    fields: ["model", "name"],
    limit: 100
  },
  studio_fields: {
    model: "ir.model.fields",
    domain: [["name", "like", "x_studio%"]],
    fields: ["model", "name", "ttype", "field_description"],
    limit: 100
  },
  server_actions: {
    model: "ir.actions.server",
    domain: [],
    fields: ["name", "model_id", "state"],
    limit: 100
  },
  automations: {
    model: "base.automation",
    domain: [],
    fields: ["name", "trigger", "model_id", "active"],
    limit: 100
  }
} as const;

type DescribeSection = keyof typeof DESCRIBE_SECTIONS;
const ALL_DESCRIBE_SECTIONS = Object.keys(DESCRIBE_SECTIONS) as DescribeSection[];

const zDescribeSection = z.union([
  z.object({ count: z.number().int(), records: zOdooRecords }),
  z.object({ error: z.string() })
]);
