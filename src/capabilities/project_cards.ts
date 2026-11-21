import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import {
  attributedContext,
  detectedMarkdown,
  htmlBodyContract,
  OdooContextSchema,
  PositiveIdSchema,
  richTextHtml
} from "../odoo/schemas.js";
import { CapabilityInputError } from "../runtime/envelope.js";
import type { RequestContext } from "../runtime/context.js";
import {
  ACTIVITY_COMPLETION_FIELDS,
  PROJECT_STAGE_FIELDS,
  PROJECT_TASK_CARD_FIELDS
} from "./curated_fields.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const RecordSchema = z.record(z.string(), z.unknown());
const TASK_STATES = ["01_in_progress", "02_changes_requested", "03_approved", "04_waiting_normal", "1_done", "1_canceled"] as const;
const SOURCES_LABEL = "sources";
const SourceReferenceSchema = z.string().trim().min(1).max(300).regex(/^\S+$/, "A Sources reference has no spaces");

const actionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

export interface PropertySummary {
  name: string;
  label: string;
  type: string;
  value: unknown;
}

/** Label, type and value of each task property; definitions carry UI noise the card does not need. */
export function propertySummaries(raw: unknown): PropertySummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string") return [];
    return [{
      name: item.name,
      label: typeof item.string === "string" ? item.string : item.name,
      type: typeof item.type === "string" ? item.type : "unknown",
      value: item.value ?? null
    }];
  });
}

/** References of the "Sources" property: space-separated, one space at each end. */
export function parseSources(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

export function formatSources(references: readonly string[]): string {
  return references.length ? ` ${references.join(" ")} ` : "";
}

export function sourcesReferences(properties: readonly PropertySummary[]): string[] {
  const sources = properties.find((property) => property.label.trim().toLowerCase() === SOURCES_LABEL);
  return sources ? parseSources(sources.value) : [];
}

/**
 * Apply add/remove to the Sources property inside the full existing properties
 * list. Odoo replaces the whole property set on write, so every other property
 * goes back exactly as read; only the Sources value changes.
 */
export function mergeSources(
  raw: unknown,
  add: readonly string[],
  remove: readonly string[]
): { properties: Record<string, unknown>[]; sources: string[] } {
  const list = Array.isArray(raw) ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
  const matches = list.filter((item) => typeof item.string === "string" && item.string.trim().toLowerCase() === SOURCES_LABEL);
  if (matches.length !== 1) {
    const labels = list.map((item) => item.string).filter((label) => typeof label === "string");
    throw new CapabilityInputError(
      "sources_property_unavailable",
      matches.length === 0
        ? `This task's project has no property labelled "Sources" (labels: ${labels.join(", ") || "none"}), so nothing was written.`
        : `This task's project has ${matches.length} properties labelled "Sources", so nothing was written.`,
      "Define one Sources property on the project, or omit sources_add and sources_remove."
    );
  }
  const target = matches[0]!;
  if (!["char", "text"].includes(String(target.type))) {
    throw new CapabilityInputError(
      "sources_property_type",
      `The Sources property is ${String(target.type)}, not text, so nothing was written.`,
      "Use odoo_update_records for a differently typed property."
    );
  }
  const removed = new Set(remove);
  const sources = parseSources(target.value).filter((reference) => !removed.has(reference));
  for (const reference of add) if (!sources.includes(reference)) sources.push(reference);
  return {
    properties: list.map((item) => item === target ? { ...item, value: formatSources(sources) } : item),
    sources
  };
}

function rpcContext(requested: Record<string, unknown>, context: RequestContext) {
  return attributedContext(requested, context.correlationId);
}

function recordRef(context: RequestContext, model: string, id: number, name?: string) {
  return {
    model,
    id,
    display_name: name?.trim() || `${model},${id}`,
    url: `${context.principal.publicOrigin}/odoo/${model}/${id}`
  };
}

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function relationId(value: unknown): number | null {
  if (Array.isArray(value) && Number.isInteger(value[0])) return value[0] as number;
  if (value && typeof value === "object" && Number.isInteger((value as { id?: unknown }).id)) return (value as { id: number }).id;
  return typeof value === "number" ? value : null;
}

const CardOutputSchema = z.object({
  task: RecordSchema,
  changed: z.array(z.string()),
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "unknown"]),
  record: RecordSchema
}).strict();

const CompletionOutputSchema = z.object({
  result: z.unknown(),
  completed: z.array(RecordSchema),
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "unknown"])
}).strict();

export function registerProjectCardCapabilities(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "projects.task.update",
    name: "projects_update_task",
    title: "Update Project Card",
    description:
      "Update one project task card in one write. Stage (stage_id, or stage name within the task's project) requires state in the same call: Odoo resets state otherwise; the read-back confirms both. description replaces the durable brief and must be HTML with description_is_html: true (Markdown refused). link writes github_url (empty clears). sources_add/sources_remove edit the Sources property without losing other properties. Use odoo_add_internal_note for history, activities_schedule for owed work.",
    layer: "business_action",
    toolsets: ["projects"],
    profiles: ["projects"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["project", "task", "card", "stage", "state", "description", "brief", "link", "sources", "close"],
    requiredModules: ["project"],
    requiredModelAccess: [{ model: "project.task", operation: "write" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 565,
    input: z.object({
      task_id: PositiveIdSchema,
      stage_id: PositiveIdSchema.optional().describe("Or stage, not both."),
      stage: z.string().trim().min(1).max(200).optional().describe("Stage name in the task's project."),
      state: z.enum(TASK_STATES).optional().describe("Required with a stage."),
      description: z.string().min(1).max(100_000).optional().describe(htmlBodyContract("description_is_html")),
      description_is_html: z.literal(true).optional().describe("Must be true with description."),
      link: z.string().trim().max(2048).optional().describe("http(s) URL; empty clears."),
      sources_add: z.array(SourceReferenceSchema).max(50).optional().describe("e.g. github:org/repo#12"),
      sources_remove: z.array(SourceReferenceSchema).max(50).optional(),
      context: OdooContextSchema
    }).strict(),
    output: CardOutputSchema,
    async handler(input, context, signal) {
      if (input.stage_id !== undefined && input.stage !== undefined) {
        throw new CapabilityInputError("stage_ambiguous", "Both stage_id and stage were given, so nothing was written.", "Send one of them.");
      }
      const stageRequested = input.stage_id !== undefined || input.stage !== undefined;
      if (stageRequested && input.state === undefined) {
        throw new CapabilityInputError(
          "state_required_with_stage",
          "The stage changes but state was not given, so nothing was written. Odoo resets state to In progress when the stage is written alone.",
          "Resend with state set to the state the card should have in the new stage."
        );
      }
      if (input.description !== undefined && input.description_is_html !== true) {
        throw new CapabilityInputError(
          "description_html_required",
          "description must be declared HTML (description_is_html: true), so nothing was written.",
          "Send the durable brief as HTML with description_is_html: true."
        );
      }
      const sourcesChange = Boolean(input.sources_add?.length || input.sources_remove?.length);
      const link = input.link;
      if (link) {
        let parsed: URL | undefined;
        try { parsed = new URL(link); } catch { /* reported below */ }
        if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
          throw new CapabilityInputError("link_invalid", "link must be an http(s) URL, so nothing was written.", "Send an absolute http(s) URL, or an empty string to clear the link.");
        }
      }
      let description: { html: string; warnings: string[] } | undefined;
      if (input.description !== undefined) {
        const markdown = detectedMarkdown(input.description);
        if (markdown) {
          throw new CapabilityInputError(
            "description_markdown",
            `description contains Markdown (${markdown}), which Odoo does not render, so nothing was written.`,
            "Rewrite the brief as HTML (p, ul, li, strong, a) and resend with description_is_html: true."
          );
        }
        description = richTextHtml({ value: input.description, isHtml: true, field: "description", flagField: "description_is_html" });
      }
      const changes = [stageRequested, input.state !== undefined, description, link !== undefined, sourcesChange].some(Boolean);
      if (!changes) {
        throw new CapabilityInputError("nothing_to_update", "No field to update was given, so nothing was written.", "Send at least one of stage, state, description, link, sources_add or sources_remove.");
      }

      const common = rpcContext(input.context, context);
      const rows = await client.call<Record<string, unknown>[]>(context, "project.task", "read", {
        ids: [input.task_id], fields: [...PROJECT_TASK_CARD_FIELDS], context: common
      }, { signal });
      const task = rows[0];
      if (!task) throw new Error(`project.task,${input.task_id} was not found or is not readable`);

      const vals: Record<string, unknown> = {};
      if (stageRequested) {
        const projectId = relationId(task.project_id);
        if (!projectId) throw new CapabilityInputError("task_without_project", "The task has no project, so it has no stages and nothing was written.", "Set the project first.");
        const domain = input.stage_id !== undefined
          ? [["id", "=", input.stage_id], ["project_ids", "in", [projectId]]]
          : [["name", "=ilike", escapeIlike(input.stage!)], ["project_ids", "in", [projectId]]];
        const stages = await client.call<Record<string, unknown>[]>(context, "project.task.type", "search_read", {
          domain, fields: [...PROJECT_STAGE_FIELDS], limit: 5, order: "sequence asc, id asc", context: common
        }, { signal });
        if (stages.length !== 1) {
          throw new CapabilityInputError(
            stages.length ? "stage_ambiguous" : "stage_not_found",
            stages.length
              ? `${stages.length} stages of the task's project match, so nothing was written.`
              : "No stage of the task's project matches, so nothing was written.",
            "Read the project's stages with odoo_search_records on project.task.type (project_ids) and resend with stage_id."
          );
        }
        vals.stage_id = stages[0]!.id;
      }
      if (input.state !== undefined) vals.state = input.state;
      if (description) vals.description = description.html;
      if (link !== undefined) vals.github_url = link || false;
      if (sourcesChange) {
        vals.task_properties = mergeSources(task.task_properties, input.sources_add ?? [], input.sources_remove ?? []).properties;
      }

      const receipt = await client.call<unknown>(context, "project.task", "web_save", {
        ids: [input.task_id],
        vals,
        specification: {
          display_name: {},
          project_id: { fields: { display_name: {} } },
          stage_id: { fields: { display_name: {} } },
          state: {},
          github_url: {},
          task_properties: {}
        },
        context: common
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: "project.task",
          knownIds: [input.task_id],
          fields: Object.keys(vals),
          suggestedTool: "odoo_read_records",
          instructions: "Read the task's stage_id, state, github_url and task_properties and compare them with the original request. Resend only what is still different; stage and state must go together."
        }
      });
      return receipt.finalize((result) => {
        const card = Array.isArray(result) ? result[0] as Record<string, unknown> | undefined : undefined;
        if (!card) throw new Error("Odoo did not return the updated task");
        const warnings = [...(description?.warnings ?? [])];
        if (vals.stage_id !== undefined && relationId(card.stage_id) !== vals.stage_id) {
          warnings.push("The read-back stage differs from the requested stage; re-read the card before relying on it.");
        }
        if (vals.state !== undefined && card.state !== vals.state) {
          warnings.push(`The read-back state is ${String(card.state)}, not the requested ${String(vals.state)}; re-read the card before relying on it.`);
        }
        const properties = propertySummaries(card.task_properties);
        const { task_properties: _raw, ...rest } = card;
        return {
          data: {
            task: { ...rest, link: card.github_url || null, properties, sources: sourcesReferences(properties) },
            changed: Object.keys(vals),
            correlation_id: context.correlationId,
            outcome: "succeeded" as const,
            record: recordRef(context, "project.task", input.task_id, String(card.display_name ?? ""))
          },
          ...(warnings.length ? { warnings } : {})
        };
      }, () => ({ knownIds: [input.task_id] }));
    }
  }));

  registry.add(defineCapability({
    id: "activities.record.complete",
    name: "activities_complete",
    title: "Complete Activities",
    description:
      "Mark 1-50 activities done in one call (action_feedback), posting the plain-text feedback in Chatter. A done activity leaves the list; close only what is really done.",
    layer: "business_action",
    toolsets: ["activities", "projects"],
    profiles: ["projects"],
    effect: "write",
    annotations: actionAnnotations,
    keywords: ["activity", "done", "complete", "close", "feedback", "mark done"],
    requiredModules: ["mail"],
    requiredModelAccess: [{ model: "mail.activity", operation: "write" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 585,
    input: z.object({
      activity_ids: z.array(PositiveIdSchema).min(1).max(50),
      feedback: z.string().trim().min(1).max(5_000).describe("Plain text: what was done."),
      context: OdooContextSchema
    }).strict(),
    output: CompletionOutputSchema,
    async handler({ activity_ids, feedback, context: requestedContext }, context, signal) {
      const ids = [...new Set(activity_ids)];
      const common = rpcContext(requestedContext, context);
      const activities = await client.call<Record<string, unknown>[]>(context, "mail.activity", "read", {
        ids, fields: [...ACTIVITY_COMPLETION_FIELDS], context: common
      }, { signal });
      const found = new Set(activities.map((activity) => activity.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        throw new CapabilityInputError(
          "activity_not_found",
          `Activities ${missing.join(", ")} were not found or are not readable (a done activity no longer exists), so nothing was written.`,
          "List the record's activities with activities_list_for_record and resend only the open ones."
        );
      }
      const receipt = await client.call<unknown>(context, "mail.activity", "action_feedback", {
        ids, feedback, context: common
      }, {
        kind: "mutation",
        signal,
        reconciliation: {
          targetModel: "mail.activity",
          knownIds: ids,
          fields: ["res_model", "res_id"],
          suggestedTool: "activities_list_for_record",
          instructions: "List the activities of the records concerned. An activity that is gone was completed; do not send its feedback again."
        }
      });
      return receipt.finalize((result) => ({
        data: {
          result,
          completed: activities.map((activity) => ({
            activity_id: Number(activity.id),
            summary: typeof activity.summary === "string" ? activity.summary : null,
            record: typeof activity.res_model === "string" && Number.isInteger(activity.res_id)
              ? recordRef(context, activity.res_model, activity.res_id as number)
              : null
          })),
          correlation_id: context.correlationId,
          outcome: "succeeded" as const
        }
      }));
    }
  }));
}
