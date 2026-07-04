import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { escapeHtml, mcpError, requireConnection } from "./shared";

export function registerWriteTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
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
        const ids = (await queue.enqueue(requireConnection(getProps()), model, "create", {
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
        const result = await queue.enqueue(requireConnection(getProps()), model, "message_post", {
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
        await queue.enqueue(requireConnection(getProps()), model, "write", {
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
        await queue.enqueue(requireConnection(getProps()), model, "unlink", { ids: [record_id] });
        return { content: [{ type: "text" as const, text: JSON.stringify(true, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "delete_record failed");
      }
    }
  );

  server.registerTool(
    "call_model_method",
    {
      description:
        "Escape hatch: call an arbitrary Odoo model method. Odoo's JSON-2 API has NO positional args — every body key is bound as a named kwarg (record-bound methods take a top-level `ids`). Pass record ids via `ids` and all other parameters via `kwargs`.",
      inputSchema: {
        model: z.string(),
        method: z.string(),
        ids: z.array(z.number().int()).optional(),
        kwargs: z.record(z.string(), z.any()).default({}),
        // Deprecated: JSON-2 cannot bind positional args; kept so old callers fail loudly instead of silently.
        args: z.array(z.any()).default([])
      }
    },
    async ({ model, method, ids, kwargs, args }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!method || !method.trim()) return mcpError("method must be a non-empty string");
      if (args.length > 0) {
        return mcpError(
          "Odoo JSON-2 has no positional args: every body key is bound as a named kwarg, so an 'args' key fails with 422 unless the method literally has an 'args' parameter. Move these values into 'kwargs' (and record ids into 'ids')."
        );
      }
      try {
        const body = { ...kwargs, ...(ids !== undefined ? { ids } : {}) };
        const result = await queue.enqueue(requireConnection(getProps()), model, method, body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : "call_model_method failed");
      }
    }
  );
}
