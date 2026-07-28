/**
 * Capability-gated reversible lifecycle allowlist + irreversible method catalog for
 * `call_model_method`.
 *
 * Pure policy data + helpers — no Odoo I/O. Irreversible posting / payment / reconcile /
 * delete / lock methods require a confirmation token (see `policy.ts` + write tools); they
 * are no longer flat denials. Odoo ACLs / workflow / locks / hashes remain the authority.
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
  | "irreversible_confirmation_required"
  | "irreversible_confirmation_invalid"
  | "reversible_configuration"
  | "reversible_lifecycle"
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
  | "reversible_configuration"
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
  /**
   * Current `state` values from which this transition is irreversible and therefore requires a
   * confirmation token, even though the method itself is allowlisted. State-aware by necessity: the
   * pure classifier only sees (model, method), so "un-posting is dangerous but resetting a
   * cancelled record is not" can only be decided once the live record has been read.
   */
  confirm_from_states?: readonly string[];
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

/**
 * Confirmation-path next steps for irreversible ledger actions.
 * `bookkeeping.plan_safe_write` covers only its four tax/lock operations — never post/pay.
 */
const CONFIRM_RETRY =
  "Retry the same call with confirmation_token from the preflight response (two-phase: preflight → confirm → execute).";
const POST_NEXT_STEP = `Posting requires confirmation. ${CONFIRM_RETRY} bookkeeping.plan_safe_write cannot post journal entries.`;
const PAY_NEXT_STEP = `Payment requires confirmation. ${CONFIRM_RETRY}`;
const LOCK_NEXT_STEP =
  `Lock-sensitive writes require confirmation. ${CONFIRM_RETRY} Or use bookkeeping.plan_safe_write for create_lock_exception / tax-close ops.`;
const DESTROY_NEXT_STEP = `Destructive actions require confirmation. ${CONFIRM_RETRY}`;

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
    // Posted + cancel: Odoo enforces hash / lock / move_type. The connector no longer refuses posted
    // resets solely by policy (#2201 reset → correct → repost of unhashed unlocked moves) — but see
    // `confirm_from_states`: un-posting is gated, it is not free.
    from_states: ["cancel", "posted"],
    // Resetting a POSTED move to draft un-posts its journal entry: it removes an accounting record
    // that exists. That is the reverse of `action_post` and belongs in the same risk class — an
    // unhashed, unlocked entry has neither of Odoo's own guards. From `cancel` there is no live
    // entry to remove, so that direction stays unconfirmed.
    confirm_from_states: ["posted"],
    // Deliberately NOT restricted by move_type. Odoo's hash/lock checks are the authority on which
    // moves may be reset, and #2201's motivating case is a manual entry (move_type `entry`), not a
    // vendor bill. The safety comes from `confirm_from_states`, not from a move_type allowlist.
    risk_class: "reversible_lifecycle",
    policy_rule: "lifecycle_allowlist",
    next_step_hint:
      "After draft reset, correct fields via update_record / billing.configure_draft_vendor_bill, then action_post with confirmation.",
    excluded_state_hints: {
      draft: "Record is already draft — edit fields directly, then post with confirmation when ready."
    }
  }
];

/**
 * Explicit irreversible methods — require confirmation token (not flat denial).
 * Pattern matching in `getHighRiskMethodRule` covers posting/pay/reconcile/lock names
 * even when the model is absent from this curated list.
 */
export const HIGH_RISK_METHOD_DENYLIST: readonly HighRiskRule[] = [
  {
    model: "account.move",
    method: "action_post",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Posting journal entries is irreversible from the connector's perspective and requires confirmation.",
    next_step: POST_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "account.move",
    method: "button_cancel",
    risk_class: "destructive",
    policy_rule: "high_risk_method",
    reason: "Cancelling moves is destructive and requires confirmation.",
    next_step: DESTROY_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "account.payment",
    method: "action_post",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Posting payments requires confirmation.",
    next_step: PAY_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "account.payment",
    method: "action_draft",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Payment draft-reset can reverse posted payment state and requires confirmation.",
    next_step: PAY_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "account.payment",
    method: "action_cancel",
    risk_class: "destructive",
    policy_rule: "high_risk_method",
    reason: "Cancelling payments is destructive and requires confirmation.",
    next_step: DESTROY_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "hr.expense",
    method: "action_post",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Posting expenses creates accounting entries and requires confirmation.",
    next_step: POST_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "hr.expense",
    method: "action_pay",
    risk_class: "irreversible_payment",
    policy_rule: "high_risk_method",
    reason: "Paying expenses requires confirmation.",
    next_step: PAY_NEXT_STEP,
    alternative: "confirmation_token"
  },
  {
    model: "hr.expense.sheet",
    method: "action_sheet_move_create",
    risk_class: "irreversible_posting",
    policy_rule: "high_risk_method",
    reason: "Creating journal entries from expense sheets requires confirmation.",
    next_step: POST_NEXT_STEP,
    alternative: "confirmation_token"
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
/**
 * Method names that are high-risk regardless of a model-scoped catalog entry.
 *
 * Odoo exposes the same irreversible operation under several names — the public button
 * (`action_post`), the ORM-internal (`_post`), and per-model variants (`button_validate` on bank
 * statements). Matching only the public name lets the same mutation through under a different
 * label, so every known alias for post / pay / reconcile / lock belongs here.
 */
const HIGH_RISK_METHOD_NAME_RE =
  /^(_post|action_post|button_post|post$|action_register_payment|register_payment|post_payments|reconcile|action_reconcile|js_assign_outstanding_line|button_set_lock|action_lock|button_validate|action_validate)/i;

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
    reason: `Method "${m}" is an irreversible ledger mutation and requires confirmation.`,
    next_step: isLock ? LOCK_NEXT_STEP : risk_class === "irreversible_payment" ? PAY_NEXT_STEP : POST_NEXT_STEP,
    alternative: "confirmation_token"
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

/**
 * True when this transition, from this live state, is irreversible and needs a confirmation token.
 * Structural rather than name-based: any rule may declare the states it must not leave unconfirmed.
 */
export function requiresConfirmationFromState(
  rule: LifecycleRule,
  state: string | null | undefined
): boolean {
  if (!rule.confirm_from_states?.length) return false;
  if (typeof state !== "string") return false;
  return rule.confirm_from_states.includes(state.trim());
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
  /** When true, executable only after a confirmation_token from preflight. */
  confirmation_required?: boolean;
  deny_reason?: string;
  alternative?: string;
  risk_class?: RiskClass;
  policy_rule?: PolicyRule;
};

/**
 * Fail-closed annotation for discovery (`list_model_actions`).
 * Irreversible methods are marked confirmation_required (not permanently non-executable).
 * Unknown reversible methods on any model are executable under Odoo authority (v1 policy).
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
      executable: true,
      confirmation_required: true,
      deny_reason: highRisk.reason,
      alternative: highRisk.alternative,
      risk_class: highRisk.risk_class,
      policy_rule: "irreversible_confirmation_required"
    };
  }

  if (method.trim() === "unlink") {
    return {
      executable: true,
      confirmation_required: true,
      deny_reason: `Deleting ${model} records requires confirmation.`,
      alternative: "confirmation_token",
      risk_class: "destructive",
      policy_rule: "irreversible_confirmation_required"
    };
  }

  // Reversible config / unknown lifecycle — Odoo is the authority (no prefix deny).
  return {
    executable: true,
    risk_class: isSensitiveModelCrudMethod(method) ? "reversible_configuration" : "reversible_lifecycle",
    policy_rule: isSensitiveModelCrudMethod(method) ? "reversible_configuration" : "reversible_lifecycle"
  };
}
