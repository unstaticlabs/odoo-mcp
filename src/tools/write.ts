import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { escapeHtml, mcpError, mcpErrorFromException, requireConnection } from "./shared";

export function registerWriteTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "create_record",
    {
      title: "Create Record",
      description: "Write: create a single Odoo record of the given model.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
        return mcpErrorFromException(err, { model, method: "create" });
      }
    }
  );

  server.registerTool(
    "post_message",
    {
      title: "Post Chatter Message",
      description: "Write: post a message (chatter log/comment) to a single Odoo record.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
        return mcpErrorFromException(err, { model, method: "message_post" });
      }
    }
  );

  server.registerTool(
    "update_record",
    {
      title: "Update Record",
      description:
        "Write: update fields on a single Odoo record by id. x2many fields need Odoo command tuples (e.g. [[6,0,ids]], [[4,id]], [[3,id]]).",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
        return mcpErrorFromException(err, { model, method: "write" });
      }
    }
  );

  server.registerTool(
    "batch_update",
    {
      title: "Batch Update Records",
      description:
        "Write: update multiple Odoo records of one model in one call. Each `updates` entry targets one " +
        "record_id with its own `values`. x2many fields need Odoo command tuples (e.g. [[6,0,ids]], [[4,id]], [[3,id]]). " +
        "Fail-fast: a mid-loop error aborts remaining updates; already-applied writes are NOT rolled back.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string().min(1),
        updates: z
          .array(
            z.object({
              record_id: z.number().int().positive(),
              values: z.record(z.string(), z.any())
            })
          )
          .min(1)
      }
    },
    async ({ model, updates }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const conn = requireConnection(getProps());
        const results: { record_id: number; ok: boolean }[] = [];
        for (const u of updates) {
          await queue.enqueue(conn, model, "write", { ids: [u.record_id], vals: u.values });
          results.push({ record_id: u.record_id, ok: true });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "write" });
      }
    }
  );

  server.registerTool(
    "batch_post_message",
    {
      title: "Batch Post Chatter Messages",
      description:
        "Write: post a chatter message to multiple Odoo records of one model. message_post is per-record. " +
        "Each `messages` entry posts to one record_id. Bodies are HTML-escaped unless body_is_html is true. " +
        "Fail-fast: a mid-loop error aborts remaining posts; already-posted messages are NOT rolled back.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        messages: z
          .array(
            z.object({
              record_id: z.number().int().positive(),
              body: z.string(),
              subtype: z.string().optional(),
              body_is_html: z.boolean().default(false)
            })
          )
          .min(1)
      }
    },
    async ({ model, messages }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const conn = requireConnection(getProps());
        const results: unknown[] = [];
        for (const m of messages) {
          const res = await queue.enqueue(conn, model, "message_post", {
            ids: [m.record_id],
            body: m.body_is_html ? m.body : escapeHtml(m.body),
            message_type: "comment",
            ...(m.subtype ? { subtype_xmlid: m.subtype } : {})
          });
          results.push({ record_id: m.record_id, result: res });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "message_post" });
      }
    }
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete Record",
      description: "Write: delete a single Odoo record by id.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
        return mcpErrorFromException(err, { model, method: "unlink" });
      }
    }
  );

  server.registerTool(
    "call_model_method",
    {
      title: "Call Model Method (advanced)",
      description:
        "Escape hatch: call an arbitrary Odoo model method. Odoo's JSON-2 API has NO positional args — every body key is bound as a named kwarg (record-bound methods take a top-level `ids`). Pass record ids via `ids` and all other parameters via `kwargs`.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
        return mcpErrorFromException(err, { model, method });
      }
    }
  );
}
