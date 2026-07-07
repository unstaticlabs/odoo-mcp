import { z } from "zod";
import { OdooError, type OdooConnection } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import type { TtlCache } from "../cache";

export const DEFAULT_TASK_FIELDS = ["id", "name", "stage_id", "project_id"];
export const DEFAULT_GENERIC_FIELDS = ["id", "display_name"];

/** How the resolved field list was determined. */
export type FieldSource = "explicit" | "preset" | "fallback";

/** Outcome of the pure {@link resolveFields} resolver; consumed by the field-reporting layer. */
export interface FieldResolution {
  fields: string[];
  source: FieldSource;
  model: string;
}

/** Resolution metadata nested alongside the field list returned by {@link resolveFieldPreset}. */
export interface FieldPresetResolution {
  source: FieldSource;
  model: string;
}

export interface OdooFieldMeta {
  type: string;
  store?: boolean;
  selection?: [string, string][];
}

const TECHNICAL_FIELD_NAMES = new Set(["create_uid", "create_date", "write_uid", "write_date", "__last_update"]);
const EXPENSIVE_FIELD_TYPES = new Set(["binary", "one2many", "many2many"]);
const PRIORITY_FIELD_NAMES = ["id", "name", "display_name", "state", "active"];
export const SMART_FIELD_LIMIT = 15;
export const ALL_FIELDS_SENTINEL = "__all__";

export type OmissionReason = "absent-from-rows" | "unknown-field";

export interface FieldOmission {
  field: string;
  reason: OmissionReason;
}

export interface FieldsReport {
  returned_fields: string[];
  omitted_fields: FieldOmission[];
}

/** Exported for unit testing (see callOdoo export pattern). */
export function computeFieldsReport(
  resolved: { fields: string[]; explicit: boolean },
  rows: Record<string, unknown>[],
  warnings: string[],
  model: string,
  opts?: { knownFields?: Set<string> }
): FieldsReport {
  if (resolved.fields.includes(ALL_FIELDS_SENTINEL)) {
    return { returned_fields: [], omitted_fields: [] };
  }

  const isRowEmpty = rows.length === 0;
  const returnedKeys = new Set<string>();
  if (!isRowEmpty) {
    for (const row of rows) {
      if (row && typeof row === "object") {
        for (const key of Object.keys(row)) {
          returnedKeys.add(key);
        }
      }
    }
  }

  const returned_fields: string[] = [];
  const omitted_fields: FieldOmission[] = [];

  for (const field of resolved.fields) {
    if (!isRowEmpty && returnedKeys.has(field)) {
      returned_fields.push(field);
    } else {
      let reason: OmissionReason = "absent-from-rows";
      if (opts?.knownFields && !opts.knownFields.has(field)) {
        reason = "unknown-field";
      }
      omitted_fields.push({ field, reason });
      if (resolved.explicit) {
        warnings.push(`${model}: requested field '${field}' was omitted (${reason})`);
      }
    }
  }

  return { returned_fields, omitted_fields };
}

/** Exported for unit testing (see callOdoo export pattern). */
export function pickSmartFields(fieldsMeta: Record<string, OdooFieldMeta>): string[] {
  const candidateNames = Object.entries(fieldsMeta)
    .filter(([name, meta]) => {
      if (name.startsWith("__") || TECHNICAL_FIELD_NAMES.has(name)) return false;
      if (EXPENSIVE_FIELD_TYPES.has(meta.type)) return false;
      if (meta.store === false) return false;
      return true;
    })
    .map(([name]) => name);

  const priority = PRIORITY_FIELD_NAMES.filter((name) => candidateNames.includes(name));
  const rest = candidateNames.filter((name) => !priority.includes(name));
  return [...priority, ...rest].slice(0, SMART_FIELD_LIMIT);
}
export const CORE_MODEL_ALLOWLIST = ["project.task", "project.project", "res.partner", "res.users"];

export function requireConnection(props: Props | undefined): OdooConnection {
  if (!props) throw new Error("Missing Odoo connection props");
  return { url: props.odooBaseUrl, db: props.odooDb, apiKey: props.odooApiKey };
}

export function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Success result carrying both renderings of the same payload: `structuredContent` (validated
 * against the tool's outputSchema by the SDK) and a text `content` block. Pass `text` to keep a
 * legacy text shape (e.g. a bare JSON array) that differs from the structured envelope —
 * existing text-only consumers keep their format, schema-aware clients get the typed object.
 *
 * NOTE: once a tool declares an outputSchema, the SDK rejects any non-error result WITHOUT
 * structuredContent — every success path of such a tool must go through this helper (or set
 * structuredContent itself). Error results (`isError: true`) are exempt.
 */
export function mcpStructured<T extends Record<string, unknown>>(output: T, text?: string) {
  return {
    content: [{ type: "text" as const, text: text ?? JSON.stringify(output, null, 2) }],
    structuredContent: output
  };
}

/** A normalized Odoo record: field names to arbitrary JSON values (fields are caller-chosen). */
export const zOdooRecord = z.record(z.string(), z.unknown());

/** Loose list of Odoo records — row internals are dynamic, so only the envelope is typed. */
export const zOdooRecords = z.array(zOdooRecord);

/** `{ model, records }` provenance wrapper used across bookkeeping scopes (see withModel). */
export const zRecordContainer = z.object({ model: z.string(), records: z.array(z.unknown()) });

export const zWarnings = z.array(z.string()).describe("Non-fatal issues encountered while assembling the result");

export interface ErrorEnvelope {
  error: string;
  model: string | null;
  method: string | null;
  http_status: number | null;
  details: string;
  recoverable: boolean;
}

export interface ErrorContext {
  model?: string;
  method?: string;
}

function buildErrorEnvelope(err: unknown, context: ErrorContext): ErrorEnvelope {
  if (err instanceof OdooError) {
    return {
      error: err.code,
      model: err.model,
      method: err.method,
      http_status: err.httpStatus,
      details: err.details,
      recoverable: err.recoverable
    };
  }
  return {
    error: "unknown",
    model: context.model ?? null,
    method: context.method ?? null,
    http_status: null,
    details: err instanceof Error ? err.message : String(err),
    recoverable: false
  };
}

/** Machine-classifiable JSON error envelope for MCP tool results (isError:true). */
export function mcpErrorFromException(err: unknown, context: ErrorContext = {}) {
  const envelope = buildErrorEnvelope(err, context);
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
}

/** Same JSON envelope, but shaped for the MCP resource-read contract (`contents`, no `isError`). */
export function resourceErrorFromException(uri: URL, err: unknown, context: ErrorContext = {}) {
  const envelope = buildErrorEnvelope(err, context);
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(envelope) }] };
}

/** Exported for unit testing (see callOdoo export pattern). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render caller-supplied PLAIN TEXT as Odoo-safe HTML: escape HTML
 * metacharacters (so `<p>` shows literally, not as markup) and turn newlines
 * into `<br>`.
 *
 * This must be paired with `body_is_html: true` on the `message_post` call.
 * Odoo's `message_post` runs a plaintext body through its own escaping
 * (plaintext2html); if we escape here AND let Odoo escape again, the result is
 * double-escaped mojibake (`<p>` → `&amp;lt;p&amp;gt;`, rendered as the literal
 * text `&lt;p&gt;`). By escaping once and declaring the body is already HTML,
 * Odoo leaves it untouched and it renders correctly.
 */
export function plaintextToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");
}

export async function searchRecords(
  queue: OdooQueue,
  conn: OdooConnection,
  model: string,
  domain: unknown[],
  fields: string[] | null,
  limit: number,
  order?: string,
  offset?: number,
  cache?: TtlCache,
  warnings: string[] = []
): Promise<{
  rows: unknown;
  fieldsMeta: Record<string, OdooFieldMeta> | null;
  fieldsReport: FieldsReport;
}> {
  const cappedLimit = Math.min(limit, 100);
  const resolution = resolveFields(model, fields);

  let odooFields: string[];
  if (fields !== null && fields.length === 1 && fields[0] === ALL_FIELDS_SENTINEL) {
    odooFields = []; // empty fields array => Odoo search_read returns all fields natively
  } else {
    odooFields = resolution.fields;
  }

  const rows = (await queue.enqueue(conn, model, "search_read", {
    domain,
    fields: odooFields,
    limit: cappedLimit,
    offset: offset ?? 0,
    ...(order ? { order } : {})
  })) as Record<string, unknown>[];

  let knownFields: Set<string> | undefined;
  if (cache) {
    const key = `fields:${conn.db}:${model}`;
    const cachedMeta = cache.get<Record<string, unknown>>(key);
    if (cachedMeta) {
      knownFields = new Set(Object.keys(cachedMeta));
    }
  }

  const resolved = {
    fields: resolution.fields,
    explicit: resolution.source === "explicit"
  };

  const fieldsReport = computeFieldsReport(resolved, rows, warnings, model, { knownFields });

  return { rows, fieldsMeta: null, fieldsReport };
}

export async function countRecords(queue: OdooQueue, conn: OdooConnection, model: string, domain: unknown[]): Promise<number> {
  if (!model || !model.trim()) throw new Error("model must be a non-empty string");
  return (await queue.enqueue(conn, model, "search_count", { domain })) as number;
}

/** Parses a JSON-array domain from a resource URI's `domain` query param; defaults to []. */
export function parseDomainParam(uri: URL): unknown[] {
  const raw = uri.searchParams.get("domain");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("domain query param must be valid JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("domain query param must be a JSON array");
  return parsed;
}

/**
 * Static, model-aware field presets. Every {@link CORE_MODEL_ALLOWLIST} model has a curated,
 * read-safe entry; adding a model is a one-line map edit (no code-path change). `project.task`
 * reuses {@link DEFAULT_TASK_FIELDS} so the two stay in lockstep.
 */
export const MODEL_FIELD_PRESETS: Record<string, string[]> = {
  "project.task": DEFAULT_TASK_FIELDS, // id, name, stage_id, project_id
  "project.project": ["id", "name", "partner_id", "user_id", "stage_id"],
  "res.partner": ["id", "name", "email", "phone"],
  "res.users": ["id", "name", "login", "email"]
};

/**
 * Pure, model-aware field resolver. No Odoo round-trip on any path.
 * - explicit non-empty requestedFields -> honored verbatim (order preserved), source "explicit"
 * - no fields + known model            -> curated preset, source "preset"
 * - no fields + unknown model          -> DEFAULT_GENERIC_FIELDS, source "fallback"
 *
 * An empty `requestedFields` array counts as "no explicit fields" and falls through to
 * preset/fallback. `ALL_FIELDS_SENTINEL` ("__all__") is NOT interpreted here — {@link searchRecords}
 * maps it to an empty Odoo fields list; this resolver returns it verbatim as an explicit field.
 * Returned arrays alias the shared module constants — callers must not mutate them.
 */
export function resolveFields(model: string, requestedFields?: string[] | null): FieldResolution {
  if (requestedFields != null && requestedFields.length > 0) {
    return { fields: requestedFields, source: "explicit", model };
  }
  const preset = MODEL_FIELD_PRESETS[model];
  if (preset) {
    return { fields: preset, source: "preset", model };
  }
  return { fields: DEFAULT_GENERIC_FIELDS, source: "fallback", model };
}

/**
 * Pure, synchronous field-preset resolver that pairs the resolved fields with nested resolution
 * metadata (`{ fields, resolution: { source, model } }`). Thin shape-adapter over {@link resolveFields}
 * so the two stay in lockstep — NO Odoo round-trip on any path. An empty `requestedFields` array
 * falls through to the preset/fallback, and `ALL_FIELDS_SENTINEL` is returned verbatim as explicit.
 */
export function resolveFieldPreset(
  model: string,
  requestedFields?: string[]
): { fields: string[]; resolution: FieldPresetResolution } {
  const { fields, source } = resolveFields(model, requestedFields);
  return { fields, resolution: { source, model } };
}
