import { describe, expect, test } from "bun:test";
import { classifyRefusingLayer, extractRejectedFields, nextStepForLayer } from "./odoo-diagnostics";
import { OdooError } from "./odoo";

function denied(denialKind: "acl" | "record_rule" | "business_validation" | "irreversible_policy") {
  return new OdooError({
    message: "denied",
    code: "permission_denied",
    httpStatus: 403,
    model: "account.move",
    method: "action_post",
    details: "Odoo denied this request",
    denialKind,
    mutationOutcome: "not_applied"
  });
}

describe("Odoo-authoritative refusal diagnostics", () => {
  test("preserves explicit ACL, record-rule, business-validation, and irreversible-policy layers", () => {
    expect(classifyRefusingLayer(denied("acl"))).toBe("odoo_acl");
    expect(classifyRefusingLayer(denied("record_rule"))).toBe("odoo_record_rule");
    expect(classifyRefusingLayer(denied("business_validation"))).toBe("odoo_validation");
    expect(classifyRefusingLayer(denied("irreversible_policy"))).toBe("odoo_irreversible_policy");
  });

  test("diagnostic guidance never proposes an MCP authorization bypass", () => {
    for (const layer of ["odoo_acl", "odoo_record_rule", "odoo_irreversible_policy"] as const) {
      const guidance = nextStepForLayer(layer);
      expect(guidance).toContain("do not seek an MCP bypass");
    }
  });

  test("does not mislabel an ordinary Odoo ACL message as a record rule", () => {
    const acl = new OdooError({
      message: "denied",
      code: "permission_denied",
      httpStatus: 403,
      model: "documents.document",
      method: "read",
      details: "You are not allowed to access 'Document' records",
      mutationOutcome: "not_applied"
    });
    const recordRule = new OdooError({
      message: "denied",
      code: "permission_denied",
      httpStatus: 403,
      model: "documents.document",
      method: "read",
      details: "Due to security restrictions, you may not access this record",
      mutationOutcome: "not_applied"
    });

    expect(classifyRefusingLayer(acl)).toBe("odoo_acl");
    expect(classifyRefusingLayer(recordRule)).toBe("odoo_record_rule");
  });

  test("extracts confidently named rejected fields without reflecting arbitrary prose", () => {
    expect(extractRejectedFields('Invalid field "bank_account_id" on model "res.partner"')).toEqual([
      "bank_account_id"
    ]);
    expect(extractRejectedFields("A long arbitrary business message with no schema field")).toEqual([]);
  });
});
