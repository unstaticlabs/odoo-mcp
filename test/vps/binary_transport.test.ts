import { describe, expect, it, vi } from "vitest";
import { MAX_BINARY_REQUEST_BYTES, OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const reconciliation = { targetModel: "ir.attachment", suggestedTool: "odoo_search_records", instructions: "Read native attachment metadata before retry." };
const options = (size: number) => ({ kind: "mutation" as const, reconciliation, requestBinary: { field: "data_base64", byteSize: size } });

describe("server-materialized binary request transport", () => {
  it.each([200 * 1024, 1024 * 1024, MAX_BINARY_REQUEST_BYTES])("transfers %i exact bytes with separately bounded metadata", async size => {
    const bytes = Buffer.alloc(size, 81);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(Buffer.from(body.data_base64, "base64").equals(bytes)).toBe(true);
      expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(4 * Math.ceil(size / 3) + 256 * 1024);
      return Response.json({ id: 7 });
    });
    await new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), "account.move", "attach_source_evidence", {
      ids: [91], data_base64: bytes.toString("base64"), filename: "qa-source.pdf", byte_size: size,
    }, options(size));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic 256 KiB argument limit without the server binary option", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), "account.move", "attach_source_evidence", {
      ids: [91], data_base64: Buffer.alloc(200 * 1024).toString("base64"),
    }, { kind: "mutation", reconciliation })).rejects.toThrow("262144-byte limit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { size: MAX_BINARY_REQUEST_BYTES + 1, data: "AA==" },
    { size: 0, data: "" },
    { size: 1.5, data: "AA==" },
    { size: 1, data: "AAAA" },
    { size: 1, data: "AR==" },
  ])("rejects oversized, malformed or misdeclared bytes before HTTP: $size", async ({ size, data }) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), "account.move", "attach_source_evidence", {
      ids: [91], data_base64: data,
    }, options(size))).rejects.toThrow(/Materialized binary/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let binary transport expand the metadata byte limit", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new OdooClient(8, 1024 * 1024, fetcher).call(requestContext(), "account.move", "attach_source_evidence", {
      ids: [91], data_base64: "AA==", context: { payload: "x".repeat(256 * 1024) },
    }, options(1))).rejects.toThrow("262144-byte limit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains generic key and nesting limits around the binary field", async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = new OdooClient(8, 1024 * 1024, fetcher);
    await expect(client.call(requestContext(), "account.move", "attach_source_evidence", {
      data_base64: "AA==", context: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`qa${i}`, true])),
    }, options(1))).rejects.toThrow("200 object keys");
    let nested: unknown = true;
    for (let i = 0; i < 9; i++) nested = { child: nested };
    await expect(client.call(requestContext(), "account.move", "attach_source_evidence", {
      data_base64: "AA==", context: nested,
    }, options(1))).rejects.toThrow("8 levels");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
