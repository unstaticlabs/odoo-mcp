import { OdooError, normalizeOdooDetails } from "./odoo";

export type RefusingLayer =
  | "odoo_acl"
  | "odoo_record_rule"
  | "odoo_irreversible_policy"
  | "workflow_state"
  | "lock_date"
  | "hash"
  | "schema"
  | "odoo_validation"
  | "transport";

/** Diagnose which Odoo or transport layer refused a request without inventing connector policy. */
export function classifyRefusingLayer(error: unknown): RefusingLayer {
  if (!(error instanceof OdooError)) return "transport";
  if (error.denialKind === "acl") return "odoo_acl";
  if (error.denialKind === "record_rule") return "odoo_record_rule";
  if (error.denialKind === "irreversible_policy") return "odoo_irreversible_policy";
  if (error.denialKind === "business_validation") return "odoo_validation";

  const details = normalizeOdooDetails(error.details);
  if (error.code === "permission_denied" || error.httpStatus === 403) {
    return details.includes("record rule") || details.includes("due to security restrictions")
      ? "odoo_record_rule"
      : "odoo_acl";
  }
  if (error.code === "unauthorized" || error.httpStatus === 401) return "odoo_acl";
  if (details.includes("hashed") || details.includes("inalterable") || details.includes("hash integrity") || details.includes("secure entries")) {
    return "hash";
  }
  if (details.includes("lock date") || details.includes("locked period") || details.includes("tax lock") || details.includes("fiscal year") || /lock(_|\s)?date/.test(details)) {
    return "lock_date";
  }
  if (details.includes("state") || details.includes("cannot be modified") || details.includes("only draft") || details.includes("already posted") || details.includes("not allowed in state") || details.includes("invalid transition")) {
    return "workflow_state";
  }
  if (error.code === "model_or_method_not_found" || error.code === "invalid_request" || details.includes("invalid field") || details.includes("unknown field") || details.includes("does not exist") || details.includes("wrong values")) {
    return "schema";
  }
  return "odoo_validation";
}

const REJECTED_FIELD_PATTERNS: readonly RegExp[] = [
  /(?:invalid|unknown) (?:field|value for field) ['"`]([a-z_][a-z0-9_.]*)['"`]/gi,
  /access the field ['"`]([a-z_][a-z0-9_.]*)['"`]/gi,
  /(?:invalid|unknown) field ([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+)/gi,
  /(?:field|column) ['"`]([a-z_][a-z0-9_.]*)['"`] (?:does not exist|is not a valid field|of relation)/gi,
  /wrong value for ['"`]?([a-z_][a-z0-9_.]*)['"`]?\s*:/gi,
  /null value in column ['"`]([a-z_][a-z0-9_]*)['"`]/gi
];

export function extractRejectedFields(details: string): string[] {
  if (!details) return [];
  const normalized = normalizeOdooDetails(details);
  const found = new Set<string>();
  for (const pattern of REJECTED_FIELD_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const raw = match[1];
      const field = raw?.replace(/\.$/, "").split(".").pop();
      if (field && /^[a-z_][a-z0-9_]*$/.test(field)) found.add(field);
    }
  }
  return [...found];
}

export function nextStepForLayer(layer: RefusingLayer): string {
  switch (layer) {
    case "odoo_acl":
      return "Odoo denied this identity's access. Accept the denial or ask an Odoo administrator to review the user's rights; do not seek an MCP bypass.";
    case "odoo_record_rule":
      return "Odoo record rules hide or protect this record. Accept the denial or ask an Odoo administrator to review the rule; do not seek an MCP bypass.";
    case "odoo_irreversible_policy":
      return "Odoo's irreversible-action policy denied the action. Accept the denial; do not seek an MCP bypass.";
    case "workflow_state":
      return "Use Odoo's supported workflow to place the record in a compatible state, then retry the same logical operation if appropriate.";
    case "lock_date":
      return "Odoo's accounting lock rejected the operation. Resolve the lock through authorized Odoo policy, then retry if appropriate.";
    case "hash":
      return "Odoo protects this inalterable or hashed evidence. Use an Odoo-supported reversal or correction workflow.";
    case "schema":
      return "Discover the model's current fields and public method signature, then correct the request.";
    case "odoo_validation":
      return "Resolve the Odoo business validation error shown in details, then retry if appropriate.";
    case "transport":
      return "Check the Odoo connection and transport diagnostics. For mutation outcome_unknown, reconcile before retrying.";
  }
}
