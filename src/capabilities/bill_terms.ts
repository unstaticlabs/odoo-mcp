/** Advice only: native permissions and supplied values remain authoritative. */
export const BILL_TERMS_GUIDANCE =
  "account.move.narration contains printable Terms and Conditions for the document. " +
  "Use odoo_add_internal_note for internal accounting commentary in Chatter; " +
  "this write does not add an internal note.";

export function billTermsWarnings(model: string, values: ReadonlyArray<Record<string, unknown>>): string[] {
  return model === "account.move" && values.some((value) => typeof value.narration === "string" && value.narration.trim().length > 0)
    ? [BILL_TERMS_GUIDANCE]
    : [];
}
