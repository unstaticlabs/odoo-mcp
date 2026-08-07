/**
 * Canonical clickable Odoo record URLs (ODOO2272).
 *
 * Agents surface Odoo records to humans. A bare id ("task 2266", "bill 9921") forces the
 * user to go hunt for the record, so every tool that returns a record also returns the URL
 * that opens it — agents must never assemble a UI route from an id themselves.
 *
 * ROUTING IS NOT GUESSED. The shapes below are the ones Odoo's own web client produces in
 * `pathFromActionState()` (`@web/core/browser/router`), verified against the production
 * bundle on Odoo 19.2:
 *
 *   path = [ active_id? , action|model , res_id? ].join("/")   →   /odoo/<path>
 *     - `action` containing a "." or numeric  → `action-<action>`  (xml_id / db id)
 *     - `action` otherwise                    → the action's `path` (e.g. "vendor-bills")
 *     - no action, dotted `model`             → the model name verbatim ("account.move")
 *     - no action, undotted `model`           → `m-<model>`
 *
 * So all three of these are first-class, router-supported forms:
 *   /odoo/project/17/tasks/4242      nested: active_id=17 (project) → child action "tasks"
 *   /odoo/vendor-bills/9921          curated action path + res_id
 *   /odoo/account.move/9844          generic model route — the same form Odoo uses for
 *                                    chatter record mentions (`stateToUrl({model, resId})`)
 *
 * The generic model route is the fallback for every model, which is why this helper never
 * returns null for a well-formed (model, id): there is always a correct route to hand out.
 *
 * The curated map only exists to put the record in the right list/breadcrumb context; the
 * paths in it are read off production `ir.actions.act_window.path` values, not invented.
 */

/** Annotation key carrying the canonical URL on returned records (matches `_workflow_status` style). */
export const RECORD_URL_FIELD = "_web_url";

/**
 * Verified `ir.actions.act_window.path` per model — the list/breadcrumb context a record is
 * normally reached through. Models absent here use the generic `/odoo/<model>/<id>` route.
 */
export const MODEL_ACTION_PATHS: Readonly<Record<string, string>> = {
  "project.project": "project",
  "project.task.type": "task-stages",
  "res.partner": "contacts",
  "res.users": "users",
  "res.company": "companies",
  "hr.expense": "expenses",
  "hr.employee": "employees",
  "account.account": "accounts",
  "account.move.line": "items",
  "account.analytic.account": "analytic-accounts",
  "account.analytic.line": "analytic-items",
  "account.asset": "assets",
  "account.tax": "taxes",
  "account.payment.term": "payment-terms",
  "account.return": "tax-return",
  "product.template": "products",
  "product.category": "product-categories",
  "purchase.order": "purchase-orders",
  "sale.order": "orders",
  "stock.lot": "lots",
  "documents.document": "documents",
  "knowledge.article": "articles"
};

/** `account.move` is five different documents behind one model — route by `move_type`. */
export const ACCOUNT_MOVE_PATHS: Readonly<Record<string, string>> = {
  out_invoice: "customer-invoices",
  out_refund: "credit-notes",
  in_invoice: "vendor-bills",
  in_refund: "vendor-refunds",
  entry: "entries"
};

/** Fallback move route when `move_type` was not requested: Journal Entries covers every move. */
export const ACCOUNT_MOVE_DEFAULT_PATH = "entries";

export const ACCOUNT_PAYMENT_PATHS: Readonly<Record<string, string>> = {
  inbound: "customer-payments",
  outbound: "vendor-payments"
};

export const STOCK_PICKING_PATHS: Readonly<Record<string, string>> = {
  incoming: "receipts",
  outgoing: "deliveries",
  internal: "internal"
};

/** Task route when the owning project is unknown (private to-dos, or `project_id` not read). */
export const PROJECT_TASK_FALLBACK_PATH = "all-tasks";

/** Strip trailing slashes so route joining never produces `//odoo/...`. */
export function odooOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Read an id out of an Odoo field value: many2one reads come back as `[id, display_name]`,
 * writes take a bare id, and unset relations are `false`.
 */
export function toRecordId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (Array.isArray(value)) return toRecordId(value[0]);
  return null;
}

function selectionValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Route segments after `/odoo/` for one record. Exported so tests (and the docs table) can
 * assert the route independently of the origin.
 */
export function recordRoutePath(model: string, recordId: number, record?: Record<string, unknown> | null): string {
  switch (model) {
    case "project.task": {
      // Nested route keeps the project breadcrumb — the same shape feedback.submit has always used.
      const projectId = toRecordId(record?.project_id);
      return projectId != null
        ? `project/${projectId}/tasks/${recordId}`
        : `${PROJECT_TASK_FALLBACK_PATH}/${recordId}`;
    }
    case "account.move": {
      const moveType = selectionValue(record?.move_type);
      const path = (moveType && ACCOUNT_MOVE_PATHS[moveType]) || ACCOUNT_MOVE_DEFAULT_PATH;
      return `${path}/${recordId}`;
    }
    case "account.payment": {
      const paymentType = selectionValue(record?.payment_type);
      const path = paymentType ? ACCOUNT_PAYMENT_PATHS[paymentType] : undefined;
      return path ? `${path}/${recordId}` : `${model}/${recordId}`;
    }
    case "stock.picking": {
      const code = selectionValue(record?.picking_type_code);
      const path = code ? STOCK_PICKING_PATHS[code] : undefined;
      return path ? `${path}/${recordId}` : `${model}/${recordId}`;
    }
    default: {
      const curated = MODEL_ACTION_PATHS[model];
      if (curated) return `${curated}/${recordId}`;
      // Generic model route. Odoo's router reads a dotted segment as a model name; an
      // undotted one would be parsed as an action path, hence the `m-` prefix.
      return model.includes(".") ? `${model}/${recordId}` : `m-${model}/${recordId}`;
    }
  }
}

/**
 * Canonical clickable URL for one record, or null when the inputs cannot address a record
 * (no Odoo origin on the connection, blank model, non-positive id).
 *
 * `record` is optional context used only to pick the better route variant — pass whatever
 * fields you already read (`project_id`, `move_type`, …); missing ones just degrade to the
 * model-level route, never to a wrong one.
 */
export function buildRecordUrl(
  baseUrl: string | undefined | null,
  model: string,
  recordId: unknown,
  record?: Record<string, unknown> | null
): string | null {
  const origin = odooOrigin(baseUrl ?? "");
  if (!origin) return null;
  if (!model || !model.trim()) return null;
  const id = toRecordId(recordId);
  if (id == null) return null;
  return `${origin}/odoo/${recordRoutePath(model.trim(), id, record)}`;
}

/**
 * Attach `_web_url` to a record read from Odoo. Returns the record unchanged when no URL is
 * derivable (unknown origin, or a row without an `id` — e.g. a read_group bucket).
 */
export function annotateRecordUrl<T extends Record<string, unknown>>(
  baseUrl: string | undefined | null,
  model: string,
  record: T
): T {
  if (record == null || typeof record !== "object") return record;
  const url = buildRecordUrl(baseUrl, model, record.id, record);
  return url == null ? record : ({ ...record, [RECORD_URL_FIELD]: url } as T);
}

/** {@link annotateRecordUrl} over a result set. Non-object rows pass through untouched. */
export function annotateRecordUrls<T extends Record<string, unknown>>(
  baseUrl: string | undefined | null,
  model: string,
  records: T[]
): T[] {
  if (!Array.isArray(records)) return records;
  return records.map((row) => annotateRecordUrl(baseUrl, model, row));
}
