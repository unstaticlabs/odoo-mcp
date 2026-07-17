import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { assessWriteOperation, isMutatingOdooMethod } from "../write-safety";
import { mcpError, mcpErrorFromException, mcpStructured, mcpWriteBlockedError, plaintextToHtml, requireConnection } from "./shared";

const PM_WRITE_ROUTING_NOTE =
  " Project-management notes (including banking/B2C/deadline operational text) on project.task / project.project / mail.activity→project.* are allowed. " +
  "For draft vendor-bill / expense prep use billing.update_draft_expense / billing.configure_draft_vendor_bill. " +
  "For tax-close / report / return / lock-exception mutations use bookkeeping.plan_safe_write.";

function gateWrite(model: string, method: string, args: Record<string, unknown>) {
  if (!isMutatingOdooMethod(method)) return null;
  const verdict = assessWriteOperation({ model, method, args });
  if (!verdict.allowed) {
    return mcpWriteBlockedError({ model, method }, verdict);
  }
  return null;
}

export function registerWriteTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "create_record",
    {
      title: "Create Record",
      description:
        "Write: create a single Odoo record of the given model. When the model is project.task, the response carries a " +
        "trace_token (src-…) that is also stamped into the task's chatter — you MUST surface that token verbatim in your " +
        "visible reply to the user so the conversation can be found again from the Odoo task." +
        PM_WRITE_ROUTING_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        model: z.string().min(1),
        values: z.record(z.string(), z.any())
      },
      outputSchema: {
        id: z.number().int().describe("Database id of the created record"),
        trace_token: z
          .string()
          .optional()
          .describe("project.task only: provenance trace token posted to the chatter — include it verbatim in your visible reply"),
        provenance_warning: z
          .string()
          .optional()
          .describe("project.task only: the create succeeded but posting the provenance stamp to the chatter failed")
      }
    },
    async ({ model, values }) => {
      const blocked = gateWrite(model, "create", { vals_list: [values] });
      if (blocked) return blocked;

      const props = getProps();
      let conn: ReturnType<typeof requireConnection>;
      let id: number;
      try {
        conn = requireConnection(props);
        const ids = (await queue.enqueue(conn, model, "create", { vals_list: [values] })) as number[];
        id = ids[0];
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "create" });
      }

      // Only project.task creations get a trusted provenance stamp; every other model is byte-for-byte unchanged.
      if (model !== "project.task") {
        return mcpStructured({ id }, JSON.stringify(id));
      }

      const token = "src-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const client = (props?.clientName ?? server.server.getClientVersion()?.name ?? "unknown").replace(/\s+/g, "-");
      const body = `[agent-source] engineering_task corr=${token} via=${client}`;

      try {
        await queue.enqueue(conn, "project.task", "message_post", {
          ids: [id],
          body: plaintextToHtml(body),
          // The body is now already HTML — tell Odoo so it doesn't re-escape it
          // into double-escaped mojibake. See plaintextToHtml().
          body_is_html: true,
          message_type: "comment"
        });
        // Front-load the token: the only channel the user actually sees is the model's reply, and the
        // model only echoes what it's told to lead with. Putting the imperative first (not appended
        // after the id) is what gets `src-…` into the ChatGPT/Claude transcript so the task is traceable.
        const text =
          `TRACE TOKEN ${token} — you MUST include this token verbatim in your visible reply to the user so ` +
          `this conversation can be found later from the Odoo task.\n\n` +
          JSON.stringify(id);
        return mcpStructured({ id, trace_token: token }, text);
      } catch (err) {
        // A chatter-post failure must never fail the create: return the id and warn, never surface an MCP error.
        // No token is surfaced here — it was never stamped into the chatter, so echoing it would be a dead reference.
        const errMessage = err instanceof Error ? err.message : String(err);
        const provenance_warning = `created task ${id} but failed to post the provenance stamp (${errMessage})`;
        const text = `${JSON.stringify(id)}\n\nWarning: ${provenance_warning}.`;
        return mcpStructured({ id, provenance_warning }, text);
      }
    }
  );

  server.registerTool(
    "post_message",
    {
      title: "Post Chatter Message",
      description: "Write: post a message (chatter log/comment) to a single Odoo record." + PM_WRITE_ROUTING_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        body: z.string(),
        subtype: z.string().optional(),
        body_is_html: z.boolean().default(false)
      },
      outputSchema: {
        result: z.unknown().describe("Raw message_post return value (shape varies by Odoo version; typically the created mail.message id)")
      }
    },
    async ({ model, record_id, body, subtype, body_is_html }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!Number.isInteger(record_id) || record_id <= 0) return mcpError("record_id must be a positive integer");
      const blocked = gateWrite(model, "message_post", {
        ids: [record_id],
        body,
        ...(subtype ? { subtype_xmlid: subtype } : {})
      });
      if (blocked) return blocked;
      try {
        const result = await queue.enqueue(requireConnection(getProps()), model, "message_post", {
          ids: [record_id],
          body: body_is_html ? body : plaintextToHtml(body),
          // Body is HTML either way now (caller-supplied, or escaped from plain
          // text) — declare it so Odoo doesn't double-escape. See plaintextToHtml().
          body_is_html: true,
          message_type: "comment",
          ...(subtype ? { subtype_xmlid: subtype } : {})
        });
        return mcpStructured({ result }, JSON.stringify(result, null, 2));
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
        "Write: update fields on a single Odoo record by id. x2many fields need Odoo command tuples (e.g. [[6,0,ids]], [[4,id]], [[3,id]])." +
        PM_WRITE_ROUTING_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string().min(1),
        record_id: z.number().int().positive(),
        values: z.record(z.string(), z.any())
      },
      outputSchema: {
        ok: z.boolean().describe("True when the write succeeded")
      }
    },
    async ({ model, record_id, values }) => {
      const blocked = gateWrite(model, "write", { ids: [record_id], vals: values });
      if (blocked) return blocked;
      try {
        await queue.enqueue(requireConnection(getProps()), model, "write", {
          ids: [record_id],
          vals: values
        });
        return mcpStructured({ ok: true }, JSON.stringify(true, null, 2));
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
      },
      outputSchema: {
        results: z
          .array(z.object({ record_id: z.number().int(), ok: z.boolean() }))
          .describe("One entry per applied update, in input order (fail-fast: absent entries were not attempted)")
      }
    },
    async ({ model, updates }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const conn = requireConnection(getProps());
        const results: { record_id: number; ok: boolean }[] = [];
        for (const u of updates) {
          const blocked = gateWrite(model, "write", { ids: [u.record_id], vals: u.values });
          if (blocked) return blocked;
          await queue.enqueue(conn, model, "write", { ids: [u.record_id], vals: u.values });
          results.push({ record_id: u.record_id, ok: true });
        }
        return mcpStructured({ results }, JSON.stringify(results, null, 2));
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
        "Fail-fast: a mid-loop error aborts remaining posts; already-posted messages are NOT rolled back." +
        PM_WRITE_ROUTING_NOTE,
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
      },
      outputSchema: {
        results: z
          .array(z.object({ record_id: z.number().int(), result: z.unknown() }))
          .describe("One entry per posted message, in input order (fail-fast: absent entries were not attempted)")
      }
    },
    async ({ model, messages }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      try {
        const conn = requireConnection(getProps());
        const results: unknown[] = [];
        for (const m of messages) {
          const blocked = gateWrite(model, "message_post", {
            ids: [m.record_id],
            body: m.body,
            ...(m.subtype ? { subtype_xmlid: m.subtype } : {})
          });
          if (blocked) return blocked;
          const res = await queue.enqueue(conn, model, "message_post", {
            ids: [m.record_id],
            body: m.body_is_html ? m.body : plaintextToHtml(m.body),
            // Body is HTML either way now — declare it so Odoo doesn't
            // double-escape. See plaintextToHtml().
            body_is_html: true,
            message_type: "comment",
            ...(m.subtype ? { subtype_xmlid: m.subtype } : {})
          });
          results.push({ record_id: m.record_id, result: res });
        }
        return mcpStructured({ results }, JSON.stringify(results, null, 2));
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
      },
      outputSchema: {
        ok: z.boolean().describe("True when the delete succeeded")
      }
    },
    async ({ model, record_id }) => {
      const blocked = gateWrite(model, "unlink", { ids: [record_id] });
      if (blocked) return blocked;
      try {
        await queue.enqueue(requireConnection(getProps()), model, "unlink", { ids: [record_id] });
        return mcpStructured({ ok: true }, JSON.stringify(true, null, 2));
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
        "Escape hatch: call an arbitrary Odoo model method. Odoo's JSON-2 API has NO positional args — every body key is bound as a named kwarg (record-bound methods take a top-level `ids`). Pass record ids via `ids` and all other parameters via `kwargs`." +
        PM_WRITE_ROUTING_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        method: z.string(),
        ids: z.array(z.number().int()).optional(),
        kwargs: z.record(z.string(), z.any()).default({}),
        // Deprecated: JSON-2 cannot bind positional args; kept so old callers fail loudly instead of silently.
        args: z.array(z.any()).default([])
      },
      outputSchema: {
        result: z.unknown().describe("Raw return value of the invoked model method")
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
        const blocked = gateWrite(model, method, body);
        if (blocked) return blocked;
        const result = await queue.enqueue(requireConnection(getProps()), model, method, body);
        return mcpStructured({ result }, JSON.stringify(result, null, 2));
      } catch (err) {
        return mcpErrorFromException(err, { model, method });
      }
    }
  );
}
