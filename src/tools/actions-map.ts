export interface CuratedAction {
  method: string;
  label?: string;
  confirm?: string;
  /** Optional hint for discovery honesty; runtime executability comes from lifecycle-allowlist. */
  risk_hint?: "reversible_lifecycle" | "irreversible_posting" | "irreversible_payment" | "destructive";
}

/**
 * Curated action methods aligned with the connector reversible-lifecycle allowlist
 * (`src/lifecycle-allowlist.ts`) plus known high-risk methods for discovery honesty.
 * Discovery ≠ execution — see `list_model_actions` `executable` annotation.
 */
export const CURATED_MODEL_ACTIONS: Record<string, CuratedAction[]> = {
  "account.move": [
    { method: "action_post", risk_hint: "irreversible_posting" },
    { method: "button_draft", risk_hint: "reversible_lifecycle" },
    { method: "button_cancel", risk_hint: "destructive" }
  ],
  "hr.expense": [
    { method: "action_reset", risk_hint: "reversible_lifecycle" },
    { method: "action_submit", risk_hint: "reversible_lifecycle" },
    { method: "action_approve", risk_hint: "reversible_lifecycle" },
    { method: "action_post", risk_hint: "irreversible_posting" },
    { method: "action_pay", risk_hint: "irreversible_payment" }
  ],
  "hr.expense.sheet": [
    { method: "action_submit_sheet", risk_hint: "reversible_lifecycle" },
    { method: "action_approve_expense_sheets", risk_hint: "reversible_lifecycle" },
    { method: "action_reset_expense_sheets", risk_hint: "reversible_lifecycle" }
  ],
  "sale.order": [
    { method: "action_confirm" },
    { method: "action_cancel" }
  ],
  "purchase.order": [
    { method: "button_confirm" },
    { method: "button_cancel" },
    { method: "button_draft" }
  ],
  "account.payment": [
    { method: "action_post", risk_hint: "irreversible_payment" },
    { method: "action_draft", risk_hint: "irreversible_payment" },
    { method: "action_cancel", risk_hint: "destructive" }
  ]
};
