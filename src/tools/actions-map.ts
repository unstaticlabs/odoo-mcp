export interface CuratedAction {
  method: string;
  label?: string;
  confirm?: string;
}

export const CURATED_MODEL_ACTIONS: Record<string, CuratedAction[]> = {
  "account.move": [
    { method: "action_post" },
    { method: "button_draft" },
    { method: "button_cancel" }
  ],
  "hr.expense.sheet": [
    { method: "action_submit_sheet" },
    { method: "action_approve_expense_sheets" },
    { method: "action_reset_expense_sheets" }
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
    { method: "action_post" },
    { method: "action_draft" },
    { method: "action_cancel" }
  ]
};
