/**
 * Projects domain tools (`projects.*`).
 *
 * M1 reads + M2 create_task: namespaced wrappers so MCP clients (Claude Code, etc.)
 * discover project-management tools without relying on generic search/create alone.
 * Writes use Odoo 19 batched `vals_list` create and are gated only by the caller's
 * Odoo permissions (plus the shared connector write-safety gate).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TtlCache } from "../cache";
import { deriveWorkflowStatus } from "../normalizer";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { assessWriteOperation } from "../write-safety";
import {
  DEFAULT_TASK_FIELDS,
  fetchRecordChatter,
  logWriteContext,
  MAX_ODOO_CALLS_PER_READ_EXPANSION,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  plaintextToHtml,
  requireConnection,
  searchRecords,
  zOdooRecord,
  zOdooRecords,
  zWarnings,
  zWriteContext
} from "./shared";

/** Default fields for project.project list/get (matches MODEL_FIELD_PRESETS). */
export const DEFAULT_PROJECT_FIELDS = ["id", "name", "partner_id", "user_id", "stage_id"];
/** Default fields for project.task.type (stages). */
export const DEFAULT_STAGE_FIELDS = ["id", "name", "sequence", "fold"];

const zFieldOmission = z.object({ field: z.string(), reason: z.string() });
const zFieldsReport = {
  returned_fields: z.array(z.string()).describe("List of fields successfully returned by Odoo"),
  omitted_fields: z
    .array(zFieldOmission)
    .describe("Fields requested but omitted from Odoo response"),
  warnings: zWarnings
};

export function registerProjectsTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue,
  cache: TtlCache
) {
  server.registerTool(
    "projects.list_projects",
    {
      title: "List Projects",
      description: "Read-only: list Odoo project.project records matching a domain.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_PROJECT_FIELDS),
        limit: z.number().int().min(1).max(100).default(100)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.project records"),
        ...zFieldsReport
      }
    },
    async ({ domain, fields, limit }) => {
      try {
        const warnings: string[] = [];
        const { rows, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          "project.project",
          domain ?? [],
          fields ?? DEFAULT_PROJECT_FIELDS,
          limit ?? 100,
          undefined,
          undefined,
          cache,
          warnings
        );
        return mcpStructured(
          {
            records: rows as Record<string, unknown>[],
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(rows, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.project", method: "search_read" });
      }
    }
  );

  server.registerTool(
    "projects.list_tasks",
    {
      title: "List Project Tasks",
      description: "Read-only: list Odoo project.task records matching a domain.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_TASK_FIELDS),
        limit: z.number().int().min(1).max(100).default(100)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.task records"),
        ...zFieldsReport
      }
    },
    async ({ domain, fields, limit }) => {
      try {
        const warnings: string[] = [];
        const { rows: tasks, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          "project.task",
          domain ?? [],
          fields ?? DEFAULT_TASK_FIELDS,
          limit ?? 100,
          undefined,
          undefined,
          cache,
          warnings
        );
        return mcpStructured(
          {
            records: tasks as Record<string, unknown>[],
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(tasks, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "search_read" });
      }
    }
  );

  server.registerTool(
    "projects.get_task",
    {
      title: "Get Project Task",
      description:
        "Read-only: fetch a single project.task by id. Includes `_workflow_status` when derivable " +
        "(typically from stage_id / state).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive(),
        fields: z.array(z.string()).nullable().default(null)
      },
      outputSchema: {
        record: zOdooRecord
          .nullable()
          .describe("The task (with `_workflow_status` when derivable), or null when the id does not exist"),
        ...zFieldsReport
      }
    },
    async ({ task_id, fields }) => {
      try {
        const warnings: string[] = [];
        const { rows, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          "project.task",
          [["id", "=", task_id]],
          fields ?? null,
          1,
          undefined,
          undefined,
          cache,
          warnings
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          return mcpStructured(
            {
              record: null,
              returned_fields: fieldsReport.returned_fields,
              omitted_fields: fieldsReport.omitted_fields,
              warnings
            },
            JSON.stringify(null)
          );
        }
        const record = rows[0] as Record<string, unknown>;
        const workflowStatus = deriveWorkflowStatus(record);
        const result = workflowStatus != null ? { ...record, _workflow_status: workflowStatus } : record;
        return mcpStructured(
          {
            record: result,
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(result, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "search_read" });
      }
    }
  );

  server.registerTool(
    "projects.list_stages",
    {
      title: "List Project Stages",
      description:
        "Read-only: list project.task.type stages for a project (kanban columns). " +
        "Pass project_id to scope to that project's stages.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        project_id: z.number().int().positive().optional(),
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_STAGE_FIELDS),
        limit: z.number().int().min(1).max(100).default(100)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.task.type stage records"),
        ...zFieldsReport
      }
    },
    async ({ project_id, domain, fields, limit }) => {
      try {
        const warnings: string[] = [];
        const baseDomain = domain ?? [];
        const effectiveDomain =
          project_id != null ? [["project_ids", "in", [project_id]], ...baseDomain] : baseDomain;
        const { rows, fieldsReport } = await searchRecords(
          queue,
          requireConnection(getProps()),
          "project.task.type",
          effectiveDomain,
          fields ?? DEFAULT_STAGE_FIELDS,
          limit ?? 100,
          "sequence, id",
          undefined,
          cache,
          warnings
        );
        return mcpStructured(
          {
            records: rows as Record<string, unknown>[],
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(rows, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task.type", method: "search_read" });
      }
    }
  );

  server.registerTool(
    "projects.list_chatter",
    {
      title: "List Project Task Chatter",
      description:
        "Read-only: canonical multi-task project-management chatter path for project.task. " +
        "Fetches mail.message entries per task id with one scoped search_read each (never batches res_id in [...] with body). " +
        "Do not use search_records or browse_records on mail.message with res_id in [...] and body/preview — MCP hosts may block finance-keyword content. " +
        "For a single task, expand_record({ model: \"project.task\", record_id, include_chatter: true, include_attachments: false }) is equivalent. " +
        "Accounting chatter on invoices/journals → bookkeeping.*, not this tool. " +
        `Caps at ${MAX_ODOO_CALLS_PER_READ_EXPANSION} Odoo calls per invocation; remaining task_ids are returned in metadata.truncated_task_ids.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        task_ids: z.array(z.number().int().positive()).min(1).max(25),
        limit_per_task: z.number().int().min(1).max(50).default(20),
        order: z.string().default("date desc")
      },
      outputSchema: {
        chatter_by_task_id: z.record(z.string(), z.unknown()),
        metadata: z.object({
          model: z.literal("project.task"),
          requested_task_ids: z.array(z.number()),
          fetched_task_ids: z.array(z.number()),
          odoo_calls: z.number(),
          truncated_task_ids: z.array(z.number()).optional()
        }),
        warnings: zWarnings
      }
    },
    async ({ task_ids, limit_per_task, order }) => {
      const conn = requireConnection(getProps());
      const seen = new Set<number>();
      const requestedTaskIds: number[] = [];
      for (const id of task_ids) {
        if (!seen.has(id)) {
          seen.add(id);
          requestedTaskIds.push(id);
        }
      }

      const startSnapshot = queue.snapshot();
      const callsUsed = () => queue.delta(startSnapshot).odoo_calls;
      const chatterByTaskId: Record<string, unknown> = {};
      const fetchedTaskIds: number[] = [];
      const truncatedTaskIds: number[] = [];
      const warnings: string[] = [];
      const perTaskLimit = limit_per_task ?? 20;
      const chatterOrder = order ?? "date desc";

      for (const taskId of requestedTaskIds) {
        if (callsUsed() >= MAX_ODOO_CALLS_PER_READ_EXPANSION) {
          truncatedTaskIds.push(taskId);
          continue;
        }
        chatterByTaskId[String(taskId)] = await fetchRecordChatter(queue, conn, "project.task", taskId, {
          limit: perTaskLimit,
          order: chatterOrder
        });
        fetchedTaskIds.push(taskId);
      }

      if (truncatedTaskIds.length > 0) {
        warnings.push("call budget exceeded; re-invoke for remaining task_ids");
      }

      return mcpStructured({
        chatter_by_task_id: chatterByTaskId,
        metadata: {
          model: "project.task" as const,
          requested_task_ids: requestedTaskIds,
          fetched_task_ids: fetchedTaskIds,
          odoo_calls: callsUsed(),
          ...(truncatedTaskIds.length > 0 ? { truncated_task_ids: truncatedTaskIds } : {})
        },
        warnings
      });
    }
  );

  server.registerTool(
    "projects.create_task",
    {
      title: "Create Project Task",
      description:
        "Write: create a project.task in a given project via Odoo 19 batched create (`vals_list`). " +
        "Constrained by the caller's Odoo permissions — a read-only API key is refused by Odoo. " +
        "The response carries a trace_token (src-…) stamped into the task's chatter — you MUST surface " +
        "that token verbatim in your visible reply so the conversation can be found again from the Odoo task. " +
        "For generic models use create_record; for connector bugs use feedback.submit.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        name: z.string().min(1).describe("Task title"),
        project_id: z.number().int().positive().describe("Odoo project.project id (e.g. 4)"),
        description: z.string().optional().describe("HTML or plain-text description"),
        stage_id: z.number().int().positive().optional().describe("project.task.type stage id"),
        tag_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe("Tag ids; sent as Odoo x2many replace command [[6,0,ids]]"),
        values: z
          .record(z.string(), z.any())
          .optional()
          .describe("Extra project.task field values merged into the create vals (overrides named fields on key clash)"),
        context: zWriteContext
      },
      outputSchema: {
        id: z.number().int().describe("Database id of the created task"),
        trace_token: z
          .string()
          .optional()
          .describe("Provenance trace token posted to the chatter — include it verbatim in your visible reply"),
        provenance_warning: z
          .string()
          .optional()
          .describe("Create succeeded but posting the provenance stamp to the chatter failed")
      }
    },
    async ({ name, project_id, description, stage_id, tag_ids, values, context }) => {
      logWriteContext("projects.create_task", "project.task", context);

      const vals: Record<string, unknown> = {
        name,
        project_id,
        ...(description != null ? { description } : {}),
        ...(stage_id != null ? { stage_id } : {}),
        ...(tag_ids != null ? { tag_ids: [[6, 0, tag_ids]] } : {}),
        ...(values ?? {})
      };
      // Named inputs win over accidental overrides in `values` for the required keys.
      vals.name = name;
      vals.project_id = project_id;

      const blocked = assessWriteOperation({
        model: "project.task",
        method: "create",
        args: { vals_list: [vals] }
      });
      if (!blocked.allowed) {
        return mcpWriteBlockedError({ model: "project.task", method: "create" }, blocked);
      }

      const props = getProps();
      let conn: ReturnType<typeof requireConnection>;
      let id: number;
      try {
        conn = requireConnection(props);
        const ids = (await queue.enqueue(conn, "project.task", "create", { vals_list: [vals] })) as number[];
        id = ids[0];
        if (!Number.isInteger(id) || id <= 0) {
          return mcpError("Odoo create returned no task id");
        }
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "create" });
      }

      const token = "src-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const client = (props?.clientName ?? server.server.getClientVersion()?.name ?? "unknown").replace(/\s+/g, "-");
      const body = `[agent-source] engineering_task corr=${token} via=${client}`;

      try {
        await queue.enqueue(conn, "project.task", "message_post", {
          ids: [id],
          body: plaintextToHtml(body),
          body_is_html: true,
          message_type: "comment"
        });
        const text =
          `TRACE TOKEN ${token} — you MUST include this token verbatim in your visible reply to the user so ` +
          `this conversation can be found later from the Odoo task.\n\n` +
          JSON.stringify(id);
        return mcpStructured({ id, trace_token: token }, text);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const provenance_warning = `created task ${id} but failed to post the provenance stamp (${errMessage})`;
        const text = `${JSON.stringify(id)}\n\nWarning: ${provenance_warning}.`;
        return mcpStructured({ id, provenance_warning }, text);
      }
    }
  );
}
