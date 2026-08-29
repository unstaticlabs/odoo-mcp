import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zIdempotencyKey, zMutationExecution, zOdooContext, zReason } from "../mutation";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { buildRecordUrl } from "./record-urls";
import { mcpErrorFromException, mcpMutationResultError, mcpStructured, plaintextToHtml, requireConnection } from "./shared";

const zModel = z.string().trim().min(1, "model must be a non-empty string").max(255).describe("Exact Odoo model technical name discovered from API metadata");
const zPositiveId = z.number().int().positive("record_id must be a positive integer");
const zMethod = z.string().trim().min(1, "method must be a non-empty string").max(255);
const zValues = z.record(z.string().min(1).max(255), z.unknown());
const zContextInputs = {
  reason: zReason,
  odoo_context: zOdooContext,
  idempotency_key: zIdempotencyKey
};

const GENERIC_GUIDANCE =
  "Odoo is authoritative for ACLs, record rules, field access, workflow validation, company scope, and irreversible-action policy. " +
  "Discover schema and public methods before use. A denial from Odoo is final; do not seek a connector bypass. ";

function mutationOptions(input: {
  reason?: string;
  odoo_context?: Record<string, unknown>;
  idempotency_key?: string;
}) {
  return {
    reason: input.reason,
    odooContext: input.odoo_context,
    idempotencyKey: input.idempotency_key
  };
}

function firstCreatedId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (Array.isArray(value)) return firstCreatedId(value[0]);
  return null;
}

/** Universal JSON-2 mutations. The connector validates transport shape, never Odoo authorization. */
export function registerWriteTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue
) {
  server.registerTool(
    "create_record",
    {
      title: "Create Odoo Record",
      description:
        "Create one record on any Odoo model using the authenticated user's permissions. " +
        GENERIC_GUIDANCE +
        "Returns the created id, canonical `web_url`, and execution metadata; cite the URL, never as a bare id.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({ model: zModel, values: zValues, ...zContextInputs }).strict(),
      outputSchema: {
        id: z.number().int().positive(),
        web_url: z.string().nullable(),
        execution: zMutationExecution
      }
    },
    async ({ model, values, reason, odoo_context, idempotency_key }) => {
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(conn, mutationOptions({ reason, odoo_context, idempotency_key }), (scope) =>
          scope.call<unknown>(model, "create", { vals_list: [values] })
        );
        const id = firstCreatedId(mutation.result);
        if (id == null) {
          return mcpMutationResultError("Odoo create returned no positive record id.", mutation.execution, {
            model,
            method: "create"
          });
        }
        return mcpStructured({ id, web_url: buildRecordUrl(conn.url, model, id), execution: mutation.execution });
      } catch (error) {
        return mcpErrorFromException(error, { model, method: "create" });
      }
    }
  );

  server.registerTool(
    "update_record",
    {
      title: "Update Odoo Record",
      description:
        "Write fields on one record of any Odoo model using the authenticated user's permissions. Returns `web_url`; cite it, never as a bare id. " + GENERIC_GUIDANCE,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({ model: zModel, record_id: zPositiveId, values: zValues, ...zContextInputs }).strict(),
      outputSchema: {
        updated: z.boolean(),
        id: z.number().int().positive(),
        web_url: z.string().nullable(),
        execution: zMutationExecution
      }
    },
    async ({ model, record_id, values, reason, odoo_context, idempotency_key }) => {
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(conn, mutationOptions({ reason, odoo_context, idempotency_key }), (scope) =>
          scope.call<unknown>(model, "write", { ids: [record_id], vals: values })
        );
        return mcpStructured({
          updated: Boolean(mutation.result),
          id: record_id,
          web_url: buildRecordUrl(conn.url, model, record_id),
          execution: mutation.execution
        });
      } catch (error) {
        return mcpErrorFromException(error, { model, method: "write", record_ids: [record_id] });
      }
    }
  );

  server.registerTool(
    "batch_update",
    {
      title: "Batch Update Odoo Records",
      description:
        "Apply distinct field updates to up to 100 records of one model. Each record is a separate Odoo transaction with a deterministic child idempotency key; use one public Odoo method instead when the whole operation must be atomic. " +
        GENERIC_GUIDANCE + "Returns `web_urls`; cite every URL, never as a bare id.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        model: zModel,
        updates: z.array(z.object({ record_id: zPositiveId, values: zValues })).min(1).max(100),
        ...zContextInputs
      }).strict(),
      outputSchema: {
        updated_ids: z.array(z.number().int().positive()),
        web_urls: z.array(z.string()),
        execution: zMutationExecution
      }
    },
    async ({ model, updates, reason, odoo_context, idempotency_key }) => {
      const ids = updates.map((item) => item.record_id);
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(
          conn,
          mutationOptions({ reason, odoo_context, idempotency_key }),
          async (scope) => {
            for (const [index, update] of updates.entries()) {
              await scope.call(model, "write", { ids: [update.record_id], vals: update.values }, `batch:${index}`);
            }
            return ids;
          }
        );
        return mcpStructured({
          updated_ids: mutation.result,
          web_urls: mutation.result.map((id) => buildRecordUrl(conn.url, model, id)).filter((url): url is string => url != null),
          execution: mutation.execution
        });
      } catch (error) {
        return mcpErrorFromException(error, { model, method: "write", record_ids: ids, partial_write: true });
      }
    }
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete Odoo Record",
      description:
        "Call unlink on one record of any Odoo model. Odoo decides whether deletion is permitted, including its irreversible-action policy. " +
        GENERIC_GUIDANCE,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({ model: zModel, record_id: zPositiveId, ...zContextInputs }).strict(),
      outputSchema: { deleted: z.boolean(), id: z.number().int().positive(), execution: zMutationExecution }
    },
    async ({ model, record_id, reason, odoo_context, idempotency_key }) => {
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(conn, mutationOptions({ reason, odoo_context, idempotency_key }), (scope) =>
          scope.call<unknown>(model, "unlink", { ids: [record_id] })
        );
        return mcpStructured({ deleted: Boolean(mutation.result), id: record_id, execution: mutation.execution });
      } catch (error) {
        return mcpErrorFromException(error, { model, method: "unlink", record_ids: [record_id] });
      }
    }
  );

  server.registerTool(
    "post_message",
    {
      title: "Post Odoo Chatter Message",
      description:
        "Post one chatter message on any record. Plain text is escaped once and preserves line breaks; set body_is_html only for intentional HTML. " +
        GENERIC_GUIDANCE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        model: zModel,
        record_id: zPositiveId,
        body: z.string().min(1).max(100_000),
        subtype: z.string().min(1).max(255).default("mail.mt_note"),
        body_is_html: z.boolean().default(false),
        ...zContextInputs
      }).strict(),
      outputSchema: { message_id: z.number().int().nullable(), execution: zMutationExecution }
    },
    async ({ model, record_id, body, subtype, body_is_html, reason, odoo_context, idempotency_key }) => {
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(conn, mutationOptions({ reason, odoo_context, idempotency_key }), (scope) =>
          scope.call<unknown>(model, "message_post", {
            ids: [record_id],
            body: body_is_html ? body : plaintextToHtml(body),
            body_is_html: true,
            subtype_xmlid: subtype
          })
        );
        const messageId = typeof mutation.result === "number" && Number.isInteger(mutation.result) ? mutation.result : null;
        return mcpStructured({ message_id: messageId, execution: mutation.execution });
      } catch (error) {
        return mcpErrorFromException(error, { model, method: "message_post", record_ids: [record_id] });
      }
    }
  );

  server.registerTool(
    "batch_post_message",
    {
      title: "Batch Post Odoo Chatter Messages",
      description:
        "Post up to 100 distinct chatter messages. Each post is a separate Odoo transaction with a deterministic child idempotency key. " +
        GENERIC_GUIDANCE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        model: zModel,
        messages: z
          .array(
            z.object({
              record_id: zPositiveId,
              body: z.string().min(1).max(100_000),
              subtype: z.string().min(1).max(255).default("mail.mt_note"),
              body_is_html: z.boolean().default(false)
            })
          )
          .min(1)
          .max(100),
        ...zContextInputs
      }).strict(),
      outputSchema: { posted_record_ids: z.array(z.number().int().positive()), execution: zMutationExecution }
    },
    async ({ model, messages, reason, odoo_context, idempotency_key }) => {
      const ids = messages.map((message) => message.record_id);
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(
          conn,
          mutationOptions({ reason, odoo_context, idempotency_key }),
          async (scope) => {
            for (const [index, message] of messages.entries()) {
              await scope.call(
                model,
                "message_post",
                {
                  ids: [message.record_id],
                  body: message.body_is_html ? message.body : plaintextToHtml(message.body),
                  body_is_html: true,
                  subtype_xmlid: message.subtype
                },
                `message:${index}`
              );
            }
            return ids;
          }
        );
        return mcpStructured({ posted_record_ids: mutation.result, execution: mutation.execution });
      } catch (error) {
        return mcpErrorFromException(error, { model, method: "message_post", record_ids: ids, partial_write: true });
      }
    }
  );

  server.registerTool(
    "call_model_method",
    {
      title: "Call Public Odoo Model Method",
      description:
        "Call any public JSON-2 model method with named kwargs and optional ids. Private or unpublished methods remain inaccessible through Odoo's dispatcher. Positional arguments are intentionally unsupported. " +
        GENERIC_GUIDANCE +
        "Because an arbitrary public method may mutate, this tool always uses the mutation reliability contract and returns execution metadata.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        model: zModel,
        method: zMethod,
        ids: z.array(zPositiveId).min(1).max(1000).optional(),
        kwargs: z.record(z.string().min(1).max(255), z.unknown()).default({}),
        ...zContextInputs
      }).strict(),
      outputSchema: { result: z.unknown(), execution: zMutationExecution }
    },
    async ({ model, method, ids, kwargs, reason, odoo_context, idempotency_key }) => {
      try {
        const conn = requireConnection(getProps());
        const mutation = await queue.runMutation(conn, mutationOptions({ reason, odoo_context, idempotency_key }), (scope) =>
          scope.call<unknown>(model, method, { ...kwargs, ...(ids ? { ids } : {}) })
        );
        return mcpStructured({ result: mutation.result, execution: mutation.execution });
      } catch (error) {
        return mcpErrorFromException(error, { model, method, ...(ids ? { record_ids: ids } : {}) });
      }
    }
  );
}
