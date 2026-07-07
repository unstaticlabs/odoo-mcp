import type { CachedFieldMeta } from "./cache";
import { getFieldsCached, type TtlCache } from "./cache";
import { normalizeRecords } from "./normalizer";
import { OdooError } from "./odoo";
import type { OdooConnection } from "./odoo";
import type { OdooQueue } from "./odoo-queue";
import {
  AGGREGATE_FALLBACK_MAX_RECORDS,
  AggregationError,
  countRecords
} from "./tools/shared";

export type DateInterval = "day" | "week" | "month" | "quarter" | "year";

export interface ParsedGroupby {
  field: string;
  interval?: DateInterval;
}

export interface ParsedAggregateCount {
  kind: "count";
  native_only?: false;
}

export interface ParsedAggregateSum {
  kind: "sum";
  field: string;
  native_only?: false;
}

export interface ParsedAggregateNativeOnly {
  kind: "native_only";
  token: string;
  native_only: true;
}

export type ParsedAggregate = ParsedAggregateCount | ParsedAggregateSum | ParsedAggregateNativeOnly;

export interface AggregateRecordsInput {
  model: string;
  domain: unknown[];
  groupby: string[];
  aggregates: string[];
  lazy: boolean;
  orderby?: string;
  limit?: number;
  offset?: number;
}

export interface AggregateMetadata {
  fallback: boolean;
  records_scanned: number;
  total_matching?: number;
  has_more: boolean;
  groupby: string[];
  aggregates: string[];
}

export interface AggregateResult {
  groups: Record<string, unknown>[];
  metadata: AggregateMetadata;
  warnings: string[];
}

const DATE_INTERVALS = new Set<DateInterval>(["day", "week", "month", "quarter", "year"]);

const GROUPABLE_FIELD_TYPES = new Set([
  "many2one",
  "selection",
  "char",
  "boolean",
  "integer",
  "date",
  "datetime"
]);

const NON_GROUPABLE_FIELD_TYPES = new Set(["binary", "html", "text", "one2many", "many2many", "reference"]);

const NUMERIC_FIELD_TYPES = new Set(["integer", "float", "monetary"]);

/** Split `field:interval` groupby tokens (Odoo read_group syntax). */
export function parseGroupbyToken(token: string): ParsedGroupby | { error: string } {
  const colon = token.indexOf(":");
  const field = (colon === -1 ? token : token.slice(0, colon)).trim();
  if (!field) return { error: `empty groupby field in "${token}"` };

  if (colon === -1) return { field };

  const interval = token.slice(colon + 1).trim() as DateInterval;
  if (!DATE_INTERVALS.has(interval)) {
    return { error: `unknown date interval "${token.slice(colon + 1)}" in groupby token "${token}"` };
  }
  return { field, interval };
}

/** Parse aggregate tokens; only `__count` and `field:sum` are supported in connector fallback. */
export function parseAggregateToken(token: string): ParsedAggregate {
  if (token === "__count") return { kind: "count" };

  const colon = token.lastIndexOf(":");
  if (colon === -1) return { kind: "native_only", token, native_only: true };

  const field = token.slice(0, colon).trim();
  const op = token.slice(colon + 1).trim();

  if (!field) return { kind: "native_only", token, native_only: true };
  if (op === "sum") return { kind: "sum", field };
  return { kind: "native_only", token, native_only: true };
}

export type ValidationResult =
  | { ok: true; parsedGroupby: ParsedGroupby[]; parsedAggregates: ParsedAggregate[] }
  | { ok: false; diagnosis: "unsupported_model" | "invalid_groupby" | "unsupported_aggregate"; message: string };

/** fields_get-backed pre-check before any read_group or fallback I/O. */
export function validateAggregationRequest(
  fieldsMeta: Record<string, CachedFieldMeta>,
  groupby: string[],
  aggregates: string[]
): ValidationResult {
  if (!fieldsMeta || Object.keys(fieldsMeta).length === 0) {
    return { ok: false, diagnosis: "unsupported_model", message: "Model has no field metadata (unknown or inaccessible model)" };
  }

  const parsedGroupby: ParsedGroupby[] = [];
  for (const token of groupby) {
    const parsed = parseGroupbyToken(token);
    if ("error" in parsed) {
      return { ok: false, diagnosis: "invalid_groupby", message: parsed.error };
    }
    const meta = fieldsMeta[parsed.field];
    if (!meta) {
      return { ok: false, diagnosis: "invalid_groupby", message: `Unknown groupby field "${parsed.field}"` };
    }
    if (NON_GROUPABLE_FIELD_TYPES.has(meta.type)) {
      return {
        ok: false,
        diagnosis: "invalid_groupby",
        message: `Field "${parsed.field}" (type ${meta.type}) cannot be used for grouping`
      };
    }
    if (!GROUPABLE_FIELD_TYPES.has(meta.type)) {
      return {
        ok: false,
        diagnosis: "invalid_groupby",
        message: `Field "${parsed.field}" (type ${meta.type}) is not groupable`
      };
    }
    if (parsed.interval && meta.type !== "date" && meta.type !== "datetime") {
      return {
        ok: false,
        diagnosis: "invalid_groupby",
        message: `Date interval "${parsed.interval}" is only valid on date/datetime fields, not "${parsed.field}"`
      };
    }
    parsedGroupby.push(parsed);
  }

  const parsedAggregates: ParsedAggregate[] = [];
  for (const token of aggregates) {
    const parsed = parseAggregateToken(token);
    if (parsed.kind === "sum") {
      const sumMeta = fieldsMeta[parsed.field];
      if (!sumMeta) {
        return { ok: false, diagnosis: "invalid_groupby", message: `Unknown aggregate field "${parsed.field}"` };
      }
      if (!NUMERIC_FIELD_TYPES.has(sumMeta.type)) {
        return {
          ok: false,
          diagnosis: "unsupported_aggregate",
          message: `Field "${parsed.field}" (type ${sumMeta.type}) cannot be summed`
        };
      }
    }
    parsedAggregates.push(parsed);
  }

  return { ok: true, parsedGroupby, parsedAggregates };
}

function isMany2OneTuple(value: unknown): value is [number, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number";
}

/** Parse Odoo `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` strings to a UTC Date. */
function parseOdooDateValue(raw: string): Date {
  if (raw.includes("T")) {
    const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
    return new Date(iso);
  }
  if (raw.includes(" ")) {
    return new Date(`${raw.replace(" ", "T")}Z`);
  }
  return new Date(`${raw}T00:00:00Z`);
}

/** Truncate a date/datetime value to a bucket key (UTC). */
export function bucketDateValue(value: unknown, interval: DateInterval): string {
  if (value == null || value === false) return "false";

  const raw = typeof value === "string" ? value : String(value);
  const date = parseOdooDateValue(raw);
  if (Number.isNaN(date.getTime())) return String(value);

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  switch (interval) {
    case "year":
      return String(year);
    case "quarter":
      return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
    case "month":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "day":
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    case "week": {
      const tmp = new Date(Date.UTC(year, month - 1, day));
      const dayNum = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
      const weekYear = tmp.getUTCFullYear();
      const yearStart = new Date(Date.UTC(weekYear, 0, 1));
      const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${weekYear}-W${String(week).padStart(2, "0")}`;
    }
  }
}

function groupKeyForRow(
  row: Record<string, unknown>,
  parsed: ParsedGroupby,
  fieldsMeta: Record<string, CachedFieldMeta>
): string {
  const meta = fieldsMeta[parsed.field];
  const value = row[parsed.field];

  if (parsed.interval) {
    return `${parsed.field}:${bucketDateValue(value, parsed.interval)}`;
  }

  if (meta?.type === "many2one") {
    if (value === false || value == null) return `${parsed.field}:false`;
    if (isMany2OneTuple(value)) return `${parsed.field}:${value[0]}`;
    if (typeof value === "object" && value !== null && "id" in value) {
      return `${parsed.field}:${(value as { id: number }).id}`;
    }
    return `${parsed.field}:${String(value)}`;
  }

  if (value === false || value == null) return `${parsed.field}:false`;
  return `${parsed.field}:${String(value)}`;
}

function outputGroupValue(
  row: Record<string, unknown>,
  parsed: ParsedGroupby,
  fieldsMeta: Record<string, CachedFieldMeta>
): unknown {
  const meta = fieldsMeta[parsed.field];
  const value = row[parsed.field];

  if (parsed.interval) {
    return bucketDateValue(value, parsed.interval);
  }

  if (meta?.type === "many2one") {
    if (value === false || value == null) return false;
    if (isMany2OneTuple(value)) return value;
    if (typeof value === "object" && value !== null && "id" in value) {
      const obj = value as { id: number; name?: string };
      return [obj.id, obj.name ?? ""];
    }
    return value;
  }

  return value === false ? false : value;
}

interface GroupAccumulator {
  groupValue: unknown;
  count: number;
  sums: Record<string, number>;
}

/** Single-level in-memory grouping for connector fallback (exported for unit tests). */
export function groupRecordsInMemory(
  rows: Record<string, unknown>[],
  fieldsMeta: Record<string, CachedFieldMeta>,
  groupby: ParsedGroupby[],
  aggregates: ParsedAggregate[]
): Record<string, unknown>[] {
  const primaryGroupby = groupby[0];
  if (!primaryGroupby) return [];

  const groups = new Map<string, GroupAccumulator>();

  for (const row of rows) {
    const key = groupKeyForRow(row, primaryGroupby, fieldsMeta);
    let acc = groups.get(key);
    if (!acc) {
      acc = { groupValue: outputGroupValue(row, primaryGroupby, fieldsMeta), count: 0, sums: {} };
      groups.set(key, acc);
    }
    acc.count++;

    for (const agg of aggregates) {
      if (agg.kind === "sum") {
        const num = Number(row[agg.field] ?? 0);
        acc.sums[agg.field] = (acc.sums[agg.field] ?? 0) + (Number.isFinite(num) ? num : 0);
      }
    }
  }

  const outputKey = primaryGroupby.interval
    ? `${primaryGroupby.field}:${primaryGroupby.interval}`
    : primaryGroupby.field;

  const result: Record<string, unknown>[] = [];
  for (const acc of groups.values()) {
    const groupRow: Record<string, unknown> = { [outputKey]: acc.groupValue };

    for (const agg of aggregates) {
      if (agg.kind === "count") {
        groupRow[`${primaryGroupby.field}_count`] = acc.count;
      } else if (agg.kind === "sum") {
        groupRow[`${agg.field}_sum`] = acc.sums[agg.field] ?? 0;
      }
    }

    result.push(groupRow);
  }

  return result;
}

export async function tryNativeReadGroup(
  queue: OdooQueue,
  conn: OdooConnection,
  params: AggregateRecordsInput
): Promise<Record<string, unknown>[]> {
  const rows = (await queue.enqueue(conn, params.model, "read_group", {
    domain: params.domain,
    fields: params.aggregates,
    groupby: params.groupby,
    lazy: params.lazy,
    ...(params.orderby ? { orderby: params.orderby } : {})
  })) as Record<string, unknown>[];
  return rows;
}

function hasNativeOnlyAggregates(aggregates: ParsedAggregate[]): boolean {
  return aggregates.some((a) => a.kind === "native_only");
}

function collectSearchReadFields(
  parsedGroupby: ParsedGroupby[],
  parsedAggregates: ParsedAggregate[]
): string[] {
  const fields = new Set<string>(["id"]);
  for (const g of parsedGroupby) fields.add(g.field);
  for (const a of parsedAggregates) {
    if (a.kind === "sum") fields.add(a.field);
  }
  return [...fields];
}

export async function fallbackAggregate(
  queue: OdooQueue,
  conn: OdooConnection,
  fieldsMeta: Record<string, CachedFieldMeta>,
  params: AggregateRecordsInput,
  parsedGroupby: ParsedGroupby[],
  parsedAggregates: ParsedAggregate[]
): Promise<AggregateResult> {
  const warnings: string[] = [
    "Native read_group is unavailable for this model; used connector-side fallback aggregation."
  ];

  const limit = Math.min(params.limit ?? AGGREGATE_FALLBACK_MAX_RECORDS, AGGREGATE_FALLBACK_MAX_RECORDS);
  const offset = params.offset ?? 0;

  const total = await countRecords(queue, conn, params.model, params.domain);

  const metadataBase: AggregateMetadata = {
    fallback: true,
    records_scanned: 0,
    total_matching: total,
    has_more: false,
    groupby: params.groupby,
    aggregates: params.aggregates
  };

  if (total === 0) {
    return { groups: [], metadata: { ...metadataBase, records_scanned: 0, has_more: false }, warnings };
  }

  if (offset >= total) {
    warnings.push(`offset ${offset} is beyond total matching records (${total}); returning empty groups.`);
    return { groups: [], metadata: { ...metadataBase, records_scanned: 0, has_more: false }, warnings };
  }

  const searchFields = collectSearchReadFields(parsedGroupby, parsedAggregates);
  const rows = (await queue.enqueue(conn, params.model, "search_read", {
    domain: params.domain,
    fields: searchFields,
    limit,
    offset
  })) as Record<string, unknown>[];

  const recordsScanned = rows.length;
  const hasMore = total > offset + recordsScanned;

  if (hasMore) {
    warnings.push(
      `Fallback aggregation scanned ${recordsScanned} of ${total} matching records; paginate with offset/limit for full coverage.`
    );
  }

  const rawGroups = groupRecordsInMemory(rows, fieldsMeta, parsedGroupby.slice(0, 1), parsedAggregates);
  const groups = normalizeRecords(rawGroups, fieldsMeta);

  return {
    groups,
    metadata: {
      ...metadataBase,
      records_scanned: recordsScanned,
      has_more: hasMore
    },
    warnings
  };
}

function mapPermissionError(err: OdooError): never {
  throw new AggregationError("permission_denied", `Permission denied for ${err.model}.${err.method}: ${err.details}`);
}

/** Main orchestrator: native read_group with bounded fallback on model_or_method_not_found. */
export async function aggregateRecords(
  queue: OdooQueue,
  cache: TtlCache,
  conn: OdooConnection,
  input: AggregateRecordsInput
): Promise<AggregateResult> {
  let fieldsMeta: Record<string, CachedFieldMeta>;
  try {
    fieldsMeta = await getFieldsCached(cache, queue, conn, input.model);
  } catch (err) {
    if (!(err instanceof OdooError)) {
      throw new AggregationError("connector_bug", err instanceof Error ? err.message : String(err));
    }

    if (err.code === "unauthorized" || err.code === "permission_denied") mapPermissionError(err);
    if (err.code === "model_or_method_not_found" || err.httpStatus === 404) {
      throw new AggregationError("unsupported_model", `Model "${input.model}" is not available or not accessible`);
    }
    throw err;
  }

  const validation = validateAggregationRequest(fieldsMeta, input.groupby, input.aggregates);
  if (!validation.ok) {
    throw new AggregationError(validation.diagnosis, validation.message);
  }

  const { parsedGroupby, parsedAggregates } = validation;

  try {
    const rawGroups = await tryNativeReadGroup(queue, conn, input);
    const groups = normalizeRecords(rawGroups, fieldsMeta);
    return {
      groups,
      metadata: {
        fallback: false,
        records_scanned: 0,
        has_more: false,
        groupby: input.groupby,
        aggregates: input.aggregates
      },
      warnings: []
    };
  } catch (err) {
    if (!(err instanceof OdooError)) {
      throw new AggregationError("connector_bug", err instanceof Error ? err.message : String(err));
    }

    if (err.code === "unauthorized" || err.code === "permission_denied") mapPermissionError(err);
    if (err.code !== "model_or_method_not_found") throw err;

    if (hasNativeOnlyAggregates(parsedAggregates)) {
      throw new AggregationError(
        "unsupported_aggregate",
        "Fallback aggregation only supports __count and field:sum; use native read_group for other operators."
      );
    }

    if (input.groupby.length > 1) {
      throw new AggregationError(
        "unsupported_aggregate",
        "Connector fallback supports single-level groupby only; use one groupby field or native read_group."
      );
    }

    try {
      return await fallbackAggregate(queue, conn, fieldsMeta, input, parsedGroupby, parsedAggregates);
    } catch (fallbackErr) {
      if (fallbackErr instanceof AggregationError) throw fallbackErr;
      if (fallbackErr instanceof OdooError) {
        if (fallbackErr.code === "unauthorized" || fallbackErr.code === "permission_denied") mapPermissionError(fallbackErr);
        if (fallbackErr.code === "model_or_method_not_found") {
          throw new AggregationError("unsupported_model", `Model "${input.model}" does not support search_read`);
        }
        throw fallbackErr;
      }
      throw new AggregationError("connector_bug", fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
    }
  }
}
