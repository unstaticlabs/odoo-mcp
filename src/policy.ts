/**
 * Action-based write policy for the Odoo MCP connector (card #2199).
 *
 * Classifies operations by *what they do* (reversible configuration / reversible lifecycle /
 * irreversible ledger), not by model-name prefix. Odoo ACLs, record rules, workflow states,
 * lock dates and entry hashes remain the authority; the connector adds confirmation for
 * irreversible ops and a standardized refusal envelope that names the refusing layer.
 */

import {
  getHighRiskMethodRule,
  getReversibleLifecycleRule,
  isSensitiveModelCrudMethod,
  type HighRiskRule,
  type PolicyRule,
  type RiskClass
} from "./lifecycle-allowlist";
import { OdooError, normalizeOdooDetails } from "./odoo";

/** Layers that may refuse a write — surfaced on every refusal envelope. */
export type RefusingLayer =
  | "connector_policy"
  | "odoo_acl"
  | "odoo_record_rule"
  | "workflow_state"
  | "lock_date"
  | "hash"
  | "schema"
  | "odoo_validation";

/** Coarse buckets from the 2026-07-28 policy decision. */
export type ActionRiskBucket = "reversible_configuration" | "reversible_lifecycle" | "irreversible_ledger";

export type OperationClassification = {
  bucket: ActionRiskBucket;
  risk_class: RiskClass;
  /** True for posting / paying / reconciling / deleting / lock-sensitive writes. */
  requires_confirmation: boolean;
  policy_rule?: PolicyRule;
  reason?: string;
  next_step?: string;
  alternative?: string;
};

const IRREVERSIBLE_RISK_CLASSES = new Set<RiskClass>([
  "irreversible_posting",
  "irreversible_payment",
  "destructive",
  "lock_sensitive"
]);

export function isIrreversibleRiskClass(risk: RiskClass | undefined): boolean {
  return risk != null && IRREVERSIBLE_RISK_CLASSES.has(risk);
}

export function riskClassToBucket(risk: RiskClass): ActionRiskBucket {
  if (isIrreversibleRiskClass(risk)) return "irreversible_ledger";
  if (risk === "reversible_lifecycle") return "reversible_lifecycle";
  return "reversible_configuration";
}

/**
 * Classify a mutating Odoo call by action semantics. Pure — no I/O.
 *
 * - High-risk posting / payment / reconcile / delete / lock → irreversible_ledger (confirmation).
 * - Curated reversible lifecycle methods → reversible_lifecycle.
 * - CRUD create/write → reversible_configuration (Odoo validates).
 * - Other mutating methods default to reversible_lifecycle (Odoo validates workflow).
 */
/**
 * Models whose records ARE the lock, not merely locked data. Creating or editing one moves an
 * accounting period's boundary, which the 2026-07-28 decision names as lock-sensitive and therefore
 * irreversible — regardless of the CRUD verb used to do it.
 */
const LOCK_SENSITIVE_MODELS = new Set(["account.lock_exception"]);

/**
 * Field names that move a lock/close boundary when written on any accounting model. Writing one of
 * these through generic CRUD is the same act as calling a lock method, so it earns the same gate.
 */
const LOCK_DATE_FIELD_RE =
  /^(fiscalyear_lock_date|tax_lock_date|hard_lock_date|purchase_lock_date|sale_lock_date|period_lock_date|lock_date|.*_lock_date)$/i;

/** Lock-boundary fields present in a create/write payload, if any. */
export function lockSensitiveFields(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const records: Record<string, unknown>[] = [];
  const valsList = (args as { vals_list?: unknown }).vals_list;
  const vals = (args as { vals?: unknown }).vals;
  if (Array.isArray(valsList)) {
    for (const v of valsList) if (v && typeof v === "object" && !Array.isArray(v)) records.push(v as Record<string, unknown>);
  }
  if (vals && typeof vals === "object" && !Array.isArray(vals)) records.push(vals as Record<string, unknown>);
  const hits = new Set<string>();
  for (const rec of records) {
    for (const field of Object.keys(rec)) if (LOCK_DATE_FIELD_RE.test(field)) hits.add(field);
  }
  return [...hits];
}

export function classifyOperation(
  model: string,
  method: string,
  args?: Record<string, unknown>
): OperationClassification {
  const m = model.trim();
  const meth = method.trim();

  const highRisk = getHighRiskMethodRule(m, meth);
  if (highRisk) {
    return classificationFromHighRisk(highRisk);
  }

  // Lock-sensitive before the CRUD fast-path: `create`/`write` on a lock record, or a write that
  // moves a lock date on any model, must not fall through to reversible_configuration.
  if (isMutatingMethodForLockCheck(meth)) {
    if (LOCK_SENSITIVE_MODELS.has(m)) {
      return lockSensitiveClassification(
        `Creating or modifying ${m} moves an accounting lock boundary and requires confirmation.`
      );
    }
    const lockFields = lockSensitiveFields(args);
    if (lockFields.length > 0) {
      return lockSensitiveClassification(
        `This write sets lock-boundary field(s) ${lockFields.join(", ")} on ${m}, which moves an accounting lock and requires confirmation.`
      );
    }
  }

  if (meth === "unlink") {
    // PM / project-metadata surface keeps single-shot delete; ledger-adjacent deletes need confirmation.
    if (
      m === "project.task" ||
      m === "mail.activity" ||
      m === "project.project" ||
      m === "project.tags" ||
      m === "project.task.type" ||
      m === "project.project.stage" ||
      m === "project.task.stage"
    ) {
      return {
        bucket: "reversible_lifecycle",
        risk_class: "reversible_lifecycle",
        requires_confirmation: false,
        policy_rule: "reversible_lifecycle"
      };
    }
    return {
      bucket: "irreversible_ledger",
      risk_class: "destructive",
      requires_confirmation: true,
      policy_rule: "irreversible_confirmation_required",
      reason: `Deleting ${m} records is irreversible from the connector's perspective and requires confirmation.`,
      next_step:
        "Call again with the same arguments plus confirmation_token from the preflight response (or delete in the Odoo UI)."
    };
  }

  const lifecycle = getReversibleLifecycleRule(m, meth);
  if (lifecycle) {
    return {
      bucket: "reversible_lifecycle",
      risk_class: lifecycle.risk_class,
      requires_confirmation: false,
      policy_rule: lifecycle.policy_rule,
      next_step: lifecycle.next_step_hint
    };
  }

  if (isSensitiveModelCrudMethod(meth)) {
    return {
      bucket: "reversible_configuration",
      risk_class: "reversible_configuration",
      requires_confirmation: false,
      policy_rule: "reversible_configuration"
    };
  }

  // Non-CRUD mutating methods (action_*, button_*, …) that are not high-risk: reversible lifecycle.
  // Archive / toggle_active stay here (reversible configuration-ish) unless high-risk matched above.
  if (meth === "action_archive" || meth === "action_unarchive" || meth === "toggle_active") {
    return {
      bucket: "reversible_configuration",
      risk_class: "reversible_configuration",
      requires_confirmation: false,
      policy_rule: "reversible_configuration"
    };
  }

  return {
    bucket: "reversible_lifecycle",
    risk_class: "reversible_lifecycle",
    requires_confirmation: false,
    policy_rule: "reversible_lifecycle"
  };
}

/** CRUD verbs whose payload can move a lock boundary. */
function isMutatingMethodForLockCheck(method: string): boolean {
  return method === "create" || method === "write" || method === "unlink";
}

function lockSensitiveClassification(reason: string): OperationClassification {
  return {
    bucket: "irreversible_ledger",
    risk_class: "lock_sensitive",
    requires_confirmation: true,
    policy_rule: "irreversible_confirmation_required",
    reason,
    next_step:
      "Retry the same call with confirmation_token from the preflight response, or use bookkeeping.plan_safe_write for tax-close / lock-exception operations."
  };
}

function classificationFromHighRisk(rule: HighRiskRule): OperationClassification {
  return {
    bucket: "irreversible_ledger",
    risk_class: rule.risk_class,
    requires_confirmation: true,
    policy_rule: "irreversible_confirmation_required",
    reason: rule.reason,
    next_step: rule.next_step,
    alternative: rule.alternative
  };
}

/** Map an Odoo / connector failure to the refusing layer for the standardized envelope. */
export function classifyRefusingLayer(err: unknown): RefusingLayer {
  if (!(err instanceof OdooError)) {
    return "connector_policy";
  }

  if (err.code === "permission_denied" || err.httpStatus === 403) {
    const details = normalizeOdooDetails(err.details);
    if (details.includes("record rule") || details.includes("not allowed to access")) {
      return "odoo_record_rule";
    }
    return "odoo_acl";
  }

  if (err.code === "unauthorized" || err.httpStatus === 401) {
    return "odoo_acl";
  }

  const details = normalizeOdooDetails(err.details);

  if (
    details.includes("hashed") ||
    details.includes("inalterable") ||
    details.includes("hash integrity") ||
    details.includes("secure entries")
  ) {
    return "hash";
  }

  if (
    details.includes("lock date") ||
    details.includes("locked period") ||
    details.includes("tax lock") ||
    details.includes("fiscal year") ||
    /lock(_|\s)?date/.test(details)
  ) {
    return "lock_date";
  }

  if (
    details.includes("state") ||
    details.includes("cannot be modified") ||
    details.includes("only draft") ||
    details.includes("already posted") ||
    details.includes("not allowed in state") ||
    details.includes("invalid transition") ||
    (details.includes("you cannot") && details.includes("posted"))
  ) {
    return "workflow_state";
  }

  if (
    err.code === "model_or_method_not_found" ||
    err.code === "invalid_request" ||
    details.includes("invalid field") ||
    details.includes("unknown field") ||
    details.includes("does not exist") ||
    details.includes("wrong values")
  ) {
    return "schema";
  }

  return "odoo_validation";
}

/** Default next_step when a refusing layer is known but the caller did not supply one. */
export function nextStepForLayer(layer: RefusingLayer): string {
  switch (layer) {
    case "connector_policy":
      return "Adjust the request to satisfy connector policy (confirmation token, write context, or allowed fields), then retry.";
    case "odoo_acl":
      return "Use an Odoo user with the required access rights, or perform the action in the Odoo UI as that user.";
    case "odoo_record_rule":
      return "The authenticated user cannot see or modify this record under Odoo record rules — switch user or adjust rules.";
    case "workflow_state":
      return "Bring the record to a state where Odoo allows this action, then retry.";
    case "lock_date":
      return "Use bookkeeping.plan_safe_write for create_lock_exception (tax/lock ops), or unlock the period in the Odoo UI.";
    case "hash":
      return "Hashed / inalterable entries cannot be changed via the connector — use the Odoo UI / a human for the supported reverse flow.";
    case "schema":
      return "Fix model/method/field names or value types to match the Odoo schema, then retry.";
    case "odoo_validation":
      return "Resolve the Odoo validation error (see details), then retry.";
  }
}
