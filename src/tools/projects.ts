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
import { base64ToBytes, PdfPagesError } from "../pdf-pages";
import { preflightProjectTaskStateWrite } from "../project-task-state-gate";
import { assessWriteOperation } from "../write-safety";
import { annotateRecordUrl, annotateRecordUrls, buildRecordUrl } from "./record-urls";
import {
  annotateWaitingTask,
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
  withWaitingAnnotationFields,
  zRequiredWriteContext,
  zWarnings,
  zWriteContext,
  type WriteBlockedIntent
} from "./shared";

/**
 * Default fields for project.project list/get — keep in lockstep with MODEL_FIELD_PRESETS.
 * `stage_id` is excluded on purpose: Odoo gates it behind `project.group_project_stages` ("Use
 * Stages on Project"), so a user without that group gets an AccessError for the whole read. Callers
 * that want it must request it explicitly, and get the drop-and-retry + `acl-denied` field report.
 */
export const DEFAULT_PROJECT_FIELDS = ["id", "name", "partner_id", "user_id"];
/** Default fields for project.task.type (stages). */
export const DEFAULT_STAGE_FIELDS = ["id", "name", "sequence", "fold"];

/** Shared note appended to every projects.* description that returns records. */
const RECORD_LINK_NOTE =
  " Each record carries `_web_url`, the canonical clickable Odoo link — cite records to the user as " +
  "[record name](_web_url), never as a bare id.";

/**
 * Byte cap for projects.attach_file, matching billing.attach_source_pdf / bookkeeping.fetch_attachment:
 * base64 inflates a payload ~1.37x, so this is the decoded size we are willing to hold in Worker memory.
 */
export const TASK_ATTACHMENT_MAX_BYTES = 10485760;
const TASK_ATTACHMENT_NAME_MAX = 255;
const DEFAULT_TASK_ATTACHMENT_MIMETYPE = "application/octet-stream";

/**
 * Error envelope for projects.* refusals, mirroring billing.ts's `billingBlocked`: a custom `error`
 * code gets a hand-built envelope, while a plain policy refusal goes through mcpWriteBlockedError.
 */
function projectsBlocked(
  context: { model: string; method?: string },
  opts: { intent?: WriteBlockedIntent; reason: string; blocked_fields?: string[]; error?: string }
) {
  if (opts.error && opts.error !== "write_blocked") {
    const envelope = {
      error: opts.error,
      intent: opts.intent ?? ("project_management" as const),
      model: context.model,
      method: context.method ?? "write",
      http_status: null,
      details: opts.reason,
      recoverable: false,
      ...(opts.blocked_fields?.length ? { blocked_fields: opts.blocked_fields } : {})
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
  }
  return mcpWriteBlockedError(
    { model: context.model, method: context.method ?? "write" },
    {
      intent: opts.intent ?? "project_management",
      reason: opts.reason,
      blocked_fields: opts.blocked_fields
    }
  );
}

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
      description: "Read-only: list Odoo project.project records matching a domain." + RECORD_LINK_NOTE,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_PROJECT_FIELDS),
        limit: z.number().int().min(1).max(100).default(100)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.project records, each with `_web_url`"),
        ...zFieldsReport
      }
    },
    async ({ domain, fields, limit }) => {
      try {
        const warnings: string[] = [];
        const conn = requireConnection(getProps());
        const { rows, fieldsReport } = await searchRecords(
          queue,
          conn,
          "project.project",
          domain ?? [],
          fields ?? DEFAULT_PROJECT_FIELDS,
          limit ?? 100,
          undefined,
          undefined,
          cache,
          warnings
        );
        const records = annotateRecordUrls(conn.url, "project.project", rows as Record<string, unknown>[]);
        return mcpStructured(
          {
            records,
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(records, null, 2)
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
      description:
        "Read-only: list Odoo project.task records matching a domain." +
        RECORD_LINK_NOTE +
        " Keep `project_id` in `fields` (it is in the default preset) so links keep the project route.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_TASK_FIELDS),
        limit: z.number().int().min(1).max(100).default(100)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.task records, each with `_web_url`"),
        ...zFieldsReport
      }
    },
    async ({ domain, fields, limit }) => {
      try {
        const warnings: string[] = [];
        const conn = requireConnection(getProps());
        const { rows: tasks, fieldsReport } = await searchRecords(
          queue,
          conn,
          "project.task",
          domain ?? [],
          fields ?? DEFAULT_TASK_FIELDS,
          limit ?? 100,
          undefined,
          undefined,
          cache,
          warnings
        );
        const records = annotateRecordUrls(conn.url, "project.task", tasks as Record<string, unknown>[]);
        return mcpStructured(
          {
            records,
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(records, null, 2)
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
        "(typically from stage_id / state). `state` and `depend_on_ids` are always projected: a task in " +
        "Waiting (`04_waiting_normal`) is annotated with `_waiting_derived`, `_open_blocker_ids` and " +
        "`_waiting_explanation`, because Odoo computes Waiting from open Blocked By dependencies." +
        RECORD_LINK_NOTE,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive(),
        fields: z.array(z.string()).nullable().default(null)
      },
      outputSchema: {
        record: zOdooRecord
          .nullable()
          .describe(
            "The task (with `_workflow_status` when derivable and `_web_url`), or null when the id does not exist"
          ),
        ...zFieldsReport
      }
    },
    async ({ task_id, fields }) => {
      try {
        const conn = requireConnection(getProps());
        const warnings: string[] = [];
        const { rows, fieldsReport } = await searchRecords(
          queue,
          conn,
          "project.task",
          [["id", "=", task_id]],
          withWaitingAnnotationFields("project.task", fields ?? null),
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
        const record = await annotateWaitingTask(queue, conn, rows[0] as Record<string, unknown>);
        const workflowStatus = deriveWorkflowStatus(record);
        const result = annotateRecordUrl(
          conn.url,
          "project.task",
          workflowStatus != null ? { ...record, _workflow_status: workflowStatus } : record
        );
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
        "Pass project_id to scope to that project's stages." +
        RECORD_LINK_NOTE,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        project_id: z.number().int().positive().optional(),
        domain: z.array(z.any()).default([]),
        fields: z.array(z.string()).default(DEFAULT_STAGE_FIELDS),
        limit: z.number().int().min(1).max(100).default(100)
      },
      outputSchema: {
        records: zOdooRecords.describe("Matching project.task.type stage records, each with `_web_url`"),
        ...zFieldsReport
      }
    },
    async ({ project_id, domain, fields, limit }) => {
      try {
        const warnings: string[] = [];
        const baseDomain = domain ?? [];
        const effectiveDomain =
          project_id != null ? [["project_ids", "in", [project_id]], ...baseDomain] : baseDomain;
        const conn = requireConnection(getProps());
        const { rows, fieldsReport } = await searchRecords(
          queue,
          conn,
          "project.task.type",
          effectiveDomain,
          fields ?? DEFAULT_STAGE_FIELDS,
          limit ?? 100,
          "sequence, id",
          undefined,
          cache,
          warnings
        );
        const records = annotateRecordUrls(conn.url, "project.task.type", rows as Record<string, unknown>[]);
        return mcpStructured(
          {
            records,
            returned_fields: fieldsReport.returned_fields,
            omitted_fields: fieldsReport.omitted_fields,
            warnings
          },
          JSON.stringify(records, null, 2)
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
        "Waiting is derived, never set: Odoo computes `state=04_waiting_normal` from open Blocked By " +
        "dependencies, so express blocking via `depend_on_ids` and never write that state yourself. " +
        "For deferred work at create time, pass the park `stage_id` (On Hold or equivalent) and keep an ordinary " +
        "open state — never set Waiting; express real blockers only via `depend_on_ids`. " +
        "The response also carries `web_url`: report the new task to the user as [task name](web_url), not as an id. " +
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
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the created task — surface it as [task name](web_url)"),
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

      // create_task does not route through guardMutation, so the stateful state gate is explicit here.
      const statePreflight = await preflightProjectTaskStateWrite({
        method: "create",
        args: { vals_list: [vals] },
        queue,
        getProps
      });
      if (!statePreflight.ok) return statePreflight.response;

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
      // project_id is a required input here, so the link always keeps the nested project route.
      const webUrl = buildRecordUrl(conn.url, "project.task", id, vals);
      const link = webUrl ? ` Report it to the user as [${name}](${webUrl}).` : "";

      try {
        await queue.enqueue(conn, "project.task", "message_post", {
          ids: [id],
          body: plaintextToHtml(body),
          body_is_html: true,
          message_type: "comment"
        });
        const text =
          `TRACE TOKEN ${token} — you MUST include this token verbatim in your visible reply to the user so ` +
          `this conversation can be found later from the Odoo task.${link}\n\n` +
          JSON.stringify(id);
        return mcpStructured({ id, ...(webUrl ? { web_url: webUrl } : {}), trace_token: token }, text);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const provenance_warning = `created task ${id} but failed to post the provenance stamp (${errMessage})`;
        const text = `${JSON.stringify(id)}${link}\n\nWarning: ${provenance_warning}.`;
        return mcpStructured({ id, ...(webUrl ? { web_url: webUrl } : {}), provenance_warning }, text);
      }
    }
  );

  server.registerTool(
    "projects.attach_file",
    {
      title: "Attach File To Project Task",
      description:
        "Write: create one binary ir.attachment holding the supplied base64 bytes and link it to an existing " +
        "project.task via res_model/res_id. Built for agent-generated evidence — audit workbooks, exports, " +
        "reports — that belongs on the task documenting the work. The task itself is never modified, and no " +
        "existing attachment is ever deleted or rewritten. This is not generic ir.attachment CRUD: it only ever " +
        "creates one attachment on one project.task. To link an already-filed Documents record instead of " +
        "uploading new bytes use bookkeeping.link_source_document; for draft vendor bills use billing.attach_source_pdf.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive().describe("Existing project.task id to attach the file to"),
        name: z
          .string()
          .min(1)
          .max(TASK_ATTACHMENT_NAME_MAX)
          .describe("File name for the new attachment (e.g. `q3-vat-workbook.xlsx`)"),
        datas: z.string().min(1).describe("File bytes, base64-encoded"),
        mimetype: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe(`MIME type of the payload; defaults to ${DEFAULT_TASK_ATTACHMENT_MIMETYPE}`),
        res_model: z
          .literal("project.task")
          .default("project.task")
          .describe("Always project.task — this tool cannot retarget another model"),
        max_bytes: z
          .number()
          .int()
          .positive()
          .default(TASK_ATTACHMENT_MAX_BYTES)
          .describe("Refuse payloads decoding to more than this many bytes, before any Odoo call"),
        context: zRequiredWriteContext
      },
      outputSchema: {
        ok: z.boolean(),
        attachment_id: z.number().int().describe("id of the newly created ir.attachment"),
        task_id: z.number().int(),
        res_model: z.literal("project.task"),
        res_id: z.number().int(),
        name: z.string(),
        mimetype: z.string(),
        file_size: z.number().int().describe("decoded byte length of the stored payload")
      }
    },
    async ({ task_id, name, datas, mimetype, res_model, max_bytes = TASK_ATTACHMENT_MAX_BYTES, context }) => {
      const model = "ir.attachment";
      const taskModel = "project.task";
      logWriteContext("projects.attach_file", model, context);

      // Deliberately no assessWriteOperation / PM gate call here: ir.attachment is not in
      // PM_MODEL_ALLOWLIST, so the classifier would default-deny this tool's own create. That denial
      // is correct for generic create_record and must stay; this tool enforces the narrower invariants
      // itself (project.task-only target, single binary attachment, size cap) — same shape as
      // billing.attach_source_pdf. projects.create_task above does call the gate because project.task
      // *is* allowlisted; the difference is intentional, not an oversight.

      // Defensive: the zod literal (and its default) normally settles this before the handler runs.
      if ((res_model ?? taskModel) !== taskModel) {
        return projectsBlocked(
          { model, method: "create" },
          {
            error: "invalid_res_model",
            reason:
              `projects.attach_file only attaches to ${taskModel}; got res_model=${String(res_model)}. ` +
              "Use bookkeeping.link_source_document or billing.attach_source_pdf for other targets. " +
              "No Odoo call was made."
          }
        );
      }

      // Decode locally first — an invalid or oversize payload never costs an Odoo round-trip.
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(datas);
      } catch (err) {
        if (err instanceof PdfPagesError) {
          return projectsBlocked(
            { model, method: "create" },
            {
              error: "invalid_base64",
              reason:
                "`datas` is not valid base64, so nothing could be decoded to store. Send the raw file bytes " +
                "base64-encoded (whitespace is tolerated). No Odoo call was made."
            }
          );
        }
        throw err;
      }
      if (bytes.length === 0) {
        return projectsBlocked(
          { model, method: "create" },
          {
            error: "empty_datas",
            reason: "`datas` decodes to zero bytes; there is nothing to attach. No Odoo call was made."
          }
        );
      }
      if (bytes.length > max_bytes) {
        return projectsBlocked(
          { model, method: "create" },
          {
            error: "oversize",
            reason:
              `\`datas\` decodes to ${bytes.length} bytes, exceeding max_bytes (${max_bytes}). ` +
              "Base64 encoding inflates the payload ~1.37x against Worker memory limits, so it was not sent. " +
              "Raise max_bytes if you really need this file. No Odoo call was made."
          }
        );
      }

      const resolvedMimetype = mimetype ?? DEFAULT_TASK_ATTACHMENT_MIMETYPE;

      try {
        const conn = requireConnection(getProps());

        // The target task must exist. Odoo ACLs stay the authz layer — a key that may not read the
        // task errors out of Odoo here, which is the intended behaviour.
        const taskRows = await queue.enqueue(conn, taskModel, "read", {
          ids: [task_id],
          fields: ["id", "name"]
        });
        if (!Array.isArray(taskRows) || taskRows.length === 0) {
          return projectsBlocked(
            { model: taskModel, method: "read" },
            { error: "not_found", reason: `project.task id ${task_id} was not found.` }
          );
        }

        // Store the caller's own base64 (whitespace-stripped) rather than re-encoding, so the stored
        // bytes are byte-identical to the ones validated above. `context` is audit-only, never a val.
        const created = await queue.enqueue(conn, model, "create", {
          vals_list: [
            {
              name,
              type: "binary",
              mimetype: resolvedMimetype,
              datas: datas.replace(/\s+/g, ""),
              res_model: taskModel,
              res_id: task_id
            }
          ]
        });
        const attachment_id = Array.isArray(created) ? created[0] : created;
        if (typeof attachment_id !== "number" || !Number.isInteger(attachment_id) || attachment_id <= 0) {
          return mcpError("Odoo create returned no ir.attachment id");
        }

        return mcpStructured({
          ok: true,
          attachment_id,
          task_id,
          res_model: "project.task" as const,
          res_id: task_id,
          name,
          mimetype: resolvedMimetype,
          file_size: bytes.length
        });
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "create" });
      }
    }
  );
}

/**
 * Fixed-intent PM writes: no caller-supplied model, so MCP hosts need not risk-classify the prose.
 * Mirrors PM_WRITE_ROUTING_NOTE in src/tools/write.ts, but states the structural guarantee these
 * three tools have and the generic write tools cannot: model, method and field set are hardcoded here.
 */
const PM_SAFE_WRITE_NOTE =
  " This is a PM-safe project-management write: the Odoo model, method and field set are fixed by the tool, " +
  "so operational prose (banking files, B2C exports, VAT/payroll deadlines) is stored verbatim and is NOT an " +
  "accounting mutation. Accounting work — tax close, reports, returns, lock exceptions — goes to " +
  "bookkeeping.plan_safe_write only; never route it here and never use generic create_record / post_message / " +
  "update_record for project-management notes.";

/**
 * Fixed-intent project-management writes (`projects.create_activity` / `post_note` / `update_task`).
 *
 * Registered separately from `registerProjectsTools` because these need no cache: each tool targets one
 * hardcoded (model, method) pair with a curated field set, so there is nothing to look up and nothing a
 * caller can retarget. That is the whole safety argument — see PM_SAFE_WRITE_NOTE.
 */
export function registerProjectWriteTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue
) {
  server.registerTool(
    "projects.create_activity",
    {
      title: "Create Task Activity",
      description:
        "Write: schedule one mail.activity (to-do / follow-up) on an existing project.task. " +
        "`res_model` and `res_id` are set by the tool from `task_id` — the caller never names a model, so this " +
        "cannot create an activity on an accounting or external-party record. " +
        "Use it to assign follow-up work to a person with a deadline; for a plain chatter comment use " +
        "projects.post_note, and to change the task's own fields use projects.update_task." +
        PM_SAFE_WRITE_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive().describe("project.task id the activity is attached to"),
        summary: z.string().min(1).describe("Activity title, stored verbatim"),
        note: z.string().optional().describe("Activity body, stored verbatim (plain text is HTML-escaped)"),
        date_deadline: z.string().optional().describe("Due date, `YYYY-MM-DD`"),
        user_id: z.number().int().positive().describe("res.users id of the assignee"),
        activity_type_id: z.number().int().positive().describe("mail.activity.type id (To Do, Call, Meeting, …)"),
        context: zWriteContext
      },
      outputSchema: {
        id: z.number().int().describe("Database id of the created mail.activity"),
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the task carrying the activity — surface it as [task name](web_url)")
      }
    },
    async ({ task_id, summary, note, date_deadline, user_id, activity_type_id, context }) => {
      logWriteContext("projects.create_activity", "mail.activity", context);

      // res_model / res_id come from task_id, never from the caller — the tool's core invariant.
      const vals: Record<string, unknown> = {
        res_model: "project.task",
        res_id: task_id,
        activity_type_id,
        user_id,
        summary,
        // `note` is an Html field: escape (never scan) so the prose survives byte-identical.
        ...(note != null ? { note: plaintextToHtml(note) } : {}),
        ...(date_deadline != null ? { date_deadline } : {})
      };

      const blocked = assessWriteOperation({
        model: "mail.activity",
        method: "create",
        args: { vals_list: [vals] }
      });
      if (!blocked.allowed) {
        return mcpWriteBlockedError({ model: "mail.activity", method: "create" }, blocked);
      }

      // No preflightProjectTaskStateWrite here: that gate reads project.task vals (`state`), and this
      // create never touches the task record.
      try {
        const conn = requireConnection(getProps());
        const ids = (await queue.enqueue(conn, "mail.activity", "create", { vals_list: [vals] })) as number[];
        const id = Array.isArray(ids) ? ids[0] : (ids as unknown as number);
        if (!Number.isInteger(id) || id <= 0) {
          return mcpError("Odoo create returned no activity id");
        }
        // Link the task, not the activity: an activity has no standalone record route.
        const webUrl = buildRecordUrl(conn.url, "project.task", task_id, {});
        return mcpStructured(
          { id, ...(webUrl ? { web_url: webUrl } : {}) },
          webUrl ? `${JSON.stringify(id)}\n\nOdoo task: ${webUrl}` : JSON.stringify(id, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "mail.activity", method: "create" });
      }
    }
  );

  server.registerTool(
    "projects.post_note",
    {
      title: "Post Task Note",
      description:
        "Write: post one chatter note (comment) on an existing project.task. The model and method are fixed — " +
        "`project.task` / `message_post` — so the caller supplies only the task id and the text. " +
        "This is the correct destination for follow-up notes, decisions, justifications and action history: " +
        "chatter entries are append-only and timestamped, unlike the task's Description field, which a write " +
        "overwrites without history (use projects.update_task only for durable task data)." +
        PM_SAFE_WRITE_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive().describe("project.task id to post the note on"),
        note: z.string().min(1).describe("Note body, stored verbatim"),
        body_is_html: z
          .boolean()
          .default(false)
          .describe("True when `note` is already HTML; plain text is escaped for you"),
        context: zWriteContext
      },
      outputSchema: {
        result: z
          .unknown()
          .describe("Raw message_post return value (shape varies by Odoo version; typically the created mail.message id)"),
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the task — surface it as [task name](web_url)")
      }
    },
    async ({ task_id, note, body_is_html, context }) => {
      logWriteContext("projects.post_note", "project.task", context);

      const body = body_is_html ? note : plaintextToHtml(note);

      const blocked = assessWriteOperation({
        model: "project.task",
        method: "message_post",
        args: { ids: [task_id], body }
      });
      if (!blocked.allowed) {
        return mcpWriteBlockedError({ model: "project.task", method: "message_post" }, blocked);
      }

      try {
        const conn = requireConnection(getProps());
        const result = await queue.enqueue(conn, "project.task", "message_post", {
          ids: [task_id],
          body,
          // Body is HTML either way (caller-supplied, or escaped above) — declare it so Odoo
          // does not double-escape. Same contract as post_message in write.ts.
          body_is_html: true,
          message_type: "comment"
        });
        const webUrl = buildRecordUrl(conn.url, "project.task", task_id, {});
        return mcpStructured(
          { result, ...(webUrl ? { web_url: webUrl } : {}) },
          webUrl ? `${JSON.stringify(result)}\n\nOdoo task: ${webUrl}` : JSON.stringify(result, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, {
          model: "project.task",
          method: "message_post",
          record_ids: [task_id]
        });
      }
    }
  );

  server.registerTool(
    "projects.update_task",
    {
      title: "Update Project Task",
      description:
        "Write: update a curated set of fields on one existing project.task — name, description, date_deadline, " +
        "stage_id, priority. No `model` and no free-form `values` dict: anything outside that set is simply not " +
        "expressible, and an update supplying none of them is refused before any Odoo call. " +
        "`description` REPLACES the previous text and is not versioned — for follow-up notes and history use " +
        "projects.post_note; for assigned follow-up work use projects.create_activity. " +
        "To defer/park a task set `stage_id` to the board's On Hold column; Waiting " +
        "(`state=04_waiting_normal`) is Odoo-derived from open Blocked By and is not writable here at all." +
        PM_SAFE_WRITE_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        task_id: z.number().int().positive().describe("project.task id to update"),
        name: z.string().min(1).optional().describe("New task title, stored verbatim"),
        description: z
          .string()
          .optional()
          .describe("New description (HTML or plain text), stored verbatim — REPLACES the current value"),
        date_deadline: z
          .string()
          .nullable()
          .optional()
          .describe("Deadline `YYYY-MM-DD`; pass null to clear it"),
        stage_id: z.number().int().positive().optional().describe("project.task.type stage id"),
        priority: z.enum(["0", "1"]).optional().describe("Odoo selection: \"0\" normal, \"1\" starred"),
        context: zWriteContext
      },
      outputSchema: {
        ok: z.boolean().describe("True when the write succeeded"),
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the updated task — surface it as [task name](web_url)")
      }
    },
    async ({ task_id, name, description, date_deadline, stage_id, priority, context }) => {
      logWriteContext("projects.update_task", "project.task", context);

      // Only keys the caller actually sent: `date_deadline: null` clears, an absent key is untouched.
      const vals: Record<string, unknown> = {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(date_deadline !== undefined ? { date_deadline } : {}),
        ...(stage_id !== undefined ? { stage_id } : {}),
        ...(priority !== undefined ? { priority } : {})
      };
      if (Object.keys(vals).length === 0) {
        return mcpError(
          "projects.update_task requires at least one of name, description, date_deadline, stage_id, priority"
        );
      }

      const blocked = assessWriteOperation({
        model: "project.task",
        method: "write",
        args: { ids: [task_id], vals }
      });
      if (!blocked.allowed) {
        return mcpWriteBlockedError({ model: "project.task", method: "write" }, blocked);
      }

      // A no-op today (`state` is outside the curated field set, so this costs zero Odoo calls), kept
      // for parity with projects.create_task so growing the field set cannot bypass the state gate.
      const statePreflight = await preflightProjectTaskStateWrite({
        method: "write",
        ids: [task_id],
        args: { ids: [task_id], vals },
        queue,
        getProps
      });
      if (!statePreflight.ok) return statePreflight.response;

      try {
        const conn = requireConnection(getProps());
        await queue.enqueue(conn, "project.task", "write", { ids: [task_id], vals });
        // `vals` carries only the written fields, so a task whose project_id was not touched
        // degrades to the all-tasks route rather than a wrong project breadcrumb.
        const webUrl = buildRecordUrl(conn.url, "project.task", task_id, vals);
        return mcpStructured(
          { ok: true, ...(webUrl ? { web_url: webUrl } : {}) },
          webUrl ? `${JSON.stringify(true)}\n\nOdoo task: ${webUrl}` : JSON.stringify(true, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "write", record_ids: [task_id] });
      }
    }
  );
}
