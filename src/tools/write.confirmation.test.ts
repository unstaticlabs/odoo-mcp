/**
 * confirmation_token discoverability + kwargs fence (#2261) and delete_record top-level
 * confirmation_token fence for #2260/#2263 (ChatGPT tools/list caching / nested-only bug).
 * call_model_method schema lock + account.move.line.reconcile round-trip for #2295.
 *
 * Asserts published schema shape and that kwargs-only tokens are lifted (not silent no-ops)
 * and stripped before Odoo JSON-2. Also locks that delete_record accepts an optional top-level
 * confirmation_token (not under a nested container) and honours it on irreversible unlink.
 */
import { describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import { issueConfirmationToken, TOKEN_TTL_MS } from "../safety";
import { validatedToolHandler } from "./structured-test-util";
import { buildIrreversibleWritePlan, registerWriteTools, resolveConfirmationFromKwargs } from "./write";

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
    const tools = registeredTools(server);

    for (const name of MUTATING_TOOLS) {
      const schema = tools[name]?.inputSchema;
      expect(schema?.shape.confirmation_token).toBeDefined();

      const json = z.toJSONSchema(z.object(schema.shape));
      expect(json.properties?.confirmation_token).toBeDefined();
      expect(json.required ?? []).not.toContain("confirmation_token");
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

/**
 * ChatGPT repro (#2260): clients that only see tools/list miss a nested-only token.
 * Fence delete_record's optional top-level confirmation_token so removing or nesting it fails CI.
 * Use a non-PM model — PM unlinks are single-shot and would invert this assertion.
 */
const REPRO_MODEL = "account.analytic.account";
const REPRO_ID = 16;

function registeredTools(server: McpServer) {
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        { inputSchema: { shape: Record<string, unknown>; safeParse: (v: unknown) => any } }
      >;
    }
  )._registeredTools;
}

function buildDeleteHandler(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue, () => SECRET);
  return validatedToolHandler(server, "delete_record") as (args: unknown) => Promise<ToolResult>;
}

function buildCallModelMethodHandler(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWriteTools(server, () => props, queue, () => SECRET);
  return validatedToolHandler(server, "call_model_method") as (args: unknown) => Promise<ToolResult>;
}

describe("delete_record top-level confirmation_token fence (#2260/#2263)", () => {
  test("registered inputSchema exposes optional top-level confirmation_token", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerWriteTools(server, () => props, dispatchQueue(() => true).queue, () => SECRET);
    const schema = registeredTools(server).delete_record.inputSchema;

    expect(schema.shape.confirmation_token).toBeDefined();
    // No nested kwargs/values escape hatch today — adding one must update this lock deliberately.
    expect(Object.keys(schema.shape).sort()).toEqual([
      "confirmation_token",
      "context",
      "model",
      "record_id"
    ]);

    expect(schema.safeParse({ model: REPRO_MODEL, record_id: REPRO_ID }).success).toBe(true);

    // Zod strips unknown keys: if confirmation_token left the top-level shape (nested-only),
    // parsed.data.confirmation_token would be undefined — the client-visible #2260 bug.
    const parsed = schema.safeParse({
      model: REPRO_MODEL,
      record_id: REPRO_ID,
      confirmation_token: "tok-abc"
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.confirmation_token).toBe("tok-abc");

    const json = z.toJSONSchema(z.object(schema.shape));
    expect(json.properties?.confirmation_token).toBeDefined();
    expect(json.required ?? []).not.toContain("confirmation_token");
  });

  test("preflight then top-level token round-trip on account.analytic.account", async () => {
    const { queue, calls } = dispatchQueue((call) =>
      call.method === "read" ? [{ id: REPRO_ID }] : true
    );
    const deleteRecord = buildDeleteHandler(queue);

    const preflight = await deleteRecord({
      model: REPRO_MODEL,
      record_id: REPRO_ID,
      context: "cleanup analytic accounts"
    });
    expect(preflight.isError).toBe(true);
    const envelope = envelopeOf(preflight);
    expect(envelope.error).toBe("confirmation_required");
    expect(envelope.confirmation_required).toBe(true);
    expect(envelope.refusing_layer).toBe("connector_policy");
    expect(envelope.risk_class).toBe("destructive");
    expect(typeof envelope.confirmation_token).toBe("string");
    expect(String(envelope.confirmation_token).length).toBeGreaterThan(0);
    expect(String(envelope.next_step)).toContain("top-level");
    expect(envelope.would_execute).toEqual({
      model: REPRO_MODEL,
      method: "unlink",
      ids: [REPRO_ID]
    });
    expect(calls.some((c) => c.method === "unlink")).toBe(false);
    expect(calls).toEqual([]);

    const token = envelope.confirmation_token as string;
    const confirmed = await deleteRecord({
      model: REPRO_MODEL,
      record_id: REPRO_ID,
      context: "cleanup analytic accounts",
      confirmation_token: token
    });
    expect(confirmed.isError).toBeUndefined();
    expect(confirmed.structuredContent?.ok).toBe(true);

    // verifyAfterWrite may append a trailing read — assert unlinks only, not exact calls equality.
    const unlinks = calls.filter((c) => c.method === "unlink");
    expect(unlinks).toHaveLength(1);
    expect(unlinks[0].model).toBe(REPRO_MODEL);
    expect(unlinks[0].args).toEqual({ ids: [REPRO_ID] });
  });

  test("invalid and cross-record tokens refuse without unlink", async () => {
    const { queue, calls } = dispatchQueue((call) =>
      call.method === "read" ? [{ id: REPRO_ID }] : true
    );
    const deleteRecord = buildDeleteHandler(queue);

    const tampered = await deleteRecord({
      model: REPRO_MODEL,
      record_id: REPRO_ID,
      confirmation_token: "not-a-real-token"
    });
    expect(tampered.isError).toBe(true);
    expect(envelopeOf(tampered).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls).toEqual([]);

    const preflight = await deleteRecord({
      model: REPRO_MODEL,
      record_id: REPRO_ID,
      context: "cleanup analytic accounts"
    });
    const token = envelopeOf(preflight).confirmation_token as string;
    expect(calls).toEqual([]);

    const crossRecord = await deleteRecord({
      model: REPRO_MODEL,
      record_id: 17,
      context: "cleanup analytic accounts",
      confirmation_token: token
    });
    expect(crossRecord.isError).toBe(true);
    expect(envelopeOf(crossRecord).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls.some((c) => c.method === "unlink")).toBe(false);
  });
});

/**
 * call_model_method must expose the same optional top-level confirmation_token as delete_record
 * (#2295). Reconcile is the documented high-risk recipe; stale ChatGPT connector caches on older
 * server versions were the reported failure mode, not a missing schema field.
 */
describe("call_model_method top-level confirmation_token fence (#2295)", () => {
  test("registered inputSchema exposes optional top-level confirmation_token", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerWriteTools(server, () => props, dispatchQueue(() => true).queue, () => SECRET);
    const schema = registeredTools(server).call_model_method.inputSchema;

    expect(schema.shape.confirmation_token).toBeDefined();
    expect(Object.keys(schema.shape).sort()).toEqual([
      "args",
      "confirmation_token",
      "context",
      "ids",
      "kwargs",
      "method",
      "model"
    ]);

    expect(schema.safeParse({ model: "account.move.line", method: "reconcile", ids: [5] }).success).toBe(true);

    const parsed = schema.safeParse({
      model: "account.move.line",
      method: "reconcile",
      ids: [5],
      confirmation_token: "tok-abc"
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.confirmation_token).toBe("tok-abc");

    const json = z.toJSONSchema(z.object(schema.shape));
    expect(json.properties?.confirmation_token).toBeDefined();
    expect(json.required ?? []).not.toContain("confirmation_token");

    const deleteJson = z.toJSONSchema(z.object(registeredTools(server).delete_record.inputSchema.shape));
    const callTokenSchema = json.properties?.confirmation_token;
    const deleteTokenSchema = deleteJson.properties?.confirmation_token;
    expect(
      callTokenSchema &&
        typeof callTokenSchema === "object" &&
        "description" in callTokenSchema &&
        deleteTokenSchema &&
        typeof deleteTokenSchema === "object" &&
        "description" in deleteTokenSchema
        ? callTokenSchema.description
        : undefined
    ).toBe(
      deleteTokenSchema &&
        typeof deleteTokenSchema === "object" &&
        "description" in deleteTokenSchema
        ? deleteTokenSchema.description
        : undefined
    );
  });

  test("tools/list advertises optional top-level confirmation_token for call_model_method", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerWriteTools(server, () => props, dispatchQueue(() => true).queue, () => SECRET);
    await server.connect(serverT);

    const client = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientT);

    const tool = (await client.listTools()).tools.find((t) => t.name === "call_model_method");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties?.confirmation_token).toBeDefined();
    expect(tool!.inputSchema.required ?? []).not.toContain("confirmation_token");
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual([
      "args",
      "confirmation_token",
      "context",
      "ids",
      "kwargs",
      "method",
      "model"
    ]);

    await client.close();
    await server.close();
  });
});

/** account.move.line.reconcile — documented caller recipe with top-level confirmation_token (#2295). */
const RECONCILE_MODEL = "account.move.line";
const RECONCILE_IDS = [401, 402];
const RECONCILE_CONTEXT = "reconcile bank line against invoice";

describe("account.move.line.reconcile top-level confirmation (#2295)", () => {
  test("preflight then top-level token round-trip", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const callModelMethod = buildCallModelMethodHandler(queue);

    const preflight = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      context: RECONCILE_CONTEXT
    });
    expect(preflight.isError).toBe(true);
    const envelope = envelopeOf(preflight);
    expect(envelope.error).toBe("confirmation_required");
    expect(envelope.confirmation_required).toBe(true);
    expect(envelope.refusing_layer).toBe("connector_policy");
    expect(envelope.risk_class).toBe("irreversible_payment");
    expect(typeof envelope.confirmation_token).toBe("string");
    expect(String(envelope.confirmation_token).length).toBeGreaterThan(0);
    expect(String(envelope.next_step)).toContain("top-level");
    expect(envelope.would_execute).toEqual({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS
    });
    expect(calls.some((c) => c.method === "reconcile")).toBe(false);

    const token = envelope.confirmation_token as string;
    const confirmed = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      context: RECONCILE_CONTEXT,
      confirmation_token: token
    });
    expect(confirmed.isError).toBeUndefined();

    const reconciles = calls.filter((c) => c.method === "reconcile");
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0].model).toBe(RECONCILE_MODEL);
    expect(reconciles[0].args).not.toHaveProperty("confirmation_token");
    expect(reconciles[0].args.ids).toEqual(RECONCILE_IDS);
  });

  test("round-trip with non-empty kwargs forwards writeoff_vals and strips the token", async () => {
    const kwargs = { writeoff_vals: { account_id: 12 } };
    const { queue, calls } = dispatchQueue(() => true);
    const callModelMethod = buildCallModelMethodHandler(queue);

    const preflight = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      kwargs,
      context: RECONCILE_CONTEXT
    });
    expect(preflight.isError).toBe(true);
    const envelope = envelopeOf(preflight);
    expect(envelope.would_execute).toEqual({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      kwargs
    });
    expect(calls).toEqual([]);

    const confirmed = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      kwargs,
      context: RECONCILE_CONTEXT,
      confirmation_token: envelope.confirmation_token as string
    });
    expect(confirmed.isError).toBeUndefined();

    const reconcile = calls.find((c) => c.method === "reconcile");
    expect(reconcile).toBeDefined();
    expect(reconcile!.args).not.toHaveProperty("confirmation_token");
    expect(reconcile!.args.ids).toEqual(RECONCILE_IDS);
    expect(reconcile!.args.writeoff_vals).toEqual({ account_id: 12 });
  });

  test("invalid, cross-record, mismatched, and expired tokens refuse without reconcile", async () => {
    const { queue, calls } = dispatchQueue(() => true);
    const callModelMethod = buildCallModelMethodHandler(queue);

    const garbage = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      context: RECONCILE_CONTEXT,
      confirmation_token: "not-a-real-token"
    });
    expect(garbage.isError).toBe(true);
    expect(envelopeOf(garbage).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls).toEqual([]);

    const preflight = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: [401],
      context: RECONCILE_CONTEXT
    });
    const token = envelopeOf(preflight).confirmation_token as string;
    expect(calls).toEqual([]);

    const crossRecord = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      context: RECONCILE_CONTEXT,
      confirmation_token: token
    });
    expect(crossRecord.isError).toBe(true);
    expect(envelopeOf(crossRecord).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls.some((c) => c.method === "reconcile")).toBe(false);

    const conflict = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      context: RECONCILE_CONTEXT,
      confirmation_token: "top",
      kwargs: { confirmation_token: "kw" }
    });
    expect(conflict.isError).toBe(true);
    expect(envelopeOf(conflict).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls.some((c) => c.method === "reconcile")).toBe(false);

    const plan = buildIrreversibleWritePlan({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS
    });
    const expiredToken = await issueConfirmationToken(plan, SECRET, Date.now() - TOKEN_TTL_MS - 1000);
    const expired = await callModelMethod({
      model: RECONCILE_MODEL,
      method: "reconcile",
      ids: RECONCILE_IDS,
      context: RECONCILE_CONTEXT,
      confirmation_token: expiredToken
    });
    expect(expired.isError).toBe(true);
    expect(envelopeOf(expired).policy_rule).toBe("irreversible_confirmation_invalid");
    expect(calls.some((c) => c.method === "reconcile")).toBe(false);
  });
});
