import type { CachedFieldMeta } from "./cache";

export const GROUPABLE_TYPES = ["many2one", "selection", "date", "datetime"] as const;
export const DATE_GRANULARITIES = ["day", "week", "month", "quarter", "year"] as const;
export const SUPPORTED_AGG_OPS = ["sum"] as const;
export const SUM_TYPES = ["integer", "float", "monetary"] as const;

const GROUPABLE_TYPE_SET = new Set<string>(GROUPABLE_TYPES);
const DATE_GRANULARITY_SET = new Set<string>(DATE_GRANULARITIES);
const SUPPORTED_AGG_OP_SET = new Set<string>(SUPPORTED_AGG_OPS);
const SUM_TYPE_SET = new Set<string>(SUM_TYPES);

export type AggregationValidationIssue = {
  code: "invalid_groupby" | "unsupported_aggregate";
  field?: string;
  details: string;
};

export type ParsedGroupby = { field: string; granularity?: string };
export type ParsedAggregate = { kind: "count" } | { kind: "aggregate"; field: string; op: string };

type ParseFailure = { ok: false; field?: string; details: string };
type ParseSuccess<T> = { ok: true; value: T };

/** Exported for unit testing (see pickExistingFields export pattern). */
export function parseGroupbyToken(token: string): ParseSuccess<ParsedGroupby> | ParseFailure {
  const colonIndex = token.indexOf(":");
  if (colonIndex === -1) {
    const field = token.trim();
    if (!field) {
      return { ok: false, details: "Groupby token must be a non-empty field name or field:granularity" };
    }
    return { ok: true, value: { field } };
  }

  const field = token.slice(0, colonIndex).trim();
  const granularity = token.slice(colonIndex + 1).trim();
  if (!field) {
    return { ok: false, details: "Groupby token must include a field name before ':'" };
  }
  if (!granularity || !DATE_GRANULARITY_SET.has(granularity)) {
    return {
      ok: false,
      field,
      details: `Invalid date granularity '${granularity || token.slice(colonIndex + 1)}'; supported: ${DATE_GRANULARITIES.join(", ")}`
    };
  }
  return { ok: true, value: { field, granularity } };
}

/** Exported for unit testing (see pickExistingFields export pattern). */
export function parseAggregateToken(token: string): ParseSuccess<ParsedAggregate> | ParseFailure {
  if (token === "__count") {
    return { ok: true, value: { kind: "count" } };
  }

  const colonIndex = token.indexOf(":");
  if (colonIndex === -1) {
    return {
      ok: false,
      details: "Aggregate token must be '__count' or field:op (e.g. amount_total:sum)"
    };
  }

  const field = token.slice(0, colonIndex).trim();
  const op = token.slice(colonIndex + 1).trim().toLowerCase();
  if (!field) {
    return { ok: false, details: "Aggregate token must include a field name before ':'" };
  }
  if (!op) {
    return { ok: false, field, details: "Aggregate token must include an operation after ':'" };
  }
  return { ok: true, value: { kind: "aggregate", field, op } };
}

/** Exported for unit testing (see pickExistingFields export pattern). */
export function validateGroupby(
  field: string,
  granularity: string | undefined,
  fieldsMeta: Record<string, CachedFieldMeta>
): AggregationValidationIssue | null {
  const meta = fieldsMeta[field];
  if (!meta) {
    return {
      code: "invalid_groupby",
      field,
      details: `Field '${field}' does not exist on this model`
    };
  }

  if (meta.store === false) {
    return {
      code: "invalid_groupby",
      field,
      details: `Field '${field}' is a computed non-stored field and cannot be used in groupby`
    };
  }

  if (!GROUPABLE_TYPE_SET.has(meta.type)) {
    return {
      code: "invalid_groupby",
      field,
      details:
        `Field '${field}' is type '${meta.type}' and cannot be used in groupby; ` +
        `supported types: ${GROUPABLE_TYPES.join(", ")}`
    };
  }

  if (granularity && meta.type !== "date" && meta.type !== "datetime") {
    return {
      code: "invalid_groupby",
      field,
      details: `Date granularity ':${granularity}' is only valid on date or datetime fields; '${field}' is type '${meta.type}'`
    };
  }

  return null;
}

/** Exported for unit testing (see pickExistingFields export pattern). */
export function validateAggregate(
  token: ParsedAggregate,
  fieldsMeta: Record<string, CachedFieldMeta>
): AggregationValidationIssue | null {
  if (token.kind === "count") {
    return null;
  }

  const { field, op } = token;
  const meta = fieldsMeta[field];
  if (!meta) {
    return {
      code: "unsupported_aggregate",
      field,
      details: `Field '${field}' does not exist on this model`
    };
  }

  if (!SUPPORTED_AGG_OP_SET.has(op)) {
    return {
      code: "unsupported_aggregate",
      field,
      details: `Aggregate operation '${op}' is not supported; supported operations: ${SUPPORTED_AGG_OPS.join(", ")}`
    };
  }

  if (!SUM_TYPE_SET.has(meta.type)) {
    return {
      code: "unsupported_aggregate",
      field,
      details:
        `Field '${field}' is type '${meta.type}' and cannot be aggregated with :sum; ` +
        `supported types for :sum: ${SUM_TYPES.join(", ")}`
    };
  }

  return null;
}

/** Exported for unit testing (see pickExistingFields export pattern). */
export function validateAggregationRequest(
  groupby: string[],
  aggregates: string[],
  fieldsMeta: Record<string, CachedFieldMeta>
): { ok: true } | { ok: false; issue: AggregationValidationIssue } {
  for (const token of groupby) {
    const parsed = parseGroupbyToken(token);
    if (!parsed.ok) {
      return {
        ok: false,
        issue: { code: "invalid_groupby", field: parsed.field, details: parsed.details }
      };
    }
    const issue = validateGroupby(parsed.value.field, parsed.value.granularity, fieldsMeta);
    if (issue) {
      return { ok: false, issue };
    }
  }

  for (const token of aggregates) {
    const parsed = parseAggregateToken(token);
    if (!parsed.ok) {
      return {
        ok: false,
        issue: { code: "unsupported_aggregate", field: parsed.field, details: parsed.details }
      };
    }
    const issue = validateAggregate(parsed.value, fieldsMeta);
    if (issue) {
      return { ok: false, issue };
    }
  }

  return { ok: true };
}
