import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { CURATED_MODEL_ACTIONS, type CuratedAction } from "./actions-map";
import { CORE_MODEL_ALLOWLIST, DEFAULT_TASK_FIELDS, mcpError, requireConnection, searchRecords } from "./shared";

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
        limit: z.number().int().min(1).max(100).default(10)
      }
    },
    async ({ model, domain, fields, limit }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const rows = await searchRecords(queue, requireConnection(getProps()), model, domain, fields, limit);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "search_records failed");
      }
    }
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
}
