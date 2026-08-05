/**
 * `get_record` must explain a Waiting project.task, and leave every other model alone.
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { registerReadTools } from "./read";
import { withWaitingAnnotationFields } from "./shared";
import { validatedToolHandler } from "./structured-test-util";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" } as Props;

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
type Call = { model: string; method: string; args: Record<string, unknown> };

function buildHarness(responder: (model: string, method: string, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const call = { model: a[1] as string, method: a[2] as string, args: a[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call.model, call.method, call.args);
  });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, () => props, { enqueue } as unknown as OdooQueue, new TtlCache());
  return { calls, getRecord: validatedToolHandler(server, "get_record") as (a: unknown) => Promise<ToolResult> };
}

describe("withWaitingAnnotationFields", () => {
  test("widens a project.task projection with state + depend_on_ids", () => {
    expect(withWaitingAnnotationFields("project.task", ["id", "name"])).toEqual([
      "id",
      "name",
      "state",
      "depend_on_ids"
    ]);
  });

  test("null resolves the preset and widens it, without duplicates", () => {
    const fields = withWaitingAnnotationFields("project.task", null)!;
    expect(fields).toContain("state");
    expect(fields).toContain("depend_on_ids");
    expect(new Set(fields).size).toBe(fields.length);
  });

  test("other models and the all-fields sentinel pass through untouched", () => {
    expect(withWaitingAnnotationFields("account.move", ["id"])).toEqual(["id"]);
    expect(withWaitingAnnotationFields("account.move", null)).toBeNull();
    expect(withWaitingAnnotationFields("project.task", ["__all__"])).toEqual(["__all__"]);
  });
});

describe("get_record — Waiting annotation", () => {
  test("annotates a Waiting project.task with its open blockers", async () => {
    const { calls, getRecord } = buildHarness((_model, method, args) => {
      if (method === "search_read") {
        return [{ id: 42, name: "Successor", state: "04_waiting_normal", depend_on_ids: [9, 10] }];
      }
      expect(args.ids).toEqual([9, 10]);
      return [
        { id: 9, state: "04_waiting_normal", name: "Also blocked" },
        { id: 10, state: "03_approved", name: "Signed off" }
      ];
    });

    const result = await getRecord({ model: "project.task", record_id: 42 });

    const record = result.structuredContent?.record as Record<string, unknown>;
    expect(record._waiting_derived).toBe(true);
    expect(record._open_blocker_ids).toEqual([9]);
    expect(String(record._waiting_explanation)).toContain("03_approved");
    expect(calls[0].args.fields).toEqual(["id", "name", "stage_id", "project_id", "state", "depend_on_ids"]);
  });

  test("a non-Waiting project.task is not annotated and costs no extra call", async () => {
    const { calls, getRecord } = buildHarness(() => [{ id: 42, name: "Doing", state: "01_in_progress", depend_on_ids: [] }]);

    const result = await getRecord({ model: "project.task", record_id: 42 });

    expect(result.structuredContent?.record).not.toHaveProperty("_waiting_derived");
    expect(calls).toHaveLength(1);
  });

  test("other models are untouched by the guard", async () => {
    const { calls, getRecord } = buildHarness(() => [{ id: 7, name: "Bill", state: "draft" }]);

    const result = await getRecord({ model: "account.move", record_id: 7, fields: ["id", "name", "state"] });

    expect(result.structuredContent?.record).toMatchObject({ id: 7, _workflow_status: "draft" });
    expect(calls[0].args.fields).toEqual(["id", "name", "state"]);
    expect(calls).toHaveLength(1);
  });
});
