import { describe, expect, test } from "bun:test";
import { OdooTargetError, allowLocalHttpFromEnv, normalizeOdooOrigin } from "./odoo-target";

describe("normalizeOdooOrigin", () => {
  test("canonicalizes HTTPS origins", () => {
    expect(normalizeOdooOrigin(" https://ERP.Example.com:443/ ")).toBe("https://erp.example.com");
    expect(normalizeOdooOrigin("https://10.0.0.7:8069/")).toBe("https://10.0.0.7:8069");
  });

  test("allows explicitly enabled loopback HTTP only", () => {
    for (const target of ["http://localhost:8069", "http://127.0.0.1:8069", "http://127.42.3.9", "http://[::1]:8069"]) {
      expect(normalizeOdooOrigin(target, { allowLocalHttp: true })).toBe(new URL(target).origin);
    }
    for (const target of ["http://localhost:8069", "http://10.0.0.7", "http://odoo.internal"]) {
      expect(() => normalizeOdooOrigin(target)).toThrow(OdooTargetError);
    }
    expect(() => normalizeOdooOrigin("http://10.0.0.7", { allowLocalHttp: true })).toThrow(OdooTargetError);
  });

  test("rejects every URL component beyond an origin", () => {
    for (const target of [
      "https://user:pass@odoo.example.com",
      "https://odoo.example.com/web",
      "https://odoo.example.com/?db=secret",
      "https://odoo.example.com/#fragment",
      "ftp://odoo.example.com"
    ]) {
      expect(() => normalizeOdooOrigin(target)).toThrow(OdooTargetError);
    }
  });

  test("rejects the Worker origin after canonicalization", () => {
    expect(() =>
      normalizeOdooOrigin("https://MCP.example.com:443/", { workerOrigin: "https://mcp.example.com/mcp" })
    ).toThrow("must not point to this MCP Worker");
  });
});

test("allowLocalHttpFromEnv is explicit", () => {
  expect(allowLocalHttpFromEnv("1")).toBe(true);
  expect(allowLocalHttpFromEnv("TRUE")).toBe(true);
  expect(allowLocalHttpFromEnv("yes")).toBe(false);
  expect(allowLocalHttpFromEnv(undefined)).toBe(false);
});
