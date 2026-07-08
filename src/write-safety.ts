/**
 * Connector write-safety gate for generic MCP write tools.
 *
 * Classifies operations by structured intent (model + method + field names), not
 * free-text content. Project-management notes may mention banking, tax deadlines,
 * or B2C exports without being treated as financial record mutations.
 */

export type WriteIntent = "project_management" | "financial_mutation" | "disallowed";

export interface WriteOperationInput {
  model: string;
  method: string;
  /** Odoo JSON-2 body (create → vals_list, write → vals, message_post → body, …). */
  args: Record<string, unknown>;
}

export interface WriteSafetyVerdict {
  allowed: boolean;
  intent: WriteIntent;
  /** Human-readable rejection reason when `allowed` is false. */
  reason?: string;
  /** Field names that triggered a financial-mutation block. */
  blocked_fields?: string[];
}

/** Models whose writes are project-management scoped when methods/fields match. */
export const PROJECT_MANAGEMENT_MODELS = new Set([
  "project.task",
  "project.project",
  "mail.activity",
  "project.tags",
  "project.task.type",
  "project.project.stage",
  "project.task.stage"
]);

/** Odoo models that must never be mutated via generic write tools. */
export const SENSITIVE_MODEL_PREFIXES = [
  "account.",
  "hr.payroll",
  "hr.payslip",
  "payment.",
  "l10n_",
  "stock.valuation",
  "sign.",
  "contract."
] as const;

/** External-party / master-data models blocked from generic writes. */
export const EXTERNAL_PARTY_WRITE_MODELS = new Set(["res.partner"]);

/** Methods that are always project-management when the target model is PM-scoped. */
export const PROJECT_MANAGEMENT_METHODS = new Set(["message_post", "action_feedback"]);

/** Writable PM fields on project.task / project.project (field-name gate only). */
export const PROJECT_TASK_SAFE_FIELDS = new Set([
  "name",
  "display_name",
  "description",
  "stage_id",
  "project_id",
  "priority",
  "user_ids",
  "date_deadline",
  "date_end",
  "date_start",
  "tag_ids",
  "planned_hours",
  "allocated_hours",
  "partner_id",
  "color",
  "sequence",
  "parent_id",
  "child_ids",
  "depend_on_ids",
  "milestone_id",
  "personal_stage_type_ids",
  "kanban_state",
  "state",
  "active",
  "company_id",
  "email_from",
  "is_closed"
]);

export const PROJECT_PROJECT_SAFE_FIELDS = new Set([
  "name",
  "display_name",
  "description",
  "partner_id",
  "user_id",
  "stage_id",
  "date_start",
  "date",
  "tag_ids",
  "color",
  "sequence",
  "privacy_visibility",
  "active",
  "company_id",
  "allow_billable",
  "allow_timesheets"
]);

/** Writable PM fields on mail.activity rows targeting project records. */
export const MAIL_ACTIVITY_SAFE_FIELDS = new Set([
  "summary",
  "note",
  "date_deadline",
  "user_id",
  "activity_type_id",
  "res_model",
  "res_id",
  "res_model_id",
  "automated",
  "active"
]);

/** Field-name substrings that indicate accounting / payroll / bank mutation. */
const FINANCIAL_FIELD_PATTERNS: readonly RegExp[] = [
  /^account_/,
  /_account_id$/,
  /^bank_/,
  /^payment_/,
  /^tax_/,
  /^vat_/,
  /(^|_)vat($|_)/,
  /debit/,
  /credit/,
  /balance/,
  /amount_total/,
  /amount_untaxed/,
  /amount_tax/,
  /journal_id/,
  /move_id/,
  /invoice_/,
  /reconcil/,
  /payroll/,
  /payslip/,
  /siret/,
  /company_registry/,
  /sale_line_id/,
  /sale_order_id/,
  /billable/,
  /pricing_type/
];

const PM_ACTIVITY_RES_MODELS = new Set(["project.task", "project.project"]);

const PM_TEXT_FIELDS = new Set(["description", "note", "summary", "body"]);

/** Odoo methods that do not mutate data — skipped by the write-safety gate. */
export const READ_ONLY_ODOO_METHODS = new Set([
  "read",
  "search_read",
  "search_count",
  "fields_get",
  "get_views",
  "name_get",
  "name_search",
  "read_group",
  "browse",
  "exists",
  "check_access_rights"
]);

/** True when an Odoo JSON-2 method may change server-side state. */
export function isMutatingOdooMethod(method: string): boolean {
  const normalized = method.trim();
  if (!normalized) return false;
  return !READ_ONLY_ODOO_METHODS.has(normalized);
}

function normalizeModel(model: string): string {
  return model.trim();
}

function isSensitiveModel(model: string): boolean {
  if (EXTERNAL_PARTY_WRITE_MODELS.has(model)) return true;
  return SENSITIVE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

function isFinancialField(field: string): boolean {
  return FINANCIAL_FIELD_PATTERNS.some((re) => re.test(field));
}

function collectValueRecords(args: Record<string, unknown>): Record<string, unknown>[] {
  const valsList = args.vals_list;
  if (Array.isArray(valsList)) {
    return valsList.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  }
  const vals = args.vals;
  if (vals && typeof vals === "object" && !Array.isArray(vals)) {
    return [vals as Record<string, unknown>];
  }
  return [];
}

function blockedFieldsInRecords(
  records: Record<string, unknown>[],
  allowed: ReadonlySet<string>
): string[] {
  const blocked: string[] = [];
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (allowed.has(key)) continue;
      if (PM_TEXT_FIELDS.has(key)) continue;
      if (isFinancialField(key)) blocked.push(key);
    }
  }
  return [...new Set(blocked)];
}

function activityTargetsProjectManagement(records: Record<string, unknown>[]): boolean | null {
  let sawResModel = false;
  for (const rec of records) {
    const resModel = rec.res_model;
    if (typeof resModel !== "string" || !resModel) continue;
    sawResModel = true;
    if (!PM_ACTIVITY_RES_MODELS.has(resModel)) return false;
  }
  return sawResModel ? true : null;
}

function mailActivityVerdict(method: string, args: Record<string, unknown>): WriteSafetyVerdict {
  if (PROJECT_MANAGEMENT_METHODS.has(method) || method === "unlink") {
    return { allowed: true, intent: "project_management" };
  }
  if (method !== "create" && method !== "write") {
    return {
      allowed: false,
      intent: "disallowed",
      reason: `mail.activity method "${method}" is not allowed via generic write tools.`
    };
  }

  const records = collectValueRecords(args);
  const target = activityTargetsProjectManagement(records);
  if (method === "create" && target === null) {
    return {
      allowed: false,
      intent: "disallowed",
      reason: "mail.activity create must set res_model to project.task or project.project."
    };
  }
  if (target === false) {
    return {
      allowed: false,
      intent: "financial_mutation",
      reason:
        "mail.activity writes must target project.task or project.project (res_model); " +
        "activities on accounting or external-party records are blocked."
    };
  }

  const blocked = blockedFieldsInRecords(records, MAIL_ACTIVITY_SAFE_FIELDS);
  if (blocked.length > 0) {
    return {
      allowed: false,
      intent: "financial_mutation",
      reason: `mail.activity write touches financial or non-PM fields: ${blocked.join(", ")}.`,
      blocked_fields: blocked
    };
  }

  return { allowed: true, intent: "project_management" };
}

function projectRecordVerdict(
  model: string,
  method: string,
  args: Record<string, unknown>
): WriteSafetyVerdict {
  if (PROJECT_MANAGEMENT_METHODS.has(method) || method === "unlink") {
    return { allowed: true, intent: "project_management" };
  }
  if (method !== "create" && method !== "write") {
    return {
      allowed: false,
      intent: "disallowed",
      reason: `${model} method "${method}" is not allowed via generic write tools.`
    };
  }

  const allowedFields = model === "project.project" ? PROJECT_PROJECT_SAFE_FIELDS : PROJECT_TASK_SAFE_FIELDS;
  const records = collectValueRecords(args);
  const blocked = blockedFieldsInRecords(records, allowedFields);
  if (blocked.length > 0) {
    return {
      allowed: false,
      intent: "financial_mutation",
      reason: `${model} write touches financial or non-PM fields: ${blocked.join(", ")}.`,
      blocked_fields: blocked
    };
  }

  return { allowed: true, intent: "project_management" };
}

/**
 * Pure classifier for a single Odoo write. Textual fields (description, note,
 * summary, message_post body) are never keyword-scanned — only model/method/field
 * structure determines intent.
 */
export function assessWriteOperation(input: WriteOperationInput): WriteSafetyVerdict {
  const model = normalizeModel(input.model);
  const method = input.method.trim();

  if (!model) {
    return { allowed: false, intent: "disallowed", reason: "model must be a non-empty string." };
  }
  if (!method) {
    return { allowed: false, intent: "disallowed", reason: "method must be a non-empty string." };
  }

  if (isSensitiveModel(model)) {
    return {
      allowed: false,
      intent: "financial_mutation",
      reason:
        `Writes to ${model} are blocked by the connector safety layer. ` +
        "Use bookkeeping.plan_safe_write for validated accounting/tax operations."
    };
  }

  if (model === "mail.activity") {
    return mailActivityVerdict(method, input.args);
  }

  if (PROJECT_MANAGEMENT_MODELS.has(model)) {
    if (model === "project.task" || model === "project.project") {
      return projectRecordVerdict(model, method, input.args);
    }
    // Lightweight PM metadata models (tags, stages, types): allow create/write/unlink.
    if (method === "create" || method === "write" || method === "unlink") {
      return { allowed: true, intent: "project_management" };
    }
    return {
      allowed: false,
      intent: "disallowed",
      reason: `${model} method "${method}" is not allowed via generic write tools.`
    };
  }

  // Non-PM models: only explicit message_post to project records is PM-shaped.
  if (method === "message_post" && (model === "project.task" || model === "project.project")) {
    return { allowed: true, intent: "project_management" };
  }

  return {
    allowed: false,
    intent: "disallowed",
    reason:
      `Writes to ${model} via generic MCP write tools are not allowlisted. ` +
      "Project-management work should use project.task, mail.activity, or chatter (message_post)."
  };
}

/** Convenience helper for tool handlers. */
export function assertWriteAllowed(input: WriteOperationInput): WriteSafetyVerdict {
  return assessWriteOperation(input);
}
