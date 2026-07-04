import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { CURATED_MODEL_ACTIONS, type CuratedAction } from "./actions-map";
import { CORE_MODEL_ALLOWLIST, DEFAULT_TASK_FIELDS, countRecords, mcpError, mcpErrorFromException, requireConnection, searchRecords } from "./shared";
import { deriveWorkflowStatus } from "../normalizer";

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

export function registerReadTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "projects.list_tasks",
    {
      title: "List Project Tasks",
      description: "Read-only: list Odoo project.task records matching a domain.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_TASK_FIELDS)
      }
    },
    async ({ domain, fields }) => {
      try {
        const { rows: tasks } = await searchRecords(queue, requireConnection(getProps()), "project.task", domain, fields, 100);
        return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] };
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
      inputSchema: {}
    },
    async () => {
      const conn = requireConnection(getProps());
      try {
        const { rows } = await searchRecords(queue, conn, "ir.model", [], ["model", "name"], 100);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch {
        const fallback = CORE_MODEL_ALLOWLIST.map((model) => ({ model }));
        return { content: [{ type: "text" as const, text: JSON.stringify(fallback, null, 2) }] };
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
      }
    },
    async ({ model, domain, fields, limit, order, offset }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const { rows } = await searchRecords(queue, requireConnection(getProps()), model, domain, fields, limit, order, offset);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
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
      }
    },
    async ({ model, domain }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const count = await countRecords(queue, requireConnection(getProps()), model, domain);
        return { content: [{ type: "text" as const, text: JSON.stringify({ count }) }] };
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
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
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
          return { content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }] };
        }
        const record = rows[0] as Record<string, unknown>;
        const workflowStatus = deriveWorkflowStatus(record);
        const result = workflowStatus != null ? { ...record, _workflow_status: workflowStatus } : record;
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
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
      }
    },
    async ({ model, fields }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const result = await queue.enqueue(requireConnection(getProps()), model, "fields_get", {
          attributes: ["type", "string", "readonly", "required", "store", "selection", "relation", "help", "searchable", "sortable"],
          ...(fields && fields.length > 0 ? { allfields: fields } : {})
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "fields_get" });
      }
    }
  );

  server.registerTool(
    "list_model_actions",
    {
      description:
        "Read-only: discover valid action methods (e.g. action_post, button_draft) for an Odoo model, combining form-view buttons with a curated list. Discovery only — execute these via call_model_method; they change record state.",
      inputSchema: {
        model: z.string()
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
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ actions, ...(note ? { note } : {}) }, null, 2) }]
      };
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
      }
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

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
