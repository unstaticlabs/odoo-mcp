/**
 * Field lists that semantic capabilities read from Odoo by name.
 *
 * These are contracts against the Distribution schema, not free-form strings: a
 * field renamed or dropped upstream makes the whole curated read fail, and the
 * agent silently falls back to slower generic reads. They live here so
 * `test/integration/schema.test.ts` can check every one of them against
 * `fields_get` on a live Distribution database.
 */
export interface CuratedFieldContract {
  readonly capability: string;
  readonly model: string;
  readonly fields: readonly string[];
}

export const EXPENSE_CONTEXT_FIELDS = [
  "display_name", "state", "date", "employee_id", "product_id", "account_id", "analytic_distribution",
  "tax_ids", "payment_mode", "currency_id", "total_amount", "total_amount_currency", "company_id",
  "vendor_id", "existing_bill_id", "has_existing_bill", "account_move_id",
  "split_expense_origin_id", "split_expense_count",
  "expense_batch_id", "batch_readiness", "batch_incomplete_reason", "batch_attachment_status",
  "account_context_source", "analytic_context_source", "batch_context_revision", "batch_context_status",
  "batch_warning_reason", "batch_attention_level", "batch_attention_message", "rebuild_receipt_state",
  "rebuild_next_step"
] as const;

export const EXPENSE_ATTACHMENT_FIELDS = [
  "name", "mimetype", "file_size", "res_id", "create_date"
] as const;

/** Draft expense fields `expenses_update_draft` is allowed to write. */
export const EXPENSE_DRAFT_WRITABLE_FIELDS = [
  "name", "description", "date", "product_id", "account_id", "analytic_distribution",
  "quantity", "price_unit", "total_amount", "tax_ids", "payment_mode", "company_id", "employee_id",
  "expense_batch_id", "vendor_id", "existing_bill_id", "has_existing_bill"
] as const;

/** Project task fields `projects_get_task_context` reads. `github_url` is the generic Link field. */
export const PROJECT_TASK_CONTEXT_FIELDS = [
  "display_name", "project_id", "stage_id", "state", "user_ids", "partner_id", "date_deadline",
  "description", "tag_ids", "parent_id", "child_ids", "company_id", "priority", "create_date", "write_date",
  "allow_task_dependencies", "depend_on_ids", "depend_on_count", "closed_depend_on_count",
  "github_url", "usl_feedback_pr_url", "task_properties"
] as const;

/** Project task fields `projects_update_task` reads before and after its single write. */
export const PROJECT_TASK_CARD_FIELDS = [
  "display_name", "project_id", "stage_id", "state", "github_url", "task_properties"
] as const;

/** Project task fields `projects_update_task` may write. */
export const PROJECT_TASK_CARD_WRITABLE_FIELDS = [
  "stage_id", "state", "description", "github_url", "task_properties"
] as const;

export const PROJECT_STAGE_FIELDS = ["name", "project_ids"] as const;

export const ACTIVITY_COMPLETION_FIELDS = ["res_model", "res_id", "summary"] as const;

export const CURATED_FIELD_CONTRACTS: readonly CuratedFieldContract[] = [
  { capability: "expenses_get_context", model: "hr.expense", fields: EXPENSE_CONTEXT_FIELDS },
  { capability: "expenses_get_context", model: "ir.attachment", fields: EXPENSE_ATTACHMENT_FIELDS },
  { capability: "expenses_update_draft", model: "hr.expense", fields: EXPENSE_DRAFT_WRITABLE_FIELDS },
  { capability: "projects_get_task_context", model: "project.task", fields: PROJECT_TASK_CONTEXT_FIELDS },
  { capability: "projects_update_task", model: "project.task", fields: PROJECT_TASK_CARD_FIELDS },
  { capability: "projects_update_task", model: "project.task", fields: PROJECT_TASK_CARD_WRITABLE_FIELDS },
  { capability: "projects_update_task", model: "project.task.type", fields: PROJECT_STAGE_FIELDS },
  { capability: "activities_complete", model: "mail.activity", fields: ACTIVITY_COMPLETION_FIELDS }
];
