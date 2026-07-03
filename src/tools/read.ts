import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { CORE_MODEL_ALLOWLIST, DEFAULT_TASK_FIELDS, countRecords, mcpError, requireConnection, searchRecords } from "./shared";

export function registerReadTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "projects.list_tasks",
    {
      description: "Read-only: list Odoo project.task records matching a domain.",
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
        return mcpError(err instanceof Error ? err.message : "projects.list_tasks failed");
      }
    }
  );

  server.registerTool(
    "list_models",
    {
      description: "Read-only: list enabled/installed Odoo models (name and technical model name).",
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
      description: "Read-only: model-agnostic Odoo search_read.",
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
        return mcpError(err instanceof Error ? err.message : "search_records failed");
      }
    }
  );

  server.registerTool(
    "search_count",
    {
      description: "Read-only: model-agnostic Odoo search_count — count records matching a domain without fetching them.",
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
      description:
        "Read-only: model-agnostic Odoo read_group (grouped aggregation). `groupby` and `aggregates` entries " +
        "follow Odoo's read_group `field:agg` syntax (e.g. `amount_total:sum`, `invoice_date:month`, `__count`).\n\n" +
        "Example 1 — group vendor bills by month:\n" +
        '{ "model": "account.move", "domain": [["move_type", "=", "in_invoice"]], ' +
        '"groupby": ["invoice_date:month"], "aggregates": ["amount_total:sum"] }\n\n' +
        "Example 2 — count expenses per employee:\n" +
        '{ "model": "hr.expense", "groupby": ["employee_id"], "aggregates": ["__count"] }',
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
        return mcpError(err instanceof Error ? err.message : "aggregate_records failed");
      }
    }
  );

  server.registerTool(
    "get_record",
    {
      description: "Read-only: fetch a single Odoo record by id.",
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
          return mcpError(`No ${model} record found for id ${record_id}`);
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(rows[0], null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "get_record failed");
      }
    }
  );

  server.registerTool(
    "get_fields",
    {
      description:
        "Read-only: get field schema for an Odoo model. Fields with readonly=true cannot be written via update_record; selection lists the allowed values.",
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
        return mcpError(err instanceof Error ? err.message : "get_fields failed");
      }
    }
  );

  server.registerTool(
    "describe_database",
    {
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
