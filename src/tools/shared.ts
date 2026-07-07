import { z } from "zod";
import { OdooError, type OdooConnection } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import type { TtlCache } from "../cache";

export const DEFAULT_TASK_FIELDS = ["id", "name", "stage_id", "project_id"];
export const DEFAULT_GENERIC_FIELDS = ["id", "display_name"];

/** How the resolved field list was determined. */
export type FieldSource = "explicit" | "preset" | "fallback";

/** Named field presets for browse_records and related tooling. */
export type NamedFieldPreset = "minimal" | "tracking_minimal" | "financial_minimal";

export const NAMED_FIELD_PRESETS: readonly NamedFieldPreset[] = [
  "minimal",
  "tracking_minimal",
  "financial_minimal"
];

/** Outcome of the pure {@link resolveNamedPreset} resolver. */
export interface NamedFieldResolution {
  fields: string[];
  source: FieldSource;
  model: string;
  preset?: NamedFieldPreset;
}

/** Offset/limit paging metadata for browse_records responses. */
export interface BrowsePageMetadata {
  offset: number;
  limit: number;
  count: number;
  returned: number;
  has_more: boolean;
}

/** Chat-safe payload size threshold for browse_records capping. */
export const BROWSE_PAYLOAD_BYTE_LIMIT = 64_000;

export const BROWSE_MIN_PAGE_LIMIT = 1;
export const BROWSE_DEFAULT_PAGE_LIMIT = 50;

/** Richest → slimmest preset order used when downgrading oversized browse payloads. */
export const NAMED_PRESET_DOWNGRADE_ORDER: readonly NamedFieldPreset[] = [
  "financial_minimal",
  "tracking_minimal",
  "minimal"
];

/** Per-record JSON envelope overhead used by {@link estimateBrowsePayloadBytes}. */
export const RECORD_OVERHEAD_BYTES = 20;

/** Outcome of {@link capBrowsePage} limit/preset adjustments. */
export interface CapBrowsePageResult {
  limit: number;
  preset: NamedFieldPreset;
  adjusted: boolean;
  adjustments: string[];
}

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

export type AggregationPreflightErrorCode = "invalid_groupby" | "unsupported_aggregate";

export const AGGREGATE_FALLBACK_MAX_RECORDS = 100;

export type AggregationDiagnosis =
  | "unsupported_model"
  | "invalid_groupby"
  | "permission_denied"
  | "unsupported_aggregate"
  | "connector_bug";

/** Thrown by aggregateRecords for pre-check and fallback refusal paths (not transient Odoo errors). */
export class AggregationError extends Error {
  diagnosis: AggregationDiagnosis;

  constructor(diagnosis: AggregationDiagnosis, message: string) {
    super(message);
    this.name = "AggregationError";
    this.diagnosis = diagnosis;
  }
}

export interface ErrorEnvelope {
  error: string;
  model: string | null;
  method: string | null;
  http_status: number | null;
  details: string;
  recoverable: boolean;
  diagnosis?: AggregationDiagnosis;
  message?: string;
}

export interface ErrorContext {
  model?: string;
  method?: string;
}

function buildErrorEnvelope(err: unknown, context: ErrorContext): ErrorEnvelope {
  if (err instanceof AggregationError) {
    return {
      error: err.diagnosis,
      diagnosis: err.diagnosis,
      message: err.message,
      model: context.model ?? null,
      method: context.method ?? null,
      http_status: null,
      details: err.message,
      recoverable: false
    };
  }
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

/** Machine-classifiable aggregation error envelope (isError:true). */
export function mcpAggregationError(diagnosis: AggregationDiagnosis, message: string, context: ErrorContext = {}) {
  const envelope = buildErrorEnvelope(new AggregationError(diagnosis, message), context);
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
}

/** Machine-classifiable JSON error envelope for MCP tool results (isError:true). */
export function mcpErrorFromException(err: unknown, context: ErrorContext = {}) {
  const envelope = buildErrorEnvelope(err, context);
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true as const };
}

/** Pre-flight aggregation validation failure — returned before any read_group Odoo call. */
export function mcpAggregationPreflightError(
  code: AggregationPreflightErrorCode,
  details: string,
  context: { model: string; field?: string }
) {
  const envelope: ErrorEnvelope = {
    error: code,
    model: context.model,
    method: "read_group",
    http_status: null,
    details,
    recoverable: false
  };
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
 * Per-model named field presets. `minimal` references {@link MODEL_FIELD_PRESETS} for lockstep
 * curation; richer presets add tracking/financial subsets. Returned arrays alias these constants —
 * callers must not mutate them.
 */
export const MODEL_NAMED_FIELD_PRESETS: Record<
  string,
  Partial<Record<NamedFieldPreset, readonly string[]>>
> = {
  "project.task": {
    minimal: MODEL_FIELD_PRESETS["project.task"],
    tracking_minimal: [
      "id",
      "name",
      "stage_id",
      "project_id",
      "user_ids",
      "priority",
      "state",
      "date_deadline"
    ],
    financial_minimal: ["id", "name", "stage_id", "project_id"]
  },
  "project.project": {
    minimal: MODEL_FIELD_PRESETS["project.project"],
    tracking_minimal: ["id", "name", "partner_id", "user_id", "stage_id", "active", "date_start"],
    financial_minimal: MODEL_FIELD_PRESETS["project.project"]
  },
  "res.partner": {
    minimal: MODEL_FIELD_PRESETS["res.partner"],
    tracking_minimal: ["id", "name", "email", "phone", "country_id", "category_id"],
    financial_minimal: [
      "id",
      "name",
      "email",
      "phone",
      "vat",
      "property_account_receivable_id"
    ]
  },
  "res.users": {
    minimal: MODEL_FIELD_PRESETS["res.users"],
    tracking_minimal: ["id", "name", "login", "email", "active", "partner_id"],
    financial_minimal: MODEL_FIELD_PRESETS["res.users"]
  }
};

/** Cross-model named presets used when a model has no curated entry for the requested preset. */
export const GENERIC_NAMED_FIELD_PRESETS: Record<NamedFieldPreset, readonly string[]> = {
  minimal: DEFAULT_GENERIC_FIELDS,
  tracking_minimal: ["id", "display_name", "state", "write_date"],
  financial_minimal: ["id", "display_name", "amount_total", "currency_id", "state"]
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

/**
 * Pure, model-aware named-preset resolver. No Odoo round-trip on any path.
 * - explicit non-empty requestedFields -> honored verbatim (order preserved), source "explicit"
 * - preset provided (or omitted -> "minimal") -> model curated preset when available, else generic
 * - empty requestedFields array falls through to preset lookup (not explicit)
 * - ALL_FIELDS_SENTINEL is returned verbatim as explicit
 * Returned arrays alias shared module constants — callers must not mutate them.
 */
export function resolveNamedPreset(
  model: string,
  preset?: NamedFieldPreset | null,
  requestedFields?: string[] | null
): NamedFieldResolution {
  if (requestedFields != null && requestedFields.length > 0) {
    return { fields: requestedFields, source: "explicit", model };
  }

  const effectivePreset: NamedFieldPreset = preset ?? "minimal";
  const modelPreset = MODEL_NAMED_FIELD_PRESETS[model]?.[effectivePreset];
  if (modelPreset) {
    return { fields: modelPreset as string[], source: "preset", model, preset: effectivePreset };
  }
  return {
    fields: GENERIC_NAMED_FIELD_PRESETS[effectivePreset] as string[],
    source: "fallback",
    model,
    preset: effectivePreset
  };
}

/**
 * Build offset/limit paging metadata for browse_records.
 * `count` is the total matching rows (from search_count); `returned` is rows.length for this page.
 */
export function buildBrowsePageMetadata(input: {
  offset: number;
  limit: number;
  count: number;
  returned: number;
}): BrowsePageMetadata {
  const { offset, limit, count, returned } = input;
  return {
    offset,
    limit,
    count,
    returned,
    has_more: offset + returned < count
  };
}

function roughWidth(value: unknown): number {
  if (value === null || value === undefined || typeof value === "boolean") return 4;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) {
      total += roughWidth(item) + 1;
    }
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      total += key.length + roughWidth(entry) + 3;
    }
    return total;
  }
  return String(value).length;
}

const BROWSE_ENVELOPE_OVERHEAD_BYTES = 64;
const FIELD_NAME_OVERHEAD_BYTES = 4;

/** Heuristic payload size estimate for browse_records capping (no full JSON.stringify in hot path). */
export function estimateBrowsePayloadBytes(records: unknown[], fields: string[]): number {
  let total = BROWSE_ENVELOPE_OVERHEAD_BYTES;
  for (const record of records) {
    total += RECORD_OVERHEAD_BYTES;
    if (record && typeof record === "object") {
      const row = record as Record<string, unknown>;
      for (const field of fields) {
        total += field.length + FIELD_NAME_OVERHEAD_BYTES + roughWidth(row[field]);
      }
    } else {
      for (const field of fields) {
        total += field.length + FIELD_NAME_OVERHEAD_BYTES + 4;
      }
    }
  }
  return total;
}

/** True when {@link estimateBrowsePayloadBytes} exceeds {@link BROWSE_PAYLOAD_BYTE_LIMIT}. */
export function isBrowsePayloadOversized(records: unknown[], fields: string[]): boolean {
  return estimateBrowsePayloadBytes(records, fields) > BROWSE_PAYLOAD_BYTE_LIMIT;
}

function nextSlimmerPreset(preset: NamedFieldPreset): NamedFieldPreset | null {
  const idx = NAMED_PRESET_DOWNGRADE_ORDER.indexOf(preset);
  if (idx < 0 || idx >= NAMED_PRESET_DOWNGRADE_ORDER.length - 1) return null;
  return NAMED_PRESET_DOWNGRADE_ORDER[idx + 1] ?? null;
}

/**
 * Shrink page limit and/or downgrade named preset when the estimated payload exceeds
 * {@link BROWSE_PAYLOAD_BYTE_LIMIT}. Explicit fields only shrink limit — preset is never downgraded.
 */
export function capBrowsePage(input: {
  model: string;
  preset: NamedFieldPreset;
  limit: number;
  records: unknown[];
  explicitFields?: string[] | null;
}): CapBrowsePageResult {
  const { model, records, explicitFields } = input;
  let limit = input.limit;
  let preset = input.preset;
  const adjustments: string[] = [];
  const initialLimit = limit;
  const initialPreset = preset;

  const estimateFor = (pageLimit: number, activePreset: NamedFieldPreset, fields: string[]) =>
    estimateBrowsePayloadBytes(records.slice(0, pageLimit), fields);

  if (explicitFields?.length) {
    while (
      estimateFor(limit, preset, explicitFields) > BROWSE_PAYLOAD_BYTE_LIMIT &&
      limit > BROWSE_MIN_PAGE_LIMIT
    ) {
      const nextLimit = Math.max(BROWSE_MIN_PAGE_LIMIT, Math.floor(limit / 2));
      adjustments.push(`limit:${limit}→${nextLimit}`);
      limit = nextLimit;
    }
  } else {
    let fields = resolveNamedPreset(model, preset).fields;
    while (estimateFor(limit, preset, fields) > BROWSE_PAYLOAD_BYTE_LIMIT) {
      if (limit > BROWSE_MIN_PAGE_LIMIT) {
        const nextLimit = Math.max(BROWSE_MIN_PAGE_LIMIT, Math.floor(limit / 2));
        adjustments.push(`limit:${limit}→${nextLimit}`);
        limit = nextLimit;
        fields = resolveNamedPreset(model, preset).fields;
        continue;
      }

      const slimmer = nextSlimmerPreset(preset);
      if (!slimmer) break;
      adjustments.push(`preset:${preset}→${slimmer}`);
      preset = slimmer;
      fields = resolveNamedPreset(model, preset).fields;
    }
  }

  return {
    limit,
    preset,
    adjusted: limit !== initialLimit || preset !== initialPreset,
    adjustments
  };
}
