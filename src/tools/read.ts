import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { CURATED_MODEL_ACTIONS, type CuratedAction } from "./actions-map";
import {
  CORE_MODEL_ALLOWLIST,
  DEFAULT_TASK_FIELDS,
  countRecords,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  pickSmartFields,
  requireConnection,
  searchRecords,
  zOdooRecord,
  zOdooRecords
} from "./shared";
import { deriveWorkflowStatus, normalizeRecords } from "../normalizer";
import { type CachedFieldMeta, type TtlCache, getFieldsCached } from "../cache";
import { OdooError } from "../odoo";

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
        records: zOdooRecords.describe("Matching project.task records")
      }
    },
    async ({ domain, fields }) => {
      try {
        const { rows: tasks } = await searchRecords(queue, requireConnection(getProps()), "project.task", domain, fields, 100);
        return mcpStructured({ records: tasks as Record<string, unknown>[] }, JSON.stringify(tasks, null, 2));
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "search_read" });
      }
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
      description: "Read-only: model-agnostic Odoo search_read.",
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
        records: zOdooRecords.describe("Matching records with the requested (or smart-default) fields")
      }
    },
    async ({ model, domain, fields, limit, order, offset }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const { rows } = await searchRecords(queue, requireConnection(getProps()), model, domain, fields, limit, order, offset);
        return mcpStructured({ records: rows as Record<string, unknown>[] }, JSON.stringify(rows, null, 2));
      } catch (err) {
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
        "Read-only: model-agnostic Odoo read_group (grouped aggregation). `groupby` and `aggregates` entries " +
        "follow Odoo's read_group `field:agg` syntax (e.g. `amount_total:sum`, `invoice_date:month`, `__count`).\n\n" +
        "Example 1 — group vendor bills by month:\n" +
        '{ "model": "account.move", "domain": [["move_type", "=", "in_invoice"]], ' +
        '"groupby": ["invoice_date:month"], "aggregates": ["amount_total:sum"] }\n\n' +
        "Example 2 — count expenses per employee:\n" +
        '{ "model": "hr.expense", "groupby": ["employee_id"], "aggregates": ["__count"] }',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).default([]),
        groupby: z.array(z.string()).min(1),
        aggregates: z.array(z.string()).min(1),
        lazy: z.boolean().default(true),
        orderby: z.string().optional()
      },
      outputSchema: {
        groups: zOdooRecords.describe("read_group result rows: one object per group with the groupby keys and aggregate values")
      }
    },
    async ({ model, domain, groupby, aggregates, lazy, orderby }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const rows = await queue.enqueue(requireConnection(getProps()), model, "read_group", {
          domain,
          fields: aggregates,
          groupby,
          lazy,
          ...(orderby ? { orderby } : {})
        });
        return mcpStructured({ groups: rows as Record<string, unknown>[] }, JSON.stringify(rows, null, 2));
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
        record: zOdooRecord.nullable().describe("The record (with `_workflow_status` when derivable), or null when the id does not exist")
      }
    },
    async ({ model, record_id, fields }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!Number.isInteger(record_id) || record_id <= 0) return mcpError("record_id must be a positive integer");
      try {
        const { rows } = (await searchRecords(
          queue,
          requireConnection(getProps()),
          model,
          [["id", "=", record_id]],
          fields,
          1
        )) as { rows: unknown[]; fieldsMeta: unknown };
        if (!Array.isArray(rows) || rows.length === 0) {
          return mcpStructured({ record: null }, JSON.stringify([], null, 2));
        }
        const record = rows[0] as Record<string, unknown>;
        const workflowStatus = deriveWorkflowStatus(record);
        const result = workflowStatus != null ? { ...record, _workflow_status: workflowStatus } : record;
        return mcpStructured({ record: result }, JSON.stringify(result, null, 2));
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
        "`fields` omitted/null → smart default fields; a string array → exactly those fields. " +
        "At most 100 ids are read (extra ids are ignored); return order follows Odoo search_read, not input order.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        ids: z.array(z.number().int().positive()).min(1),
        fields: z.array(z.string()).nullable().default(null)
      },
      outputSchema: {
        records: zOdooRecords.describe("Found records in Odoo search_read order (missing ids are silently absent)")
      }
    },
    async ({ model, ids, fields }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const { rows } = await searchRecords(
          queue,
          requireConnection(getProps()),
          model,
          [["id", "in", ids]],
          fields,
          Math.min(ids.length, 100)
        );
        return mcpStructured({ records: rows as Record<string, unknown>[] }, JSON.stringify(rows, null, 2));
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
      const MAX_ODOO_CALLS = 8;
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
          try {
            const rows = (await queue.enqueue(conn, "mail.message", "search_read", {
              domain: [
                ["model", "=", model],
                ["res_id", "=", record_id]
              ],
              fields: ["date", "author_id", "body", "message_type"],
              limit: 20,
              order: "date desc"
            })) as Record<string, unknown>[];
            chatter = normalizeRecords(rows);
          } catch (err) {
            chatter = { error: err instanceof Error ? err.message : String(err) };
          }
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
