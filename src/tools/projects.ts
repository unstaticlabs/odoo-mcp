import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { mcpError, mcpErrorFromException, mcpStructured, plaintextToHtml, requireConnection } from "./shared";

const PM_WRITE_DESCRIPTION_SUFFIX =
  " PM-safe project-management write with fixed Odoo targets; prose fields are passed verbatim (no finance-keyword scanning). For accounting / tax / ledger mutations use bookkeeping.plan_safe_write only.";

export function registerProjectWriteTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue
) {
  server.registerTool(
    "projects.create_activity",
    {
      title: "Create Project Task Activity",
      description: "Write: schedule a mail.activity on a project.task (assignee To-Do)." + PM_WRITE_DESCRIPTION_SUFFIX,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive(),
        summary: z.string().min(1),
        note: z.string(),
        date_deadline: z.string(),
        user_id: z.number().int().positive(),
        activity_type_id: z.number().int().positive()
      },
      outputSchema: {
        id: z.number().int()
      }
    },
    async ({ task_id, summary, note, date_deadline, user_id, activity_type_id }) => {
      const vals = {
        res_model: "project.task",
        res_id: task_id,
        summary,
        note,
        date_deadline,
        user_id,
        activity_type_id
      };
      try {
        const conn = requireConnection(getProps());
        const ids = (await queue.enqueue(conn, "mail.activity", "create", { vals_list: [vals] })) as number[];
        return mcpStructured({ id: ids[0] }, JSON.stringify(ids[0]));
      } catch (err) {
        return mcpErrorFromException(err, { model: "mail.activity", method: "create" });
      }
    }
  );

  server.registerTool(
    "projects.post_note",
    {
      title: "Post Project Task Note",
      description: "Write: post a chatter comment on a project.task." + PM_WRITE_DESCRIPTION_SUFFIX,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive(),
        note: z.string().min(1),
        body_is_html: z.boolean().default(false)
      },
      outputSchema: {
        result: z.unknown()
      }
    },
    async ({ task_id, note, body_is_html }) => {
      try {
        const result = await queue.enqueue(requireConnection(getProps()), "project.task", "message_post", {
          ids: [task_id],
          body: body_is_html ? note : plaintextToHtml(note),
          body_is_html: true,
          message_type: "comment"
        });
        return mcpStructured({ result }, JSON.stringify(result, null, 2));
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "message_post" });
      }
    }
  );

  server.registerTool(
    "projects.update_task",
    {
      title: "Update Project Task",
      description:
        "Write: update curated fields on a project.task by id." +
        PM_WRITE_DESCRIPTION_SUFFIX +
        " Broader field edits remain on generic update_record once the connector gate lands.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        date_deadline: z.string().optional(),
        stage_id: z.number().int().positive().optional(),
        priority: z.string().optional()
      },
      outputSchema: {
        ok: z.boolean()
      }
    },
    async ({ task_id, name, description, date_deadline, stage_id, priority }) => {
      const vals: Record<string, unknown> = {};
      if (name !== undefined) vals.name = name;
      if (description !== undefined) vals.description = description;
      if (date_deadline !== undefined) vals.date_deadline = date_deadline;
      if (stage_id !== undefined) vals.stage_id = stage_id;
      if (priority !== undefined) vals.priority = priority;

      if (Object.keys(vals).length === 0) {
        return mcpError("at least one of name, description, date_deadline, stage_id, priority must be provided");
      }

      try {
        await queue.enqueue(requireConnection(getProps()), "project.task", "write", {
          ids: [task_id],
          vals
        });
        return mcpStructured({ ok: true }, JSON.stringify(true, null, 2));
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "write" });
      }
    }
  );
}
