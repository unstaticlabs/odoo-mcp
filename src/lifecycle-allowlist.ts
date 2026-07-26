/**
 * Capability-gated reversible lifecycle allowlist for `call_model_method`.
 *
 * Pure policy data + helpers — no Odoo I/O. Field mutations stay on dedicated draft billing
 * tools; high-risk post/pay/reconcile/delete/lock methods stay denied.
 */

/** Machine-readable policy rule ids on write_blocked / discovery envelopes. */
export type PolicyRule =
  | "sensitive_model_crud"
  | "high_risk_method"
  | "lifecycle_allowlist"
  | "lifecycle_state_incompatible"
  | "lifecycle_context_required"
  | "lifecycle_move_type_incompatible"
  | "sensitive_model_method_denied";

/** Coarse risk class for operator/agent routing. */
export type RiskClass =
  | "preparatory"
  | "reversible_lifecycle"
  | "irreversible_posting"
  | "irreversible_payment"
  | "destructive"
  | "lock_sensitive";

export type LifecycleRule = {
  model: string;
  method: string;
  /** Compatible current `state` values (record must be in one of these). */
  from_states: readonly string[];
  risk_class: "reversible_lifecycle";
  policy_rule: "lifecycle_allowlist";
  /** For account.move: only these move_type values are allowed. */
  require_move_types?: readonly string[];
  next_step_hint?: string;
};

export type HighRiskRule = {
  model: string;
  method: string;
  risk_class: Exclude<RiskClass, "preparatory" | "reversible_lifecycle">;
  policy_rule: "high_risk_method";
  reason: string;
  next_step: string;
  alternative?: string;
};

/** Vendor-bill hygiene path — draft reset only for vendor bills / refunds. */
const VENDOR_BILL_MOVE_TYPES = ["in_invoice", "in_refund"] as const;

/**
 * v1 reversible lifecycle methods. Names match curated `actions-map` + typical Odoo 17–19
 * form buttons (`action_*` / `button_draft`).
 */
export const REVERSIBLE_LIFECYCLE_ALLOWLIST: readonly LifecycleRule[] = [
  {
    model: "hr.expense",
    method: "action_reset",
    from_states: ["submitted", "approved", "reported"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint:
      "After reset to draft, use billing.update_draft_expense for preparatory fields, then action_submit / action_approve."
  },
  {
    model: "hr.expense",
    method: "action_submit",
    from_states: ["draft"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint: "After submit, use call_model_method action_approve when the expense is submitted."
  },
  {
    model: "hr.expense",
    method: "action_approve",
    from_states: ["submitted"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint: "Expense approved. Posting/payment remains blocked on generic MCP tools."
  },
  {
    model: "hr.expense.sheet",
    method: "action_reset_expense_sheets",
    from_states: ["submit", "approve"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint:
      "After sheet reset to draft, edit lines / use billing.update_draft_expense on draft expenses, then action_submit_sheet."
  },
  {
    model: "hr.expense.sheet",
    method: "action_submit_sheet",
    from_states: ["draft"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint: "After submit, use call_model_method action_approve_expense_sheets when state is submit."
  },
  {
    model: "hr.expense.sheet",
    method: "action_approve_expense_sheets",
    from_states: ["submit"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint: "Sheet approved. Posting/payment remains blocked on generic MCP tools."
  },
  {
    model: "account.move",
    method: "button_draft",
    from_states: ["posted", "cancel"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    require_move_types: VENDOR_BILL_MOVE_TYPES,
    next_step_hint:
      "After draft reset on a vendor bill, use billing.configure_draft_vendor_bill for preparatory fields."
  }
];

/** Explicit high-risk methods — never opened by the lifecycle allowlist. */
export const HIGH_RISK_METHOD_DENYLIST: readonly HighRiskRule[] = [
  {
    model: "account.move",
    method: "action_post",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Posting journal entries is irreversible from the connector's perspective.",
    next_step: "Use bookkeeping.plan_safe_write for validated accounting writes, or post in the Odoo UI.",
    alternative: "bookkeeping.plan_safe_write"
  },
  {
    model: "account.move",
    method: "button_cancel",
    risk_class: "destructive",
    policy_rule: "high_risk_method",
    reason: "Cancelling posted moves is blocked on generic MCP write tools.",
    next_step: "Cancel in the Odoo UI / with a human, or use bookkeeping.plan_safe_write when applicable.",
    alternative: "human / Odoo UI"
  },
  {
    model: "account.payment",
    method: "action_post",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Posting payments is blocked on generic MCP write tools.",
    next_step: "Register or post payments in the Odoo UI / with a human.",
    alternative: "human / Odoo UI"
  },
  {
    model: "account.payment",
    method: "action_draft",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Payment draft-reset is not on the connector reversible-lifecycle allowlist.",
    next_step: "Reset payments in the Odoo UI / with a human.",
    alternative: "human / Odoo UI"
  },
  {
    model: "account.payment",
    method: "action_cancel",
    risk_class: "destructive",
    policy_rule: "high_risk_method",
    reason: "Cancelling payments is blocked on generic MCP write tools.",
    next_step: "Cancel payments in the Odoo UI / with a human.",
    alternative: "human / Odoo UI"
  },
  {
    model: "hr.expense",
    method: "action_post",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Posting expenses creates accounting entries and is blocked on generic MCP tools.",
    next_step: "Post in the Odoo UI / with a human.",
    alternative: "human / Odoo UI"
  },
  {
    model: "hr.expense",
    method: "action_pay",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Paying expenses is blocked on generic MCP write tools.",
    next_step: "Register payment in the Odoo UI / with a human.",
    alternative: "human / Odoo UI"
  },
  {
    model: "hr.expense.sheet",
    method: "action_sheet_move_create",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Creating journal entries from expense sheets is blocked on generic MCP tools.",
    next_step: "Post sheets in the Odoo UI / with a human.",
    alternative: "human / Odoo UI"
  }
];

const CRUD_METHODS = new Set(["create", "write", "unlink"]);

const LIFECYCLE_BY_KEY = new Map<string, LifecycleRule>(
  REVERSIBLE_LIFECYCLE_ALLOWLIST.map((r) => [`${r.model}::${r.method}`, r])
);

const HIGH_RISK_BY_KEY = new Map<string, HighRiskRule>(
  HIGH_RISK_METHOD_DENYLIST.map((r) => [`${r.model}::${r.method}`, r])
);

/** Methods that look like posting / payment / reconcile regardless of curated denylist. */
const HIGH_RISK_METHOD_NAME_RE =
  /^(action_post|button_post|action_register_payment|post_payments|reconcile|action_reconcile|js_assign_outstanding_line|button_set_lock|action_lock)/i;

function key(model: string, method: string): string {
  return `${model.trim()}::${method.trim()}`;
}

export function isSensitiveModelCrudMethod(method: string): boolean {
  return CRUD_METHODS.has(method.trim());
}

export function getReversibleLifecycleRule(model: string, method: string): LifecycleRule | undefined {
  return LIFECYCLE_BY_KEY.get(key(model, method));
}

export function isReversibleLifecycleMethod(model: string, method: string): boolean {
  return LIFECYCLE_BY_KEY.has(key(model, method));
}

export function getHighRiskMethodRule(model: string, method: string): HighRiskRule | undefined {
  const exact = HIGH_RISK_BY_KEY.get(key(model, method));
  if (exact) return exact;
  const m = method.trim();
  if (!HIGH_RISK_METHOD_NAME_RE.test(m)) return undefined;
  // Pattern match on sensitive-ish method names when model-scoped entry is absent.
  const risk_class: HighRiskRule["risk_class"] =
    /pay|payment/i.test(m) ? "irreversible_payment" : /reconcil/i.test(m) ? "irreversible_payment" : /lock/i.test(m) ? "lock_sensitive" : "irreversible_posting";
  return {
    model: model.trim(),
    method: m,
    risk_class,
    policy_rule: "high_risk_method",
    reason: `Method "${m}" is a high-risk financial mutation and is blocked on generic MCP write tools.`,
    next_step:
      risk_class === "lock_sensitive" || risk_class === "irreversible_posting"
        ? "Use bookkeeping.plan_safe_write for validated accounting/tax operations, or perform this in the Odoo UI."
        : "Perform this in the Odoo UI / with a human.",
    alternative: risk_class === "lock_sensitive" || risk_class === "irreversible_posting" ? "bookkeeping.plan_safe_write" : "human / Odoo UI"
  };
}

export function isHighRiskMethod(model: string, method: string): boolean {
  return getHighRiskMethodRule(model, method) !== undefined;
}

export function isCompatibleLifecycleState(rule: LifecycleRule, state: string | null | undefined): boolean {
  if (state == null || typeof state !== "string") return false;
  const normalized = state.trim();
  if (!normalized) return false;
  return rule.from_states.includes(normalized);
}

export function isCompatibleMoveType(rule: LifecycleRule, moveType: string | null | undefined): boolean {
  if (!rule.require_move_types || rule.require_move_types.length === 0) return true;
  if (moveType == null || typeof moveType !== "string") return false;
  return rule.require_move_types.includes(moveType.trim());
}

/** Allowlisted method names for a model (for deny-reason hints). */
export function allowlistedMethodsForModel(model: string): string[] {
  const m = model.trim();
  return REVERSIBLE_LIFECYCLE_ALLOWLIST.filter((r) => r.model === m).map((r) => r.method);
}

export type ActionExecutability = {
  executable: boolean;
  deny_reason?: string;
  alternative?: string;
  risk_class?: RiskClass;
  policy_rule?: PolicyRule;
};

/**
 * Annotate a discovered/curated action with connector executability.
 * Fail-closed on sensitive models: only the reversible lifecycle allowlist is executable.
 */
export function annotateActionExecutability(model: string, method: string): ActionExecutability {
  const lifecycle = getReversibleLifecycleRule(model, method);
  if (lifecycle) {
    return {
      executable: true,
      risk_class: lifecycle.risk_class,
      policy_rule: lifecycle.policy_rule
    };
  }

  const highRisk = getHighRiskMethodRule(model, method);
  if (highRisk) {
    return {
      executable: false,
      deny_reason: highRisk.reason,
      alternative: highRisk.alternative,
      risk_class: highRisk.risk_class,
      policy_rule: highRisk.policy_rule
    };
  }

  return {
    executable: false,
    deny_reason: "Method is not on the connector reversible-lifecycle allowlist for call_model_method.",
    alternative: allowlistedMethodsForModel(model).length
      ? `call_model_method with allowlisted methods: ${allowlistedMethodsForModel(model).join(", ")}`
      : "Use dedicated billing.* / bookkeeping.* tools or the Odoo UI.",
    policy_rule: "sensitive_model_method_denied"
  };
}
