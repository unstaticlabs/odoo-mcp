/**
 * confirmation_token discoverability + kwargs fence (#2261).
 *
 * Asserts published schema shape and that kwargs-only tokens are lifted (not silent no-ops)
 * and stripped before Odoo JSON-2.
 */
import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { validatedToolHandler } from "./structured-test-util";
import { registerWriteTools, resolveConfirmationFromKwargs } from "./write";

const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
const SECRET = "test-confirmation-secret";

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
type Call = { model: string; method: string; args: Record<string, unknown> };

function dispatchQueue(responder: (call: Call) => unknown): { queue: OdooQueue; calls: Call[] } {
  const calls: Call[] = [];
  const enqueue = mock(async (...a: unknown[]) => {
    const call = { model: a[1] as string, method: a[2] as string, args: a[3] as Record<string, unknown> };
    calls.push(call);
    return responder(call);
  });
  return { queue: { enqueue } as unknown as OdooQueue, calls };
}

function envelopeOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const MUTATING_TOOLS = [
  "call_model_method",
  "create_record",
  "update_record",
  "batch_update",
  "delete_record"
] as const;

describe("confirmation_token published schema", () => {
  test("every mutating write tool advertises optional top-level confirmation_token", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerWriteTools(server, () => props, dispatchQueue(() => true).queue, () => SECRET);
    const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema: { shape: Record<string, unknown> } }> })
      ._registeredTools;

    for (const name of MUTATING_TOOLS) {
      expect(tools[name]?.inputSchema.shape.confirmation_token).toBeDefined();
    }
  });
});

describe("resolveConfirmationFromKwargs", () => {
  test("lifts kwargs token when top-level is absent and strips the key", () => {
    const resolved = resolveConfirmationFromKwargs({
      model: "account.move",
      method: "action_post",
      ids: [1],
      kwargs: { confirmation_token: "tok-from-kwargs", extra: 1 }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.confirmation_token).toBe("tok-from-kwargs");
    expect(resolved.kwargs).toEqual({ extra: 1 });
    expect("confirmation_token" in resolved.kwargs).toBe(false);
  });

  test("prefers matching top-level and still strips kwargs", () => {
    const resolved = resolveConfirmationFromKwargs({
      model: "account.move",
      method: "action_post",
      confirmation_token: "same",
      kwargs: { confirmation_token: "same" }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.confirmation_token).toBe("same");
    expect(resolved.kwargs).toEqual({});
  });

  test("refuses when top-level and kwargs tokens differ", () => {
    const resolved = resolveConfirmationFromKwargs({
      model: "account.move",
      method: "action_post",
      ids: [3],
      confirmation_token: "top",
      kwargs: { confirmation_token: "kw" }
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    const envelope = envelopeOf(resolved.error as ToolResult);
    expect(envelope.policy_rule).toBe("irreversible_confirmation_invalid");
    expect(envelope.recoverable).toBe(true);
    expect(String(envelope.next_step)).toContain("top-level");
  });

  test("strips non-string kwargs.confirmation_token without lifting", () => {
    const resolved = resolveConfirmationFromKwargs({
      model: "account.move",
      method: "action_post",
      kwargs: { confirmation_token: true, other: "x" }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.confirmation_token).toBeUndefined();
    expect(resolved.kwargs).toEqual({ other: "x" });
  });
});

describe("kwargs confirmation lift on call_model_method", () => {
  test("action_post with token only under kwargs executes and strips it from Odoo body", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerWriteTools(server, () => props, queue, () => SECRET);
    const callModelMethod = validatedToolHandler(server, "call_model_method") as (
      args: unknown
    ) => Promise<ToolResult>;

    const preflight = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      context: "post after correction"
    });
    expect(preflight.isError).toBe(true);
    const token = envelopeOf(preflight).confirmation_token as string;
    expect(typeof token).toBe("string");
    expect(calls).toEqual([]);

    const confirmed = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      context: "post after correction",
      kwargs: { confirmation_token: token }
    });
    expect(confirmed.isError).toBeUndefined();
    const mutate = calls.find((c) => c.method === "action_post");
    expect(mutate).toBeDefined();
    expect(mutate!.args).not.toHaveProperty("confirmation_token");
    expect(mutate!.args.ids).toEqual([1]);
  });

  test("mismatched top-level vs kwargs tokens refuse without calling Odoo", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerWriteTools(server, () => props, queue, () => SECRET);
    const callModelMethod = validatedToolHandler(server, "call_model_method") as (
      args: unknown
    ) => Promise<ToolResult>;

    const result = await callModelMethod({
      model: "account.move",
      method: "action_post",
      ids: [1],
      confirmation_token: "top-token",
      kwargs: { confirmation_token: "other-token" },
      context: "conflict"
    });
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls).toEqual([]);
  });
});
