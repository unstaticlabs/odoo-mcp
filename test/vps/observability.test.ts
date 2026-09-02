import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { CapabilityRegistry, defineCapability } from "../../src/capabilities/registry.js";
import { OdooClient } from "../../src/odoo/client.js";
import type { AnalyticsRuntimeConfig } from "../../src/runtime/config.js";
import {
  createObservability,
  injectTraceHeaders,
  pseudonymousPrincipal,
  sanitizePostHogEvent,
  traceContextFromHttp,
  withMcpTraceContext
} from "../../src/runtime/observability.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

function readyConfiguration(): AnalyticsRuntimeConfig {
  return {
    status: "ready",
    environment: "test",
    apiKey: "phc_test",
    host: "https://posthog.example",
    pseudonymizationKey: Buffer.alloc(32, 7),
    deploymentId: "test-deployment",
    buildId: "test-build"
  };
}

function capturingPostHog() {
  const posthog = new PostHog("phc_test", {
    host: "https://posthog.example",
    disableGeoip: true,
    enableExceptionAutocapture: false
  });
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(posthog, "capture").mockImplementation((event) => {
    events.push(structuredClone(event) as unknown as Record<string, unknown>);
  });
  closeCallbacks.push(async () => posthog.shutdown(50));
  return { posthog, events };
}

async function connect(server: ReturnType<CapabilityRegistry["createServer"]>) {
  const client = new Client({ name: "codex-test", version: "1.2.3" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("privacy-safe PostHog MCP analytics", () => {
  it("reduces official events to an explicit operational allowlist", () => {
    const secret = "grant-token-and-api-key";
    const event = sanitizePostHogEvent({
      type: "capture",
      event: "$mcp_tool_call",
      distinct_id: "a".repeat(64),
      timestamp: new Date(0).toISOString(),
      properties: {
        $mcp_tool_name: "odoo_search_records",
        $mcp_parameters: { api_key: secret, domain: [["name", "=", "Sensitive partner"]] },
        $mcp_response: { content: secret, record: { name: "Sensitive partner" } },
        $mcp_error_message: `Bearer ${secret}`,
        $mcp_tool_description: secret,
        $mcp_client_user_agent: secret,
        $exception_list: [{ message: secret }],
        unknown_property: secret,
        $mcp_is_error: true,
        $mcp_error_type: "OdooPermissionError",
        $mcp_client_name: "codex",
        $mcp_client_version: "phc_should-never-leave",
        usl_build_id: "build-1",
        usl_capability_id: "core.records.search",
        usl_layer: "generic"
      }
    });
    expect(event).not.toBeNull();
    expect(event?.properties).toMatchObject({
      $mcp_tool_name: "odoo_search_records",
      $mcp_is_error: true,
      $mcp_error_type: "permission_denied",
      usl_build_id: "build-1",
      usl_capability_id: "core.records.search",
      usl_layer: "generic",
      usl_client_family: "codex",
      usl_request_bytes: Buffer.byteLength(JSON.stringify({
        api_key: secret,
        domain: [["name", "=", "Sensitive partner"]]
      })),
      usl_response_bytes: Buffer.byteLength(JSON.stringify({
        content: secret,
        record: { name: "Sensitive partner" }
      }))
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain("phc_should-never-leave");
    expect(sanitizePostHogEvent({
      type: "capture",
      event: "$exception",
      distinct_id: "a".repeat(64),
      timestamp: new Date(0).toISOString(),
      properties: { message: secret }
    })).toBeNull();
    const hostileEvent = new Proxy({} as Parameters<typeof sanitizePostHogEvent>[0], {
      get() {
        throw new Error(secret);
      }
    });
    expect(sanitizePostHogEvent(hostileEvent)).toBeNull();
  });

  it("pseudonymizes credential identities with a separately keyed HMAC", () => {
    const principal = requestContext().principal;
    const first = pseudonymousPrincipal(principal, Buffer.alloc(32, 1));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(pseudonymousPrincipal(principal, Buffer.alloc(32, 1))).toBe(first);
    expect(pseudonymousPrincipal(principal, Buffer.alloc(32, 2))).not.toBe(first);
    expect(first).not.toContain(principal.apiKey);
  });

  it("preserves valid W3C trace context and gives HTTP precedence over MCP metadata", () => {
    const httpTrace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const mcpTrace = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00";
    const fromHttp = traceContextFromHttp(new Headers({
      traceparent: httpTrace,
      tracestate: "vendor=value",
      baggage: "tenant=opaque"
    }));
    expect(fromHttp).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true
    });
    expect(injectTraceHeaders(fromHttp?.context)).toMatchObject({
      traceparent: httpTrace,
      tracestate: "vendor=value",
      baggage: "tenant=opaque"
    });
    const preferred = withMcpTraceContext({ ...requestContext(), trace: fromHttp }, { traceparent: mcpTrace });
    expect(preferred.trace?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    const fallback = withMcpTraceContext(requestContext(), { traceparent: mcpTrace });
    expect(fallback.trace?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(traceContextFromHttp(new Headers({ traceparent: "malformed" }))).toBeUndefined();
  });

  it("propagates MCP request trace metadata to the Odoo adapter", async () => {
    const requests: RequestInit[] = [];
    const odoo = new OdooClient(8, 1024, async (_input, init) => {
      requests.push(init ?? {});
      return Response.json([]);
    });
    const registry = createCapabilityRegistry(odoo);
    const server = registry.createServer(requestContext());
    const client = await connect(server);
    await client.callTool({
      name: "odoo_search_records",
      arguments: {
        model: "res.partner",
        domain: [],
        fields: ["display_name"],
        limit: 1,
        order: "id asc",
        include_count: false,
        context: {}
      },
      _meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value"
      }
    });
    expect(requests).toHaveLength(1);
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    );
    expect(headers.get("tracestate")).toBe("vendor=value");
  });

  it("instruments successes and failures without leaking tool arguments or results", async () => {
    const { posthog, events } = capturingPostHog();
    const observability = createObservability(readyConfiguration(), { posthog });
    closeCallbacks.push(async () => observability.close());
    const registry = new CapabilityRegistry();
    registry.add(defineCapability({
      id: "test.analytics",
      name: "odoo_test_analytics",
      title: "Test analytics",
      description: "Test-only capability.",
      layer: "generic",
      toolsets: ["core"],
      profiles: ["default"],
      effect: "read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      keywords: ["test"],
      requiredModules: [],
      defaultVisible: true,
      alwaysLoad: true,
      sortOrder: 1,
      input: z.object({ fail: z.boolean(), secret: z.string() }).strict(),
      output: z.object({ echoed: z.string() }).strict(),
      async handler({ fail, secret }) {
        if (fail) throw new Error(`Bearer ${secret}`);
        return { data: { echoed: secret } };
      }
    }));
    const context = {
      ...requestContext(),
      eventObserver: observability,
      analyticsPrincipalId: observability.principalId(requestContext().principal)
    };
    const server = registry.createServer(context);
    observability.instrumentServer(server, context, registry.list("default"));
    const client = await connect(server);
    await client.callTool({
      name: "odoo_test_analytics",
      arguments: { fail: false, secret: "successful-secret" }
    });
    await client.callTool({
      name: "odoo_test_analytics",
      arguments: { fail: true, secret: "failed-secret" }
    });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.event === "$mcp_tool_call")).toHaveLength(2);
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("successful-secret");
    expect(serialized).not.toContain("failed-secret");
    expect(serialized).not.toContain("Bearer");
    const calls = events.filter((event) => event.event === "$mcp_tool_call");
    expect(calls.map((event) => (event.properties as Record<string, unknown>).$mcp_is_error))
      .toEqual([false, true]);
    expect(calls[0]?.properties).toMatchObject({
      usl_capability_id: "test.analytics",
      usl_layer: "generic",
      usl_effect: "read",
      usl_toolsets: ["core"]
    });
    const completionEvents = events.filter((event) => event.event === "usl_mcp_tool_completed");
    expect(completionEvents).toHaveLength(2);
    expect(completionEvents[0]?.properties).toMatchObject({
      usl_capability_id: "test.analytics",
      usl_status: "ok",
      usl_request_bytes: Buffer.byteLength(JSON.stringify({
        fail: false,
        secret: "successful-secret"
      })),
      usl_response_bytes: expect.any(Number)
    });
  });

  it("leaves the advertised tool interface unchanged", async () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const plainServer = registry.createServer(requestContext());
    const plainClient = await connect(plainServer);
    const plainTools = await plainClient.listTools();

    const { posthog } = capturingPostHog();
    const observability = createObservability(readyConfiguration(), { posthog });
    closeCallbacks.push(async () => observability.close());
    const context = {
      ...requestContext(),
      eventObserver: observability,
      analyticsPrincipalId: observability.principalId(requestContext().principal)
    };
    const instrumentedServer = registry.createServer(context);
    observability.instrumentServer(instrumentedServer, context, registry.list("default"));
    const instrumentedClient = await connect(instrumentedServer);
    const instrumentedTools = await instrumentedClient.listTools();

    expect(instrumentedTools).toEqual(plainTools);
    const serialized = JSON.stringify(instrumentedTools);
    expect(serialized).not.toContain("conversation_id");
    expect(serialized).not.toContain("llm_model");
    expect(instrumentedTools.tools.map((tool) => tool.name)).not.toContain("get_more_tools");
  });

  it("fails open when disabled, instrumentation fails, or PostHog capture throws", async () => {
    const initializationFailure = Object.defineProperty({ instrumentServer: vi.fn() }, "posthog", {
      get() {
        throw new Error("initialization secret");
      }
    });
    const initializationDegraded = createObservability(
      readyConfiguration(),
      initializationFailure as Parameters<typeof createObservability>[1]
    );
    expect(initializationDegraded.status).toBe("degraded");

    const instrumenter = vi.fn(() => {
      throw new Error("initialization secret");
    });
    const { posthog } = capturingPostHog();
    const degraded = createObservability(readyConfiguration(), {
      posthog,
      instrumentServer: instrumenter
    });
    const registry = createCapabilityRegistry(new OdooClient());
    expect(() => degraded.instrumentServer(
      registry.createServer(requestContext()),
      requestContext(),
      registry.list("default")
    )).not.toThrow();
    expect(degraded.status).toBe("degraded");

    const disabledInstrumenter = vi.fn();
    const disabled = createObservability({ status: "disabled", environment: "test" }, {
      instrumentServer: disabledInstrumenter
    });
    disabled.instrumentServer(
      registry.createServer(requestContext()),
      requestContext(),
      registry.list("default")
    );
    expect(disabledInstrumenter).not.toHaveBeenCalled();

    const shutdownFailure = createObservability(readyConfiguration(), {
      posthog: {
        shutdown: vi.fn().mockRejectedValue(new Error("shutdown secret"))
      } as unknown as PostHog,
      instrumentServer: vi.fn()
    });
    await expect(shutdownFailure.close()).resolves.toBeUndefined();

    const throwingPostHog = capturingPostHog();
    vi.mocked(throwingPostHog.posthog.capture).mockImplementation(() => {
      throw new Error("network secret");
    });
    const observability = createObservability(readyConfiguration(), { posthog: throwingPostHog.posthog });
    const context = {
      ...requestContext(),
      eventObserver: observability,
      analyticsPrincipalId: observability.principalId(requestContext().principal)
    };
    const client = new OdooClient(8, 1024, async () => Response.json([{ id: 1 }]));
    await expect(client.call(context, "res.partner", "search_read", { domain: [] }))
      .resolves.toEqual([{ id: 1 }]);

    const registryWithAnalytics = new CapabilityRegistry();
    registryWithAnalytics.add(defineCapability({
      id: "test.fail_open",
      name: "odoo_test_fail_open",
      title: "Test fail open",
      description: "Test-only capability.",
      layer: "generic",
      toolsets: ["core"],
      profiles: ["default"],
      effect: "read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      keywords: ["test"],
      requiredModules: [],
      defaultVisible: true,
      alwaysLoad: true,
      sortOrder: 1,
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }).strict(),
      async handler() {
        return { data: { ok: true } };
      }
    }));
    const instrumentedContext = {
      ...context,
      analyticsPrincipalId: observability.principalId(context.principal)
    };
    const instrumentedServer = registryWithAnalytics.createServer(instrumentedContext);
    observability.instrumentServer(
      instrumentedServer,
      instrumentedContext,
      registryWithAnalytics.list("default")
    );
    const instrumentedClient = await connect(instrumentedServer);
    const result = await instrumentedClient.callTool({ name: "odoo_test_fail_open", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { ok: true } });
  });

  it("records retry attempts without model names, methods, credentials, or payloads", async () => {
    const { posthog, events } = capturingPostHog();
    const observability = createObservability(readyConfiguration(), { posthog });
    closeCallbacks.push(async () => observability.close());
    let attempts = 0;
    const client = new OdooClient(8, 1024, async () => {
      attempts++;
      return attempts === 1
        ? Response.json({ error: { message: "busy with private record" } }, { status: 503 })
        : Response.json([{ id: 1 }]);
    });
    const context = {
      ...requestContext(),
      eventObserver: observability,
      analyticsPrincipalId: observability.principalId(requestContext().principal)
    };
    await client.call(context, "res.partner", "search_read", {
      domain: [["name", "=", "Sensitive partner"]]
    });
    const calls = events.filter((event) => event.event === "usl_odoo_call_completed");
    expect(calls).toHaveLength(2);
    expect(calls.map((event) => (event.properties as Record<string, unknown>).usl_attempt)).toEqual([1, 2]);
    expect(calls.map((event) => (event.properties as Record<string, unknown>).usl_status))
      .toEqual(["odoo_server_error", "ok"]);
    expect(calls.map((event) => ({
      retry: (event.properties as Record<string, unknown>).usl_retry,
      willRetry: (event.properties as Record<string, unknown>).usl_will_retry
    }))).toEqual([
      { retry: false, willRetry: true },
      { retry: true, willRetry: false }
    ]);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("res.partner");
    expect(serialized).not.toContain("search_read");
    expect(serialized).not.toContain("Sensitive partner");
    expect(serialized).not.toContain("test-key");
  });
});
