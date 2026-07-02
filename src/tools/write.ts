import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callOdoo } from "../odoo";
import type { Props } from "../server";
import { escapeHtml, mcpError, requireConnection } from "./shared";

export function registerWriteTools(server: McpServer, getProps: () => Props | undefined) {
  server.registerTool(
    "create_record",
    {
      description: "Write: create a single Odoo record of the given model.",
      inputSchema: {
        model: z.string().min(1),
        values: z.record(z.string(), z.any())
      }
    },
    async ({ model, values }) => {
      try {
        const ids = (await callOdoo(requireConnection(getProps()), model, "create", {
          vals_list: [values]
        })) as number[];
        return { content: [{ type: "text" as const, text: JSON.stringify(ids[0], null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "create_record failed");
      }
    }
  );

  server.registerTool(
    "post_message",
    {
      description: "Write: post a message (chatter log/comment) to a single Odoo record.",
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        body: z.string(),
        subtype: z.string().optional(),
        body_is_html: z.boolean().default(false)
      }
    },
    async ({ model, record_id, body, subtype, body_is_html }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!Number.isInteger(record_id) || record_id <= 0) return mcpError("record_id must be a positive integer");
      try {
        const result = await callOdoo(requireConnection(getProps()), model, "message_post", {
          ids: [record_id],
          body: body_is_html ? body : escapeHtml(body),
          message_type: "comment",
          ...(subtype ? { subtype_xmlid: subtype } : {})
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "post_message failed");
      }
    }
  );

  server.registerTool(
    "update_record",
    {
      description:
        "Write: update fields on a single Odoo record by id. x2many fields need Odoo command tuples (e.g. [[6,0,ids]], [[4,id]], [[3,id]]).",
      inputSchema: {
        model: z.string().min(1),
        record_id: z.number().int().positive(),
        values: z.record(z.string(), z.any())
      }
    },
    async ({ model, record_id, values }) => {
      try {
        await callOdoo(requireConnection(getProps()), model, "write", {
          ids: [record_id],
          vals: values
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(true, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "update_record failed");
      }
    }
  );

  server.registerTool(
    "delete_record",
    {
      description: "Write: delete a single Odoo record by id.",
      inputSchema: {
        model: z.string().min(1),
        record_id: z.number().int().positive()
      }
    },
    async ({ model, record_id }) => {
      try {
        await callOdoo(requireConnection(getProps()), model, "unlink", { ids: [record_id] });
        return { content: [{ type: "text" as const, text: JSON.stringify(true, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "delete_record failed");
      }
    }
  );

  server.registerTool(
    "call_model_method",
    {
      description: "Escape hatch: call an arbitrary Odoo model method with raw positional args and keyword args.",
      inputSchema: {
        model: z.string(),
        method: z.string(),
        args: z.array(z.any()).default([]),
        kwargs: z.record(z.string(), z.any()).default({})
      }
    },
    async ({ model, method, args, kwargs }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!method || !method.trim()) return mcpError("method must be a non-empty string");
      try {
        const result = await callOdoo(requireConnection(getProps()), model, method, { ...kwargs, args });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "call_model_method failed");
      }
    }
  );
}
