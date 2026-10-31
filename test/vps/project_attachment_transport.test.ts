import { describe, expect, it, vi } from "vitest";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const reconciliation = {
  targetModel: "ir.attachment", suggestedTool: "odoo_search_records",
  instructions: "Read native attachment metadata before retrying."
};
const uploadOptions = { kind: "mutation" as const, reconciliation, requestBudget: "project_attachment" as const };

describe("project attachment request budget", () => {
  it("keeps the generic 256 KiB limit for ordinary attachment creates", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), "ir.attachment", "create", {
      vals_list: [{ raw: Buffer.alloc(200 * 1024).toString("base64") }]
    }, { kind: "mutation", reconciliation })).rejects.toThrow("262144-byte limit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([["project.task", "create"], ["ir.attachment", "write"]])(
    "does not expand %s.%s requests", async (model, method) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), model!, method!, {
        vals_list: [{ name: "Synthetic" }]
      }, uploadOptions)).rejects.toThrow("only available for ir.attachment.create");
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it("retains a finite 768 KiB upload envelope limit", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), "ir.attachment", "create", {
      vals_list: [{ raw: "x".repeat(768 * 1024) }]
    }, uploadOptions)).rejects.toThrow("786432-byte limit");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
