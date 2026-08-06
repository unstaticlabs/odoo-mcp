/**
 * Narrow inventory master-data graduation (card ODOO2240).
 *
 * Exactly two inventory models are action-classified **by exact name**: `product.category` and
 * `stock.location`. Ordinary categories and locations are reversible configuration — Odoo's own
 * ACLs are the authority (BYO-key) — but the rest of `product.*` / `stock.*` (products, templates,
 * pickings, moves, quants, …) stays default-denied. That is why this is a Set of full model names
 * and not a `product.` / `stock.` prefix: widening is a product decision, one named model at a time.
 *
 * Pure data + helpers only (no Odoo I/O), so `safety.ts` can gate on the same list the duplicate
 * preflight in `tools/write.ts` uses and the two cannot drift.
 */

/** Graduated model → the many2one field holding its parent (categories nest via a different field than locations). */
const PARENT_FIELD_BY_MODEL: Record<string, string> = {
  "product.category": "parent_id",
  "stock.location": "location_id"
};

/** Exactly the inventory models graduated onto the action-classified path. */
export const INVENTORY_MASTER_DATA_MODELS: ReadonlySet<string> = new Set(Object.keys(PARENT_FIELD_BY_MODEL));

/** True when `model` is one of the two graduated inventory master-data models. */
export function isInventoryMasterDataModel(model: string): boolean {
  return INVENTORY_MASTER_DATA_MODELS.has(model.trim());
}

/**
 * Parent many2one field for a graduated model, or undefined for every other model.
 * `stock.location` nests through `location_id`, NOT `parent_id` — the wrong field would silently
 * turn the duplicate preflight into a no-op.
 */
export function inventoryMasterDataParentField(model: string): string | undefined {
  return PARENT_FIELD_BY_MODEL[model.trim()];
}

/**
 * Coerce a many2one payload value to the id used in a duplicate domain.
 *
 * - `undefined` / `null` / `false` / `0` / `""` → `false` (no parent; a root record).
 * - id number, numeric string, or `[id, display_name]` pair → that id.
 * - anything else → `undefined`, meaning "unrecognized shape": callers must SKIP the duplicate check
 *   rather than guess a domain, since a wrong parent silently checks the wrong sibling set.
 */
export function normalizeParentValue(raw: unknown): number | false | undefined {
  if (raw === undefined || raw === null || raw === false || raw === 0 || raw === "") return false;
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : undefined;
  }
  // Odoo read/search_read returns many2one as [id, display_name]; callers sometimes echo that back.
  if (Array.isArray(raw)) {
    if (raw.length === 0) return false;
    const [first] = raw;
    return typeof first === "number" && Number.isInteger(first) && first > 0 ? first : undefined;
  }
  return undefined;
}

/** Domain matching an existing record with the same name under the same parent (3-tuple equality). */
export function buildDuplicateDomain(
  name: string,
  parentField: string,
  parentId: number | false
): [string, string, unknown][] {
  return [
    ["name", "=", name],
    [parentField, "=", parentId]
  ];
}

/** Rows fetched by the preflight — enough to name the existing record back to the caller. */
export const DUPLICATE_PREFLIGHT_LIMIT = 5;
