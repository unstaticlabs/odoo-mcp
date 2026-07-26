/**
 * Capability-gated reversible lifecycle allowlist for `call_model_method`.
 *
 * Pure policy data + helpers — no Odoo I/O. Field mutations stay on dedicated draft billing
 * tools; high-risk post/pay/reconcile/delete/lock methods stay denied.
 *
 * Odoo version notes (verified against upstream odoo/odoo addons/hr_expense):
 * - Odoo 17–18: `hr.expense.sheet` exists; sheet states draft/submit/approve/post/done/cancel;
 *   expense *line* states include legacy `reported` ("To Submit" while on a draft sheet).
 * - Odoo 19: sheet model removed ("Bye Bye reports"); lifecycle lives on `hr.expense` with
 *   states draft/submitted/approved/posted/in_payment/paid/refused (no `reported`).
 *   Sheet allowlist entries below are therefore **pre-19 only**.
 */

/** Machine-readable policy rule ids on write_blocked / discovery envelopes. */
export type PolicyRule =
  | "sensitive_model_crud"
  | "high_risk_method"
  | "lifecycle_allowlist"
  | "lifecycle_state_incompatible"
  | "lifecycle_context_required"
  | "lifecycle_ids_invalid"
  | "lifecycle_guard_failed"
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
  /**
   * Odoo computed boolean fields that must all be truthy on the record (e.g. `can_reset`,
   * `can_approve`). Odoo raises on the method itself when these are false; checking them in the
   * preflight turns that raw exception into a `write_blocked` envelope. Version-tolerant: a field
   * absent on the running Odoo version is skipped, never treated as false.
   */
  guard_fields?: readonly string[];
  next_step_hint?: string;
  /** Human note for docs/discovery (not sent to clients unless copied into deny text). */
  version_note?: string;
  /**
   * Extra guidance keyed by the record's *current* state, merged into the deny envelope when the
   * state is not allowlisted. Explains states that are deliberately excluded.
   */
  excluded_state_hints?: Readonly<Record<string, string>>;
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
 * Alternative / next_step for irreversible posting & payment: human / Odoo UI only.
 * `bookkeeping.plan_safe_write` covers only its four tax/lock operations — never post/pay.
 */
const HUMAN_ODOO_UI = "human / Odoo UI";
const POST_NEXT_STEP = "Post in the Odoo UI / with a human. bookkeeping.plan_safe_write cannot post journal entries.";
const PAY_NEXT_STEP = "Register or post payments in the Odoo UI / with a human.";
const LOCK_NEXT_STEP =
  "Use bookkeeping.plan_safe_write for create_lock_exception / tax-close operations (its four supported ops only), or perform this in the Odoo UI.";

/**
 * v1 reversible lifecycle methods. Names match curated `actions-map` + typical Odoo 17–19
 * form buttons (`action_*` / `button_draft`).
 */
export const REVERSIBLE_LIFECYCLE_ALLOWLIST: readonly LifecycleRule[] = [
  {
    model: "hr.expense",
    method: "action_reset",
    // Odoo 19: submitted/approved/refused (approval_state-driven). `reported` is legacy-only
    // (17–18 line state while attached to a draft sheet; absent from Odoo 19 selection).
    from_states: ["submitted", "approved", "refused", "reported"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    // Odoo 19 hides the Reset button unless `can_reset`; the method raises otherwise.
    guard_fields: ["can_reset"],
    next_step_hint:
      "After reset to draft, use billing.update_draft_expense for preparatory fields, then action_submit / action_approve.",
    version_note: "Primary path on Odoo 19+; reported is legacy 17–18 vocabulary only.",
    excluded_state_hints: {
      posted:
        "This expense is already posted — its journal entry exists. Un-posting is a ledger change: do it in the Odoo UI / with a human.",
      in_payment: "Payment is in progress — resolve it in the Odoo UI / with a human.",
      paid: "This expense is paid — resetting it is a ledger change: use the Odoo UI / a human."
    }
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
    // Approval rights are Odoo's (expense approver / manager); `can_approve` is the record-level flag.
    guard_fields: ["can_approve"],
    next_step_hint: "Expense approved. Posting/payment remains blocked on generic MCP tools."
  },
  {
    model: "hr.expense.sheet",
    method: "action_reset_expense_sheets",
    // Pre-19 sheet vocab: draft/submit/approve/post/done/cancel. Reset from non-draft hygiene states.
    from_states: ["submit", "approve", "cancel"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint:
      "After sheet reset to draft, edit lines / use billing.update_draft_expense on draft expenses, then action_submit_sheet.",
    version_note: "hr.expense.sheet removed in Odoo 19 — allowlist is for Odoo 17–18 only."
  },
  {
    model: "hr.expense.sheet",
    method: "action_submit_sheet",
    from_states: ["draft"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint: "After submit, use call_model_method action_approve_expense_sheets when state is submit.",
    version_note: "hr.expense.sheet removed in Odoo 19 — allowlist is for Odoo 17–18 only."
  },
  {
    model: "hr.expense.sheet",
    method: "action_approve_expense_sheets",
    from_states: ["submit"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint: "Sheet approved. Posting/payment remains blocked on generic MCP tools.",
    version_note: "hr.expense.sheet removed in Odoo 19 — allowlist is for Odoo 17–18 only."
  },
  {
    model: "account.move",
    method: "button_draft",
    // `posted` is deliberately EXCLUDED: resetting a posted move to draft un-posts its journal
    // entry, which is a ledger mutation on the human side of the connector fence (same reason
    // hr.expense reset stops before `posted`). Only already-cancelled bills — which carry no live
    // entry — may be returned to draft by an agent.
    from_states: ["cancel"],
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    require_move_types: VENDOR_BILL_MOVE_TYPES,
    next_step_hint:
      "After draft reset on a cancelled vendor bill, use billing.configure_draft_vendor_bill for preparatory fields.",
    excluded_state_hints: {
      posted:
        "This bill is posted — resetting it to draft un-posts its journal entry, which the connector never does. Un-post in the Odoo UI / with a human, then retry."
    }
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
    next_step: POST_NEXT_STEP,
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "account.move",
    method: "button_cancel",
    risk_class: "destructive",
    policy_rule: "high_risk_method",
    reason: "Cancelling posted moves is blocked on generic MCP write tools.",
    next_step: "Cancel in the Odoo UI / with a human.",
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "account.payment",
    method: "action_post",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Posting payments is blocked on generic MCP write tools.",
    next_step: PAY_NEXT_STEP,
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "account.payment",
    method: "action_draft",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Payment draft-reset is not on the connector reversible-lifecycle allowlist.",
    next_step: "Reset payments in the Odoo UI / with a human.",
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "account.payment",
    method: "action_cancel",
    risk_class: "destructive",
    policy_rule: "high_risk_method",
    reason: "Cancelling payments is blocked on generic MCP write tools.",
    next_step: "Cancel payments in the Odoo UI / with a human.",
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "hr.expense",
    method: "action_post",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Posting expenses creates accounting entries and is blocked on generic MCP tools.",
    next_step: POST_NEXT_STEP,
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "hr.expense",
    method: "action_pay",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Paying expenses is blocked on generic MCP write tools.",
    next_step: PAY_NEXT_STEP,
    alternative: HUMAN_ODOO_UI
  },
  {
    model: "hr.expense.sheet",
    method: "action_sheet_move_create",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Creating journal entries from expense sheets is blocked on generic MCP tools.",
    next_step: POST_NEXT_STEP,
    alternative: HUMAN_ODOO_UI
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
    /pay|payment/i.test(m)
      ? "irreversible_payment"
      : /reconcil/i.test(m)
        ? "irreversible_payment"
        : /lock/i.test(m)
          ? "lock_sensitive"
          : "irreversible_posting";
  const isLock = risk_class === "lock_sensitive";
  return {
    model: model.trim(),
    method: m,
    risk_class,
    policy_rule: "high_risk_method",
    reason: `Method "${m}" is a high-risk financial mutation and is blocked on generic MCP write tools.`,
    next_step: isLock ? LOCK_NEXT_STEP : risk_class === "irreversible_payment" ? PAY_NEXT_STEP : POST_NEXT_STEP,
    // plan_safe_write only for lock/tax-close — never for posting or payment.
    alternative: isLock ? "bookkeeping.plan_safe_write" : HUMAN_ODOO_UI
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

/**
 * Fields the stateful preflight must read to evaluate this rule. Single source of truth for the
 * pre-read projection so the gate and its tests can never drift apart.
 */
export function lifecycleReadFields(rule: LifecycleRule): string[] {
  return [
    "id",
    "state",
    ...(rule.require_move_types?.length ? ["move_type"] : []),
    ...(rule.guard_fields ?? [])
  ];
}

/**
 * Guard fields that are present on the record and falsy. A field missing from the record is
 * treated as "not applicable on this Odoo version" and skipped — never as a refusal.
 */
export function failedGuardFields(rule: LifecycleRule, record: Record<string, unknown>): string[] {
  if (!rule.guard_fields?.length) return [];
  return rule.guard_fields.filter((field) => field in record && !record[field]);
}

/** Extra guidance for a deliberately-excluded current state, when the rule documents one. */
export function excludedStateHint(rule: LifecycleRule, state: string | null | undefined): string | undefined {
  if (typeof state !== "string") return undefined;
  return rule.excluded_state_hints?.[state.trim()];
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
 * Sensitive-model fail-closed annotation only (lifecycle allowlist / high-risk / unknown).
 * For non-sensitive models use `annotateActionExecutability` in write-safety.ts, which consults
 * the real write gate so deny_reason/alternative match call_model_method.
 */
export function annotateSensitiveModelActionExecutability(model: string, method: string): ActionExecutability {
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
      : "Use dedicated billing.* tools, bookkeeping.plan_safe_write (tax/lock ops only), or the Odoo UI.",
    policy_rule: "sensitive_model_method_denied"
  };
}
