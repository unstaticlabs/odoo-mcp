/**
 * Narrow inventory master-data graduation (cards ODOO2240, ODOO2255).
 *
 * Exactly three inventory models are action-classified **by exact name**: `product.category`,
 * `stock.location` and `product.template`. Ordinary categories, locations and product templates are
 * reversible configuration — Odoo's own ACLs are the authority (BYO-key) — but the rest of
 * `product.*` / `stock.*` (variants, pickings, moves, quants, …) stays default-denied. That is why
 * this is a Set of full model names and not a `product.` / `stock.` prefix: widening is a product
 * decision, one named model at a time.
 *
 * Graduation is deliberately NOT derived from `PARENT_FIELD_BY_MODEL`: `product.template` is not
 * parent-nested, and tying the allowlist to "has a parent many2one" would silently make every future
 * flat model unwritable. The two concerns are separate — which models are graduated, and how each
 * one's duplicate domain is built.
 *
 * Pure data + helpers only (no Odoo I/O), so `safety.ts` can gate on the same list the duplicate
 * preflight in `tools/write.ts` uses and the two cannot drift.
 */

/** Exactly the inventory models graduated onto the action-classified path. */
export const INVENTORY_MASTER_DATA_MODELS: ReadonlySet<string> = new Set([
  "product.category",
  "stock.location",
  "product.template"
]);

/**
 * Parent-nested graduated models → the many2one field holding the parent (categories nest through a
 * different field than locations). `product.template` is absent on purpose: templates are flat, and
 * their duplicate scope is company, not parent.
 */
const PARENT_FIELD_BY_MODEL: Record<string, string> = {
  "product.category": "parent_id",
  "stock.location": "location_id"
};

/** True when `model` is one of the graduated inventory master-data models. */
export function isInventoryMasterDataModel(model: string): boolean {
  return INVENTORY_MASTER_DATA_MODELS.has(model.trim());
}

/**
 * Parent many2one field for a parent-nested graduated model, or undefined for every other model
 * (including graduated-but-flat `product.template`).
 * `stock.location` nests through `location_id`, NOT `parent_id` — the wrong field would silently
 * turn the duplicate preflight into a no-op.
 */
export function inventoryMasterDataParentField(model: string): string | undefined {
  return PARENT_FIELD_BY_MODEL[model.trim()];
}

/**
 * Coerce a many2one payload value to the id used in a duplicate domain.
 *
 * - `undefined` / `null` / `false` / `0` / `""` → `false` (no parent / no company; a root record).
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

/** One `search_read` the create preflight must run before letting a create through. */
export type InventoryDuplicateCheck = {
  /** Odoo domain, always plain 3-tuple equality. */
  domain: [string, string, unknown][];
  /** Fields to read back, enough to name the existing record. */
  fields: string[];
  /** Reported on the refusal envelope as the fields that collided. */
  blocked_fields: string[];
  /** Completes `<model> already has a record …` — e.g. `named "Consumables" under parent_id 3`. */
  describes: string;
  /** Completes `… or <retry>.` in `next_step` — the caller's way out other than reusing the record. */
  retry: string;
};

/** `false` = root / no company; phrase it in the caller's vocabulary rather than printing `false`. */
function describeScope(field: string, id: number | false, rootLabel: string): string {
  return id === false ? rootLabel : `${field} ${id}`;
}

/**
 * Every duplicate lookup a create of `record` on `model` must pass, in order. Empty when nothing is
 * checkable — no name, or a many2one in a shape we cannot read — because checking the wrong scope's
 * siblings is worse than not checking, and Odoo's own required-field validation already refuses a
 * nameless create through the structured exception envelope.
 *
 * Parent-nested models (`product.category`, `stock.location`) get one name+parent check.
 * `product.template` is flat, so its model-appropriate scope is the company: one name+company check,
 * plus a second `default_code`+company check when the payload carries a non-empty internal reference
 * (an SKU collision is the same duplicate, discovered from the other direction).
 */
export function buildInventoryDuplicateChecks(
  model: string,
  record: Record<string, unknown>
): InventoryDuplicateCheck[] {
  const trimmedModel = model.trim();
  if (!isInventoryMasterDataModel(trimmedModel)) return [];

  const rawName = record.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return [];

  const parentField = inventoryMasterDataParentField(trimmedModel);
  if (parentField) {
    const parentId = normalizeParentValue(record[parentField]);
    if (parentId === undefined) return [];
    return [
      {
        domain: buildDuplicateDomain(name, parentField, parentId),
        fields: ["id", "name", parentField],
        blocked_fields: ["name", parentField],
        describes: `named "${name}" under ${describeScope(parentField, parentId, "no parent (root)")}`,
        retry: `create under a different ${parentField}, or with a distinct name`
      }
    ];
  }

  // product.template — flat, scoped by company (`false` = shared across companies).
  const companyId = normalizeParentValue(record.company_id);
  if (companyId === undefined) return [];
  const companyScope = describeScope("company_id", companyId, "no company (shared)");

  const checks: InventoryDuplicateCheck[] = [
    {
      domain: [
        ["name", "=", name],
        ["company_id", "=", companyId]
      ],
      fields: ["id", "name", "company_id"],
      blocked_fields: ["name", "company_id"],
      describes: `named "${name}" under ${companyScope}`,
      retry: "create under a different company_id, or with a distinct name"
    }
  ];

  const rawCode = record.default_code;
  const defaultCode = typeof rawCode === "string" ? rawCode.trim() : "";
  if (defaultCode) {
    checks.push({
      domain: [
        ["default_code", "=", defaultCode],
        ["company_id", "=", companyId]
      ],
      fields: ["id", "name", "default_code", "company_id"],
      blocked_fields: ["default_code", "company_id"],
      describes: `with default_code "${defaultCode}" under ${companyScope}`,
      retry: "create with a distinct default_code"
    });
  }

  return checks;
}
