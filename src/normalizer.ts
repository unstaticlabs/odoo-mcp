export interface OdooFieldMeta {
  type: string; // "many2one" | "one2many" | "many2many" | "selection" | "char" | "date" | "datetime" | "boolean" | "monetary" | "float" | "integer" | ...
  selection?: [string, string][]; // [value, label] pairs, only for type === "selection"
}
export type FieldsMeta = Record<string, OdooFieldMeta>;

export interface NormalizeOptions {
  includeRaw?: boolean;
}

/** A many2one value from Odoo is a 2-tuple [id, "Display Name"], regardless of metadata presence. */
function isMany2OneTuple(value: unknown): value is [number, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string";
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function normalizeMany2One(value: [number, string]): { id: number; name: string } {
  return { id: value[0], name: value[1] };
}

function normalizeIdList(value: number[]): { ids: number[]; count: number } {
  return { ids: value, count: value.length };
}

function normalizeSelection(value: unknown, selection: [string, string][]): { value: unknown; label: string | null } {
  const match = selection.find(([raw]) => raw === value);
  return { value, label: match ? match[1] : null };
}

function normalizeField(key: string, value: unknown, fieldsMeta?: FieldsMeta): unknown {
  const meta = fieldsMeta?.[key];

  if (meta) {
    if (meta.type === "many2one") return value === false ? null : isMany2OneTuple(value) ? normalizeMany2One(value) : value;
    if (meta.type === "one2many" || meta.type === "many2many")
      return value === false ? null : isNumberArray(value) ? normalizeIdList(value) : value;
    if (meta.type === "selection") return value === false ? null : meta.selection ? normalizeSelection(value, meta.selection) : value;
    if (meta.type === "boolean") return value;
    return value === false ? null : value;
  }

  // Heuristic fallback without metadata: relational shapes are still recognizable structurally.
  if (isMany2OneTuple(value)) return normalizeMany2One(value);
  if (isNumberArray(value)) return normalizeIdList(value);
  // Plain `false` without metadata can't be distinguished from a real boolean field, so leave it as-is.
  return value;
}

export function normalizeRecord(record: Record<string, unknown>, fieldsMeta?: FieldsMeta): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = normalizeField(key, value, fieldsMeta);
  }
  return result;
}

/**
 * Best-effort synthetic status derived from a raw (pre-normalization) Odoo
 * record's `state` or `stage_id` field. `state` takes precedence since it's
 * the more common workflow field; `stage_id` arrives as Odoo's [id, "Label"]
 * many2one tuple, from which the label is extracted.
 */
export function deriveWorkflowStatus(record: Record<string, unknown>): string | null {
  const state = record?.state;
  if (typeof state === "string" && state) return state;

  const stageId = record?.stage_id;
  if (isMany2OneTuple(stageId)) return stageId[1] || null;

  return null;
}

export function normalizeRecords(
  records: Record<string, unknown>[],
  fieldsMeta?: FieldsMeta,
  opts?: NormalizeOptions
): Record<string, unknown>[] {
  return records.map((record) => {
    const normalized = normalizeRecord(record, fieldsMeta);
    return opts?.includeRaw ? { ...normalized, _raw: record } : normalized;
  });
}
