import { describe, expect, it, vi } from "vitest";
import { instrumentCancellation } from "../../src/capabilities/registry.js";
import { requestContext } from "./fixtures.js";

describe("MCP cancellation instrumentation", () => {
  it("emits a content-free event when the request signal is cancelled", () => {
    const events: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      events.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const abort = new AbortController();
    const stop = instrumentCancellation(abort.signal, requestContext(), {
      id: "core.records.search",
      name: "odoo_search_records",
      effect: "read"
    }, Date.now());
    try {
      abort.abort(new Error("test cancellation"));
      const cancellation = JSON.parse(
        events.find((event) => event.includes('"event":"mcp.request.cancelled"'))!.trim()
      ) as Record<string, unknown>;
      expect(cancellation).toMatchObject({
        event: "mcp.request.cancelled",
        request_id: "request-test",
        correlation_id: "correlation-test",
        capability_id: "core.records.search",
        tool_name: "odoo_search_records"
      });
      expect(cancellation).not.toHaveProperty("arguments");
      expect(cancellation).not.toHaveProperty("output");
      expect(cancellation).not.toHaveProperty("reason");
    } finally {
      stop();
      stderr.mockRestore();
    }
  });
});
