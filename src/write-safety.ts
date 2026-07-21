/**
 * Connector write-safety gate for generic MCP write tools.
 *
 * Delegates PM classification to `classifyPmWriteIntent` in safety.ts so bookkeeping planners
 * and generic write tools share one rule set. This module adds connector-specific helpers only.
 */

import {
  classifyPmWriteIntent,
  collectPmValueRecords,
  FINANCIAL_FIELD_PATTERNS,
  PM_TEXT_FIELDS,
  type PmWriteIntent
} from "./safety";

export type WriteIntent = PmWriteIntent;

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

/**
 * Backward-compat generic write-tool behavior for PM models beyond the canonical classifier
 * minimum (project.task + mail.activity→project.task). Mirrors the pre-refactor allowlist so
 * generic writes to project.project, project metadata (tags/types/stages), and project-scoped
 * activities keep working alongside dedicated projects.* tools. Reached only after the
 * canonical classifier denies; sensitive models (account.*, hr.*, …) are blocked upstream.
 */
const COMPAT_PROJECT_PROJECT_FIELDS = new Set([
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

const COMPAT_MAIL_ACTIVITY_FIELDS = new Set([
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

const COMPAT_PROJECT_METADATA_MODELS = new Set([
  "project.tags",
  "project.task.type",
  "project.project.stage",
  "project.task.stage"
]);

/** Non-allowlisted, non-prose fields that look financial — the only keys the compat gate blocks. */
function compatFinancialFields(
  records: Record<string, unknown>[],
  allowed: ReadonlySet<string>
): string[] {
  const blocked: string[] = [];
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (allowed.has(key)) continue;
      if (PM_TEXT_FIELDS.has(key)) continue;
      if (FINANCIAL_FIELD_PATTERNS.some((re) => re.test(key))) blocked.push(key);
    }
  }
  return [...new Set(blocked)];
}

function assessWriteOperationCompat(input: WriteOperationInput): WriteSafetyVerdict | null {
  const model = input.model.trim();
  const method = input.method.trim();

  if (model === "project.project") {
    if (method === "message_post" || method === "unlink") {
      return { allowed: true, intent: "project_management" };
    }
    if (method === "create" || method === "write") {
      const blocked = compatFinancialFields(collectPmValueRecords(input.args), COMPAT_PROJECT_PROJECT_FIELDS);
      if (blocked.length > 0) {
        return {
          allowed: false,
          intent: "financial_mutation",
          reason: `project.project write touches financial or non-PM fields: ${blocked.join(", ")}.`,
          blocked_fields: blocked
        };
      }
      return { allowed: true, intent: "project_management" };
    }
    return null;
  }

  if (COMPAT_PROJECT_METADATA_MODELS.has(model)) {
    if (method === "create" || method === "write" || method === "unlink") {
      return { allowed: true, intent: "project_management" };
    }
    return null;
  }

  // mail.activity targeting project.project (canonical allows only project.task).
  if (model === "mail.activity" && (method === "create" || method === "write")) {
    const records = collectPmValueRecords(input.args);
    const targetsProject =
      records.length > 0 &&
      records.every((rec) => typeof rec.res_model === "string" && rec.res_model.trim() === "project.project");
    if (targetsProject && compatFinancialFields(records, COMPAT_MAIL_ACTIVITY_FIELDS).length === 0) {
      return { allowed: true, intent: "project_management" };
    }
  }

  return null;
}

/**
 * Pure classifier for a single Odoo write. Textual fields are never keyword-scanned — only
 * model/method/field structure determines intent.
 */
export function assessWriteOperation(input: WriteOperationInput): WriteSafetyVerdict {
  const result = classifyPmWriteIntent(input);
  if (result.verdict === "allowed") {
    return {
      allowed: true,
      intent: result.intent,
      reason: result.reason,
      blocked_fields: result.blocked_fields
    };
  }

  const compat = assessWriteOperationCompat(input);
  if (compat) return compat;

  return {
    allowed: false,
    intent: result.intent,
    reason: result.reason,
    blocked_fields: result.blocked_fields
  };
}

/** Convenience helper for tool handlers. */
export function assertWriteAllowed(input: WriteOperationInput): WriteSafetyVerdict {
  return assessWriteOperation(input);
}
