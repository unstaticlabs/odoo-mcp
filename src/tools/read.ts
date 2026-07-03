import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { CORE_MODEL_ALLOWLIST, DEFAULT_TASK_FIELDS, mcpError, requireConnection, searchRecords, withOdooMetrics } from "./shared";

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
    withOdooMetrics(queue, async ({ domain, fields }) => {
      try {
        const tasks = await searchRecords(queue, requireConnection(getProps()), "project.task", domain, fields, 100);
        return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "projects.list_tasks failed");
      }
    })
  );

  server.registerTool(
    "list_models",
    {
      description: "Read-only: list enabled/installed Odoo models (name and technical model name).",
      inputSchema: {}
    },
    withOdooMetrics(queue, async () => {
      const conn = requireConnection(getProps());
      try {
        const rows = await searchRecords(queue, conn, "ir.model", [], ["model", "name"], 100);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch {
        const fallback = CORE_MODEL_ALLOWLIST.map((model) => ({ model }));
        return { content: [{ type: "text" as const, text: JSON.stringify(fallback, null, 2) }] };
      }
    })
  );

  server.registerTool(
    "search_records",
    {
      description: "Read-only: model-agnostic Odoo search_read.",
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).nullable().default(null),
        limit: z.number().int().min(1).max(100).default(10)
      }
    },
    withOdooMetrics(queue, async ({ model, domain, fields, limit }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const rows = await searchRecords(queue, requireConnection(getProps()), model, domain, fields, limit);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "search_records failed");
      }
    })
  );

  server.registerTool(
    "aggregate_records",
    {
      description: "Read-only: model-agnostic Odoo read_group (grouped aggregation).",
      inputSchema: {
        model: z.string(),
        domain: z.array(z.any()).default([]),
        groupby: z.array(z.string()).min(1),
        aggregates: z.array(z.string()).min(1),
        lazy: z.boolean().default(true),
        orderby: z.string().optional()
      }
    },
    withOdooMetrics(queue, async ({ model, domain, groupby, aggregates, lazy, orderby }) => {
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
    })
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
    withOdooMetrics(queue, async ({ model, record_id, fields }) => {
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
    })
  );

  server.registerTool(
    "get_fields",
    {
      description: "Read-only: get field schema (name, type, string label) for an Odoo model.",
      inputSchema: {
        model: z.string()
      }
    },
    withOdooMetrics(queue, async ({ model }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const fields = await queue.enqueue(requireConnection(getProps()), model, "fields_get", {
          attributes: ["type", "string"]
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(fields, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "get_fields failed");
      }
    })
  );
}
