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
        const tasks = await searchRecords(queue, requireConnection(getProps()), "project.task", domain, fields, 100);
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
        const rows = await searchRecords(queue, conn, "ir.model", [], ["model", "name"], 100);
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
        const rows = await searchRecords(queue, requireConnection(getProps()), model, domain, fields, limit, order, offset);
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
        const rows = (await searchRecords(
          queue,
          requireConnection(getProps()),
          model,
          [["id", "=", record_id]],
          fields,
          1
        )) as unknown[];
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
      description: "Read-only: get field schema (name, type, string label) for an Odoo model.",
      inputSchema: {
        model: z.string()
      }
    },
    async ({ model }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const fields = await queue.enqueue(requireConnection(getProps()), model, "fields_get", {
          attributes: ["type", "string"]
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(fields, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "get_fields failed");
      }
    }
  );
}
