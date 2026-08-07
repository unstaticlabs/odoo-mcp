import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildDuplicateDomain,
  DUPLICATE_PREFLIGHT_LIMIT,
  inventoryMasterDataParentField,
  normalizeParentValue
} from "../inventory-master-data";
import { isReversibleLifecycleMethod, type RiskClass } from "../lifecycle-allowlist";
import { preflightLifecycleCall } from "../lifecycle-gate";
import type { OdooQueue } from "../odoo-queue";
import { preflightProjectTaskStateWrite } from "../project-task-state-gate";
import { classifyOperation, type OperationClassification } from "../policy";
import {
  collectPmValueRecords,
  issueConfirmationToken,
  verifyConfirmationToken,
  type WritePlan
} from "../safety";
import type { Props } from "../server";
import { assessWriteOperation, isMutatingOdooMethod } from "../write-safety";
import { buildRecordUrl } from "./record-urls";
import {
  logWriteContext,
  mcpConfirmationRequired,
  mcpError,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  plaintextToHtml,
  requireConnection,
  zWriteContext
} from "./shared";

/**
 * Appended to write descriptions that return an affected record: the user needs a link back
 * into Odoo, not the id we happen to have. See src/tools/record-urls.ts.
 */
const RECORD_LINK_WRITE_NOTE =
  " The response carries `web_url`, the canonical clickable Odoo link for the record — confirm the write to the " +
  "user as [record name](web_url), never as a bare id.";

const PM_WRITE_ROUTING_NOTE =
  " Project-management notes (including banking/B2C/deadline operational text) on project.task / project.project / mail.activity→project.* are allowed. " +
  "Accounting models are action-classified (not prefix-denied): reversible configuration/lifecycle go to Odoo; " +
  "irreversible posting/payment/reconcile/delete/lock require a confirmation_token (preflight → confirm → execute). " +
  "Draft vendor-bill / expense prep helpers: billing.update_draft_expense / billing.configure_draft_vendor_bill. " +
  "Tax-close / report / return / lock-exception: bookkeeping.plan_safe_write. " +
  "Inventory: only product.category and stock.location accept create/write (duplicate name+parent is refused); " +
  "other product.* / stock.* models are not writable here.";

/**
 * Waiting (`04_waiting_normal`) is Odoo-derived from open Blocked By; agents discover only
 * tool schemas + README. Without this note, generic writes look like free-form `state` edits
 * and clients park tasks by writing Waiting (refused) instead of stage_id + ordinary open state.
 */
const TASK_WAITING_DEFERRAL_NOTE =
  " project.task Waiting (`state=04_waiting_normal`) is derived from open Blocked By (`depend_on_ids`) — never write it. " +
  "To block: set `depend_on_ids` and let Odoo compute Waiting. " +
  "To voluntarily defer / park: set `stage_id` to the board's On Hold (or equivalent park column) and keep an ordinary " +
  "open `state` (omit Waiting; leave the prior open state or another open non-Waiting value). " +
  "Optional supporting signals: assignees, activities, dates.";

/**
 * Chatter is the versioned, chronological journal; text fields are not versioned and a write
 * replaces their previous content outright. Agents keep reaching for `description` / terms /
 * internal-notes fields to record follow-ups, which silently destroys the prior value and fakes
 * an audit trail — this note is the only place the tool surface says otherwise.
 */
const CHATTER_VS_FIELDS_NOTE =
  " Chatter vs fields: the chatter is the record's chronological, auditable journal. Follow-up notes, " +
  "explanations, decisions, justifications, analysis results and action history MUST go through " +
  "post_message / batch_post_message. Text fields (Description, Terms & Conditions, Internal Notes, …) " +
  "are NOT versioned and a write REPLACES their current content — only write them when the value is " +
  "durable, structuring business data describing the record's current state. Never use a text field as " +
  "a substitute journal. Before replacing existing text, confirm you are updating the business data " +
  "itself, not appending context; when in doubt, post to the chatter.";

const CHATTER_JOURNAL_NOTE =
  " This is the correct destination for follow-up notes, decisions, justifications, analysis results and " +
  "action history: chatter entries are append-only and timestamped, unlike text fields such as " +
  "Description / Terms & Conditions / Internal Notes, which a write overwrites without history.";

function gateWrite(model: string, method: string, args: Record<string, unknown>) {
  if (!isMutatingOdooMethod(method)) return null;
  const verdict = assessWriteOperation({ model, method, args });
  // Irreversible confirmation is handled by the confirmation path (not a flat write_blocked).
  if (!verdict.allowed && verdict.policy_rule !== "irreversible_confirmation_required") {
    return mcpWriteBlockedError(
      { model, method },
      {
        ...verdict,
        refusing_layer: "connector_policy",
        next_step: verdict.next_step ?? "Adjust the request and retry."
      }
    );
  }
  return null;
}

/**
 * Stateful `project.task.state` guard — refuses In Progress while Odoo would recompute Waiting.
 * Only touches Odoo when the payload actually sets `state`, so ordinary PM writes stay single-call.
 */
async function guardProjectTaskState(opts: {
  model: string;
  method: string;
  args: Record<string, unknown>;
  ids?: number[];
  queue: OdooQueue;
  getProps: () => Props | undefined;
}) {
  if (opts.model !== "project.task") return null;
  const preflight = await preflightProjectTaskStateWrite({
    method: opts.method,
    ids: opts.ids,
    args: opts.args,
    queue: opts.queue,
    getProps: opts.getProps
  });
  return preflight.ok ? null : preflight.response;
}

/**
 * THE gate for every mutating write tool: connector policy first, then the irreversible
 * confirmation path, then the stateful project.task guard. Returns a response to send back, or null
 * when the call may execute.
 *
 * Every write tool must route through this. `gateWrite` alone is not sufficient — it deliberately
 * lets `irreversible_confirmation_required` pass so the two-phase path can own it, which means any
 * tool calling only `gateWrite` executes irreversible operations unconfirmed. Keeping both steps in
 * one function is what stops that gap from reopening per-tool.
 */
async function guardMutation(opts: {
  model: string;
  method: string;
  /** Odoo JSON-2 body, used for policy classification (vals/vals_list/ids). */
  args: Record<string, unknown>;
  ids?: number[];
  /** Payload signed into the confirmation token alongside model/method/ids. */
  kwargs?: Record<string, unknown>;
  confirmation_token?: string;
  getSecret: () => string | undefined;
  queue: OdooQueue;
  getProps: () => Props | undefined;
}) {
  const blocked = gateWrite(opts.model, opts.method, opts.args);
  if (blocked) return blocked;
  const confirm = await handleIrreversibleConfirmation({
    model: opts.model,
    method: opts.method,
    ids: opts.ids,
    kwargs: opts.kwargs,
    args: opts.args,
    confirmation_token: opts.confirmation_token,
    getSecret: opts.getSecret
  });
  if (confirm) return confirm;
  return guardProjectTaskState({
    model: opts.model,
    method: opts.method,
    args: opts.args,
    ids: opts.ids,
    queue: opts.queue,
    getProps: opts.getProps
  });
}

/**
 * Duplicate preflight for the graduated inventory master-data models (`product.category`,
 * `stock.location`). Creating a second "Consumables" under the same parent is the failure mode these
 * models actually have: Odoo happily accepts it, and the duplicate is only noticed later, from the
 * wrong place. Runs on CREATE only — a write targets a record that already exists.
 *
 * Costs one `search_read` per create, so it is scoped to the two models and a tight name+parent
 * domain. Returns a response to send back (duplicate found, or the read itself failed), else null.
 */
async function preflightDuplicateMasterData(opts: {
  model: string;
  /** Odoo JSON-2 body (`vals_list` for create; `vals` tolerated). */
  args: Record<string, unknown>;
  queue: OdooQueue;
  getProps: () => Props | undefined;
}): Promise<ReturnType<typeof mcpWriteBlockedError> | ReturnType<typeof mcpErrorFromException> | null> {
  const model = opts.model.trim();
  const parentField = inventoryMasterDataParentField(model);
  if (!parentField) return null;

  for (const record of collectPmValueRecords(opts.args)) {
    const rawName = record.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    // No name → nothing to compare. Odoo's own required-field validation refuses it, via the
    // structured exception envelope; guessing a domain here would only add a second failure mode.
    if (!name) continue;

    const parentId = normalizeParentValue(record[parentField]);
    // Unrecognized many2one shape: checking the wrong parent's siblings is worse than not checking.
    if (parentId === undefined) continue;

    let rows: unknown;
    try {
      rows = await opts.queue.enqueue(requireConnection(opts.getProps()), model, "search_read", {
        domain: buildDuplicateDomain(name, parentField, parentId),
        fields: ["id", "name", parentField],
        limit: DUPLICATE_PREFLIGHT_LIMIT
      });
    } catch (err) {
      // Fail closed: an unverified create is exactly the silent duplicate this preflight exists to
      // prevent. The envelope names the layer that refused the lookup (ACL, schema, …).
      return mcpErrorFromException(err, { model, method: "search_read" });
    }

    const existing = (Array.isArray(rows) ? rows : []).filter(
      (row): row is Record<string, unknown> => !!row && typeof row === "object"
    );
    const ids = existing.map((row) => row.id).filter((id): id is number => typeof id === "number");
    if (ids.length === 0) continue;

    const parentDescription = parentId === false ? "no parent (root)" : `${parentField} ${parentId}`;
    return mcpWriteBlockedError(
      { model, method: "create" },
      {
        intent: "financial_mutation",
        reason:
          `${model} already has a record named "${name}" under ${parentDescription} ` +
          `(id ${ids.join(", ")}); creating another would duplicate it.`,
        policy_rule: "duplicate_master_data",
        risk_class: "reversible_configuration",
        refusing_layer: "connector_policy",
        blocked_fields: ["name", parentField],
        record_ids: ids,
        next_step:
          `Use the existing record (id ${ids[0]}) — update it with update_record if it needs changes — ` +
          `or create under a different ${parentField}, or with a distinct name.`,
        recoverable: true
      }
    );
  }

  return null;
}

/** Shared schema fragment so every mutating tool advertises the token identically. */
const zConfirmationToken = z
  .string()
  .optional()
  .describe(
    "Top-level MCP argument (not under kwargs/values). Omit for preflight of irreversible ops " +
      "(posting, paying, reconciling, deleting, lock-boundary writes). On confirmation_required, retry the " +
      "identical model/method/ids/kwargs (or values) plus this field. Do not put the token inside kwargs or values."
  );

/**
 * Lift `kwargs.confirmation_token` into the top-level confirmation path and strip it so it never
 * reaches Odoo JSON-2 or the HMAC plan. Prefer the published top-level arg; kwargs is accepted as
 * a compatibility lift for schema-driven clients that stuffed the token under kwargs.
 */
export function resolveConfirmationFromKwargs(opts: {
  model: string;
  method: string;
  ids?: number[];
  confirmation_token?: string;
  kwargs: Record<string, unknown>;
}):
  | { ok: true; confirmation_token?: string; kwargs: Record<string, unknown> }
  | { ok: false; error: ReturnType<typeof mcpWriteBlockedError> } {
  const kwargs = { ...opts.kwargs };
  const hadKwargsKey = Object.prototype.hasOwnProperty.call(kwargs, "confirmation_token");
  const rawFromKwargs = kwargs.confirmation_token;
  if (hadKwargsKey) delete kwargs.confirmation_token;

  const kwargsToken =
    typeof rawFromKwargs === "string" && rawFromKwargs.trim() ? rawFromKwargs.trim() : undefined;
  const topLevel =
    typeof opts.confirmation_token === "string" && opts.confirmation_token.trim()
      ? opts.confirmation_token.trim()
      : undefined;

  if (topLevel && kwargsToken && topLevel !== kwargsToken) {
    return {
      ok: false,
      error: mcpWriteBlockedError(
        { model: opts.model, method: opts.method },
        {
          intent: "financial_mutation",
          reason:
            "confirmation_token was supplied both as a top-level argument and inside kwargs with different values. " +
            "Use only the top-level confirmation_token MCP argument.",
          policy_rule: "irreversible_confirmation_invalid",
          risk_class: "irreversible_posting",
          refusing_layer: "connector_policy",
          next_step:
            "Pass confirmation_token only as a top-level tool argument (omit it from kwargs), matching the preflight token.",
          recoverable: true,
          record_ids: opts.ids
        }
      )
    };
  }

  return {
    ok: true,
    confirmation_token: topLevel ?? kwargsToken,
    kwargs
  };
}

/** Canonical plan signed into the irreversible confirmation token. */
export function buildIrreversibleWritePlan(input: {
  model: string;
  method: string;
  ids?: number[];
  kwargs?: Record<string, unknown>;
}): WritePlan {
  const values: Record<string, unknown> = {
    ...(input.kwargs ?? {}),
    ...(input.ids ? { ids: [...input.ids].sort((a, b) => a - b) } : {})
  };
  return {
    operation: "irreversible_execute",
    model: input.model.trim(),
    method: input.method.trim(),
    values,
    company_id: 0,
    evidence: [],
    warnings: []
  };
}

function extractIds(ids: unknown): number[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out = ids.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0);
  return out.length ? [...new Set(out)] : undefined;
}

/**
 * Two-phase gate for irreversible ledger ops.
 * - No token → preflight response with confirmation_token (no mutate).
 * - Token present → verify HMAC over the canonical plan, then allow execute.
 */
async function handleIrreversibleConfirmation(opts: {
  model: string;
  method: string;
  ids?: number[];
  kwargs?: Record<string, unknown>;
  confirmation_token?: string;
  /** Odoo body, so field-level lock-boundary escalation can see vals/vals_list. */
  args?: Record<string, unknown>;
  /**
   * Escalate an operation the pure classifier considers reversible. Used when live record state is
   * what makes it irreversible (see `confirm_from_states`), which classification cannot know.
   */
  forceConfirmation?: { risk_class: RiskClass; reason: string };
  getSecret: () => string | undefined;
}): Promise<ReturnType<typeof mcpConfirmationRequired> | ReturnType<typeof mcpWriteBlockedError> | null> {
  const classified = classifyOperation(opts.model, opts.method, opts.args);
  const classification: OperationClassification = opts.forceConfirmation
    ? {
        ...classified,
        bucket: "irreversible_ledger",
        risk_class: opts.forceConfirmation.risk_class,
        requires_confirmation: true,
        policy_rule: "irreversible_confirmation_required",
        reason: opts.forceConfirmation.reason
      }
    : classified;
  if (!classification.requires_confirmation) return null;

  const plan = buildIrreversibleWritePlan({
    model: opts.model,
    method: opts.method,
    ids: opts.ids,
    kwargs: opts.kwargs
  });
  const would_execute = {
    model: opts.model,
    method: opts.method,
    ...(opts.ids ? { ids: opts.ids } : {}),
    ...(opts.kwargs && Object.keys(opts.kwargs).length ? { kwargs: opts.kwargs } : {})
  };

  if (!opts.confirmation_token || !opts.confirmation_token.trim()) {
    const secret = opts.getSecret();
    let confirmation_token: string | undefined;
    if (secret) {
      confirmation_token = await issueConfirmationToken(plan, secret, Date.now());
    }
    return mcpConfirmationRequired({
      model: opts.model,
      method: opts.method,
      details:
        classification.reason ??
        `Irreversible operation ${opts.model}.${opts.method} requires confirmation before execute.`,
      risk_class: classification.risk_class,
      next_step:
        confirmation_token != null
          ? "Retry the same call with top-level confirmation_token (not under kwargs) to execute, then verify the result in Odoo."
          : "CONFIRMATION_SECRET is not configured; irreversible execute is unavailable. Configure the secret or use the Odoo UI.",
      confirmation_token,
      record_ids: opts.ids,
      would_execute
    });
  }

  const secret = opts.getSecret();
  if (!secret) {
    return mcpWriteBlockedError(
      { model: opts.model, method: opts.method },
      {
        intent: "financial_mutation",
        reason: "CONFIRMATION_SECRET is not configured; cannot verify confirmation_token.",
        policy_rule: "irreversible_confirmation_invalid",
        risk_class: classification.risk_class,
        refusing_layer: "connector_policy",
        next_step: "Configure CONFIRMATION_SECRET on the worker, or perform this action in the Odoo UI.",
        recoverable: true,
        record_ids: opts.ids
      }
    );
  }

  const verdict = await verifyConfirmationToken(opts.confirmation_token.trim(), plan, secret, Date.now());
  if (verdict !== "valid") {
    return mcpWriteBlockedError(
      { model: opts.model, method: opts.method },
      {
        intent: "financial_mutation",
        reason:
          verdict === "expired"
            ? "confirmation_token expired — re-run without a token to obtain a fresh preflight token."
            : "confirmation_token mismatch — token must be issued for this exact model/method/ids/kwargs.",
        policy_rule: "irreversible_confirmation_invalid",
        risk_class: classification.risk_class,
        refusing_layer: "connector_policy",
        next_step:
          "Call again without confirmation_token to get a new preflight token, then retry with that token as a top-level argument (not under kwargs).",
        recoverable: true,
        record_ids: opts.ids
      }
    );
  }

  return null;
}

/** Post-write verification: re-read state when ids are known. Never fails the write. */
async function verifyAfterWrite(opts: {
  model: string;
  ids: number[];
  queue: OdooQueue;
  getProps: () => Props | undefined;
}): Promise<Record<string, unknown> | undefined> {
  if (opts.ids.length === 0) return undefined;
  try {
    const rows = await opts.queue.enqueue(requireConnection(opts.getProps()), opts.model, "read", {
      ids: opts.ids,
      fields: ["id", "state", "active"]
    });
    if (!Array.isArray(rows)) return undefined;
    return { records: rows };
  } catch {
    return undefined;
  }
}

export function registerWriteTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue,
  getSecret: () => string | undefined = () => undefined
) {
  server.registerTool(
    "create_record",
    {
      title: "Create Record",
      description:
        "Write: create a single Odoo record of the given model. When the model is project.task, the response carries a " +
        "trace_token (src-…) that is also stamped into the task's chatter — you MUST surface that token verbatim in your " +
        "visible reply to the user so the conversation can be found again from the Odoo task." +
        RECORD_LINK_WRITE_NOTE +
        PM_WRITE_ROUTING_NOTE +
        TASK_WAITING_DEFERRAL_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        model: z.string().min(1),
        values: z.record(z.string(), z.any()),
        context: zWriteContext,
        confirmation_token: zConfirmationToken
      },
      outputSchema: {
        id: z.number().int().describe("Database id of the created record"),
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the created record — surface it as [record name](web_url)"),
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
    async ({ model, values, context, confirmation_token }) => {
      logWriteContext("create_record", model, context);
      const blocked = await guardMutation({
        model,
        method: "create",
        args: { vals_list: [values] },
        kwargs: { vals_list: [values] },
        confirmation_token,
        getSecret,
        queue,
        getProps
      });
      if (blocked) return blocked;

      const duplicate = await preflightDuplicateMasterData({
        model,
        args: { vals_list: [values] },
        queue,
        getProps
      });
      if (duplicate) return duplicate;

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

      // `values` is the only context we have for route selection (move_type, project_id, …);
      // fields it omits just fall back to the model-level route, never to a wrong one.
      const webUrl = buildRecordUrl(conn.url, model, id, values);

      // Only project.task creations get a trusted provenance stamp; every other model is byte-for-byte unchanged.
      if (model !== "project.task") {
        return mcpStructured(
          { id, ...(webUrl ? { web_url: webUrl } : {}) },
          webUrl ? `${JSON.stringify(id)}\n\nOdoo record: ${webUrl}` : JSON.stringify(id)
        );
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
          `this conversation can be found later from the Odoo task.` +
          (webUrl ? ` Link the task as [task name](${webUrl}).` : "") +
          `\n\n` +
          JSON.stringify(id);
        return mcpStructured({ id, ...(webUrl ? { web_url: webUrl } : {}), trace_token: token }, text);
      } catch (err) {
        // A chatter-post failure must never fail the create: return the id and warn, never surface an MCP error.
        // No token is surfaced here — it was never stamped into the chatter, so echoing it would be a dead reference.
        const errMessage = err instanceof Error ? err.message : String(err);
        const provenance_warning = `created task ${id} but failed to post the provenance stamp (${errMessage})`;
        const text = `${JSON.stringify(id)}${webUrl ? `\n\nOdoo record: ${webUrl}` : ""}\n\nWarning: ${provenance_warning}.`;
        return mcpStructured({ id, ...(webUrl ? { web_url: webUrl } : {}), provenance_warning }, text);
      }
    }
  );

  server.registerTool(
    "post_message",
    {
      title: "Post Chatter Message",
      description:
        "Write: post a message (chatter log/comment) to a single Odoo record." +
        PM_WRITE_ROUTING_NOTE +
        CHATTER_JOURNAL_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        body: z.string(),
        subtype: z.string().optional(),
        body_is_html: z.boolean().default(false),
        context: zWriteContext
      },
      outputSchema: {
        result: z.unknown().describe("Raw message_post return value (shape varies by Odoo version; typically the created mail.message id)")
      }
    },
    async ({ model, record_id, body, subtype, body_is_html, context }) => {
      logWriteContext("post_message", model, context);
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
        return mcpErrorFromException(err, { model, method: "message_post", record_ids: [record_id] });
      }
    }
  );

  server.registerTool(
    "update_record",
    {
      title: "Update Record",
      description:
        "Write: update fields on a single Odoo record by id. x2many fields need Odoo command tuples (e.g. [[6,0,ids]], [[4,id]], [[3,id]])." +
        RECORD_LINK_WRITE_NOTE +
        PM_WRITE_ROUTING_NOTE +
        TASK_WAITING_DEFERRAL_NOTE +
        CHATTER_VS_FIELDS_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string().min(1),
        record_id: z.number().int().positive(),
        values: z.record(z.string(), z.any()),
        context: zWriteContext,
        confirmation_token: zConfirmationToken
      },
      outputSchema: {
        ok: z.boolean().describe("True when the write succeeded"),
        web_url: z
          .string()
          .optional()
          .describe("Canonical clickable Odoo URL of the updated record — surface it as [record name](web_url)")
      }
    },
    async ({ model, record_id, values, context, confirmation_token }) => {
      logWriteContext("update_record", model, context);
      const blocked = await guardMutation({
        model,
        method: "write",
        args: { ids: [record_id], vals: values },
        ids: [record_id],
        kwargs: { vals: values },
        confirmation_token,
        getSecret,
        queue,
        getProps
      });
      if (blocked) return blocked;
      try {
        const conn = requireConnection(getProps());
        await queue.enqueue(conn, model, "write", {
          ids: [record_id],
          vals: values
        });
        // `values` only carries the fields being written, so route variants it does not
        // mention (an untouched move_type, say) degrade to the model-level route.
        const webUrl = buildRecordUrl(conn.url, model, record_id, values);
        return mcpStructured(
          { ok: true, ...(webUrl ? { web_url: webUrl } : {}) },
          webUrl ? `${JSON.stringify(true)}\n\nOdoo record: ${webUrl}` : JSON.stringify(true, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "write", record_ids: [record_id] });
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
        "Fail-fast: a mid-loop error aborts remaining updates; already-applied writes are NOT rolled back." +
        RECORD_LINK_WRITE_NOTE +
        PM_WRITE_ROUTING_NOTE +
        TASK_WAITING_DEFERRAL_NOTE +
        CHATTER_VS_FIELDS_NOTE,
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
          .min(1),
        context: zWriteContext,
        confirmation_token: zConfirmationToken
      },
      outputSchema: {
        results: z
          .array(
            z.object({
              record_id: z.number().int(),
              ok: z.boolean(),
              web_url: z
                .string()
                .optional()
                .describe("Canonical clickable Odoo URL of the updated record — surface it as [record name](web_url)")
            })
          )
          .describe("One entry per applied update, in input order (fail-fast: absent entries were not attempted)")
      }
    },
    async ({ model, updates, context, confirmation_token }) => {
      logWriteContext("batch_update", model, context);
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");

      // Validate EVERY update before applying ANY of them. Gating inside the write loop would let a
      // refusal on update N land updates 1..N-1 first — a partial write caused by our own policy,
      // which is exactly what the fail-fast contract must not do.
      for (const u of updates) {
        const blocked = await guardMutation({
          model,
          method: "write",
          args: { ids: [u.record_id], vals: u.values },
          ids: [u.record_id],
          kwargs: { vals: u.values },
          confirmation_token,
          getSecret,
          queue,
          getProps
        });
        if (blocked) return blocked;
      }

      try {
        const conn = requireConnection(getProps());
        const results: { record_id: number; ok: boolean; web_url?: string }[] = [];
        for (const u of updates) {
          await queue.enqueue(conn, model, "write", { ids: [u.record_id], vals: u.values });
          // Same caveat as update_record: only the written `values` inform the route variant.
          const webUrl = buildRecordUrl(conn.url, model, u.record_id, u.values);
          results.push({ record_id: u.record_id, ok: true, ...(webUrl ? { web_url: webUrl } : {}) });
        }
        return mcpStructured({ results }, JSON.stringify(results, null, 2));
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "write", partial_write: true });
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
        PM_WRITE_ROUTING_NOTE +
        CHATTER_JOURNAL_NOTE,
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
          .min(1),
        context: zWriteContext
      },
      outputSchema: {
        results: z
          .array(z.object({ record_id: z.number().int(), result: z.unknown() }))
          .describe("One entry per posted message, in input order (fail-fast: absent entries were not attempted)")
      }
    },
    async ({ model, messages, context }) => {
      logWriteContext("batch_post_message", model, context);
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
        return mcpErrorFromException(err, { model, method: "message_post", partial_write: true });
      }
    }
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete Record",
      description:
        "Write: delete a single Odoo record by id. Destructive — irreversible deletes return confirmation_required + confirmation_token; " +
        "retry with the top-level confirmation_token argument (omit token for preflight)." +
        PM_WRITE_ROUTING_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string().min(1),
        record_id: z.number().int().positive(),
        context: zWriteContext,
        confirmation_token: zConfirmationToken
      },
      outputSchema: {
        ok: z.boolean().describe("True when the delete succeeded"),
        verification: z.unknown().optional().describe("Post-delete read evidence when available")
      }
    },
    async ({ model, record_id, context, confirmation_token }) => {
      logWriteContext("delete_record", model, context);
      // PM unlink (project.task) stays single-shot; irreversible unlink needs confirmation.
      const blocked = gateWrite(model, "unlink", { ids: [record_id] });
      if (blocked) return blocked;

      const confirm = await handleIrreversibleConfirmation({
        model,
        method: "unlink",
        ids: [record_id],
        confirmation_token,
        getSecret
      });
      if (confirm) return confirm;

      const wasIrreversible = classifyOperation(model, "unlink").requires_confirmation;
      try {
        await queue.enqueue(requireConnection(getProps()), model, "unlink", { ids: [record_id] });
        if (wasIrreversible) {
          const verification = await verifyAfterWrite({ model, ids: [record_id], queue, getProps });
          return mcpStructured({ ok: true, ...(verification ? { verification } : {}) }, JSON.stringify(true, null, 2));
        }
        return mcpStructured({ ok: true }, JSON.stringify(true, null, 2));
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "unlink", record_ids: [record_id] });
      }
    }
  );

  server.registerTool(
    "call_model_method",
    {
      title: "Call Model Method (advanced)",
      description:
        "Escape hatch: call an arbitrary Odoo model method. Odoo's JSON-2 API has NO positional args — every body key is bound as a named kwarg (record-bound methods take a top-level `ids`). Pass record ids via `ids` and all other parameters via `kwargs`. " +
        "Action-based risk policy (not model-prefix denial): reversible configuration/lifecycle methods execute under Odoo ACLs; " +
        "irreversible posting/payment/reconcile/delete/lock require confirmation_token (omit token for preflight). " +
        "Irreversible ops return confirmation_required + confirmation_token; retry with the top-level confirmation_token argument (not under kwargs)." +
        PM_WRITE_ROUTING_NOTE +
        TASK_WAITING_DEFERRAL_NOTE +
        CHATTER_VS_FIELDS_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        model: z.string(),
        method: z.string(),
        ids: z.array(z.number().int()).optional(),
        kwargs: z.record(z.string(), z.any()).default({}),
        // Deprecated: JSON-2 cannot bind positional args; kept so old callers fail loudly instead of silently.
        args: z.array(z.any()).default([]),
        context: zWriteContext,
        confirmation_token: zConfirmationToken
      },
      outputSchema: {
        result: z.unknown().describe("Raw return value of the invoked model method"),
        verification: z.unknown().optional().describe("Post-write state evidence for irreversible ops when available")
      }
    },
    async ({ model, method, ids, kwargs, args, context, confirmation_token }) => {
      if (!model || !model.trim()) return mcpError("model must be a non-empty string");
      if (!method || !method.trim()) return mcpError("method must be a non-empty string");
      const positionalArgs = args ?? [];
      if (positionalArgs.length > 0) {
        return mcpError(
          "Odoo JSON-2 has no positional args: every body key is bound as a named kwarg, so an 'args' key fails with 422 unless the method literally has an 'args' parameter. Move these values into 'kwargs' (and record ids into 'ids')."
        );
      }
      const recordIds = extractIds(ids);
      const resolved = resolveConfirmationFromKwargs({
        model,
        method,
        ids: recordIds,
        confirmation_token,
        kwargs: kwargs ?? {}
      });
      if (!resolved.ok) {
        logWriteContext("call_model_method", model, context);
        return resolved.error;
      }
      const namedKwargs = resolved.kwargs;
      const effectiveToken = resolved.confirmation_token;
      try {
        const body = { ...namedKwargs, ...(ids !== undefined ? { ids } : {}) };

        // Pure classifier — flat denials only (PM field gates, etc.). Irreversible → confirmation path.
        const blocked = gateWrite(model, method, body);
        if (blocked) {
          logWriteContext("call_model_method", model, context);
          return blocked;
        }

        if (isMutatingOdooMethod(method)) {
          const confirm = await handleIrreversibleConfirmation({
            model,
            method,
            ids: recordIds,
            kwargs: namedKwargs,
            confirmation_token: effectiveToken,
            getSecret
          });
          if (confirm) {
            logWriteContext("call_model_method", model, context);
            return confirm;
          }
        }

        // Stateful preflight for curated reversible lifecycle (context + ids + state + guards).
        if (isMutatingOdooMethod(method) && isReversibleLifecycleMethod(model, method)) {
          const preflight = await preflightLifecycleCall({ model, method, ids, context, queue, getProps });
          if (!preflight.ok) {
            logWriteContext("call_model_method", model, context);
            return preflight.response;
          }

          // The pure classifier cannot see record state, so an allowlisted method that is only
          // irreversible FROM certain states (un-posting a posted move) is escalated here, once the
          // live read has told us which ids are actually in such a state.
          if (preflight.confirmation_required_ids.length > 0) {
            const stateConfirm = await handleIrreversibleConfirmation({
              model,
              method,
              ids: preflight.confirmation_required_ids,
              kwargs: namedKwargs,
              forceConfirmation: {
                risk_class: "irreversible_posting",
                reason:
                  `${model}.${method} on record(s) ${preflight.confirmation_required_ids.join(", ")} would leave state ` +
                  `"${preflight.states.get(preflight.confirmation_required_ids[0]) ?? "unknown"}" — this un-posts an existing ` +
                  `journal entry and requires confirmation.`
              },
              confirmation_token: effectiveToken,
              getSecret
            });
            if (stateConfirm) {
              logWriteContext("call_model_method", model, context);
              return stateConfirm;
            }
          }
        }

        // Stateful project.task guard: Waiting is computed, so In Progress needs no open blockers.
        if (isMutatingOdooMethod(method)) {
          const stateBlocked = await guardProjectTaskState({
            model,
            method,
            args: body,
            ids: recordIds,
            queue,
            getProps
          });
          if (stateBlocked) {
            logWriteContext("call_model_method", model, context);
            return stateBlocked;
          }
        }

        // Same duplicate preflight as create_record — the escape hatch must not be the way around it.
        if (method.trim() === "create") {
          const duplicate = await preflightDuplicateMasterData({ model, args: body, queue, getProps });
          if (duplicate) {
            logWriteContext("call_model_method", model, context);
            return duplicate;
          }
        }

        logWriteContext("call_model_method", model, context);
        const result = await queue.enqueue(requireConnection(getProps()), model, method, body);

        let verification: Record<string, unknown> | undefined;
        if (classifyOperation(model, method).requires_confirmation && recordIds?.length) {
          verification = await verifyAfterWrite({ model, ids: recordIds, queue, getProps });
        }

        return mcpStructured(
          { result, ...(verification ? { verification } : {}) },
          JSON.stringify(result, null, 2)
        );
      } catch (err) {
        return mcpErrorFromException(err, { model, method, record_ids: extractIds(ids) });
      }
    }
  );
}
