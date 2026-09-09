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
  "quantity", "price_unit", "total_amount", "tax_ids", "payment_mode"
] as const;

export const CURATED_FIELD_CONTRACTS: readonly CuratedFieldContract[] = [
  { capability: "expenses_get_context", model: "hr.expense", fields: EXPENSE_CONTEXT_FIELDS },
  { capability: "expenses_get_context", model: "ir.attachment", fields: EXPENSE_ATTACHMENT_FIELDS },
  { capability: "expenses_update_draft", model: "hr.expense", fields: EXPENSE_DRAFT_WRITABLE_FIELDS }
];
