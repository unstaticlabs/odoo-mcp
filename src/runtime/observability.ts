import { createHmac } from "node:crypto";
import {
  ROOT_CONTEXT,
  isSpanContextValid,
  trace,
  type Context as OpenTelemetryContext,
  type TextMapGetter,
  type TextMapSetter
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator
} from "@opentelemetry/core";
import {
  getRequestHeaders,
  instrument,
  type BeforeSendFn,
  type MCPAnalyticsOptions
} from "@posthog/mcp";
import { PostHog } from "posthog-node";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CapabilityMetadata } from "../capabilities/registry.js";
import { SERVER_VERSION } from "../version.js";
import type { AnalyticsRuntimeConfig, AnalyticsStatus } from "./config.js";
import type { OdooPrincipal, RequestContext, TraceContext } from "./context.js";
import {
  emitEvent,
  type EventDimensions,
  type EventName,
  type RuntimeEventObserver
} from "./logging.js";

type PostHogCaptureEvent = Parameters<BeforeSendFn>[0];
type InstrumentServer = typeof instrument;

const propagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
});
const carrierGetter: TextMapGetter<Record<string, string>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key]
};
const carrierSetter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  }
};
const TRACE_LIMITS: Record<string, number> = {
  traceparent: 256,
  tracestate: 512,
  baggage: 8192
};
const SAFE_MCP_EVENTS = new Set(["$mcp_initialize", "$mcp_tool_call", "$mcp_tools_list"]);
const SAFE_ERROR_CLASSES = new Set([
  "cancelled",
  "invalid_request",
  "model_or_method_not_found",
  "network_error",
  "odoo_server_error",
  "payload_too_large",
  "permission_denied",
  "rate_limited",
  "timeout",
  "tool_error",
  "unauthorized",
  "unknown",
  "validation"
]);
const SAFE_CUSTOM_STATUSES = new Set([
  "cancelled",
  "invalid_request",
  "model_or_method_not_found",
  "network_error",
  "odoo_server_error",
  "ok",
  "payload_too_large",
  "permission_denied",
  "rate_limited",
  "timeout",
  "unauthorized",
  "unknown"
]);

interface CompatibleExtra {
  mcpReq?: { _meta?: unknown; envelope?: unknown };
}

interface MCPRequestLike {
  params?: { name?: string; _meta?: unknown };
}

export interface Observability extends RuntimeEventObserver {
  readonly status: AnalyticsStatus;
  principalId(principal: OdooPrincipal): string | undefined;
  instrumentServer(
    server: McpServer,
    context: RequestContext,
    capabilities: readonly CapabilityMetadata[]
  ): void;
  close(): Promise<void>;
}

export interface ObservabilityDependencies {
  posthog?: PostHog;
  instrumentServer?: InstrumentServer;
}

function boundedCarrierValue(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function traceCarrierFromHeaders(headers: Headers | undefined): Record<string, string> {
  const carrier: Record<string, string> = {};
  if (!headers) return carrier;
  for (const [name, maximum] of Object.entries(TRACE_LIMITS)) {
    const value = boundedCarrierValue(headers.get(name), maximum);
    if (value) carrier[name] = value;
  }
  return carrier;
}

function traceCarrierFromMetadata(sources: readonly unknown[]): Record<string, string> {
  const carrier: Record<string, string> = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const record = source as Record<string, unknown>;
    for (const [name, maximum] of Object.entries(TRACE_LIMITS)) {
      if (carrier[name]) continue;
      const value = boundedCarrierValue(record[name], maximum);
      if (value) carrier[name] = value;
    }
  }
  return carrier;
}

function traceContextFromCarrier(carrier: Record<string, string>): TraceContext | undefined {
  if (!carrier.traceparent) return undefined;
  const context = propagator.extract(ROOT_CONTEXT, carrier, carrierGetter);
  const span = trace.getSpanContext(context);
  if (!span || !isSpanContextValid(span)) return undefined;
  return {
    context,
    traceId: span.traceId,
    spanId: span.spanId,
    sampled: (span.traceFlags & 1) === 1
  };
}

export function traceContextFromHttp(headers: Headers | undefined): TraceContext | undefined {
  return traceContextFromCarrier(traceCarrierFromHeaders(headers));
}

export function withMcpTraceContext(
  context: RequestContext,
  ...metadataSources: readonly unknown[]
): RequestContext {
  if (context.trace) return context;
  const extracted = traceContextFromCarrier(traceCarrierFromMetadata(metadataSources));
  return extracted ? { ...context, trace: extracted } : context;
}

export function injectTraceHeaders(context: OpenTelemetryContext | undefined): Record<string, string> {
  if (!context) return {};
  const carrier: Record<string, string> = {};
  propagator.inject(context, carrier, carrierSetter);
  return carrier;
}

export function pseudonymousPrincipal(principal: OdooPrincipal, key: Buffer): string {
  return createHmac("sha256", key)
    .update("usl-odoo-mcp-principal-v1\0")
    .update(principal.targetId)
    .update("\0")
    .update(principal.database)
    .update("\0")
    .update(principal.apiKey)
    .digest("hex");
}

function serializedBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function safeString(value: unknown, maximum = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(trimmed)
    ? trimmed
    : undefined;
}

function safeIdentifier(value: unknown, maximum = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : undefined;
}

function safeHexIdentifier(value: unknown, length: number): string | undefined {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
    ? value
    : undefined;
}

function safeClientLabel(value: unknown): string | undefined {
  const label = safeString(value, 64);
  if (!label) return undefined;
  if (/^(?:bearer|ph[csx]_)/i.test(label) || /(?:api[_-]?key|password|secret|token)/i.test(label)) {
    return undefined;
  }
  return label;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizedErrorClass(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/^ODOO_/i, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (SAFE_ERROR_CLASSES.has(normalized)) return normalized;
  if (normalized.includes("permission") || normalized.includes("forbidden")) return "permission_denied";
  if (normalized.includes("validation") || normalized.includes("invalid")) return "validation";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("network")) return "network_error";
  if (normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("tool") || normalized.includes("result")) return "tool_error";
  return "unknown";
}

function clientFamily(value: unknown): "chatgpt" | "claude" | "codex" | "other" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const client = value.toLowerCase();
  if (client.includes("codex")) return "codex";
  if (client.includes("claude")) return "claude";
  if (client.includes("chatgpt") || client.includes("openai")) return "chatgpt";
  return "other";
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  name: string,
  maximum = 128
): void {
  const value = safeString(source[name], maximum);
  if (value) target[name] = value;
}

function copyIdentifier(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  name: string,
  maximum = 128
): void {
  const value = safeIdentifier(source[name], maximum);
  if (value) target[name] = value;
}

function filterPostHogEvent(event: PostHogCaptureEvent): PostHogCaptureEvent | null {
  if (!SAFE_MCP_EVENTS.has(event.event)) return null;
  const source = event.properties ?? {};
  const properties: Record<string, unknown> = {
    "$process_person_profile": false,
    "$geoip_disable": true
  };
  for (const name of [
    "$mcp_source",
    "$mcp_protocol_version",
    "$mcp_server_name",
    "$mcp_server_version"
  ]) copyString(source, properties, name);
  if (event.event !== "$mcp_tool_call" || safeIdentifier(source.usl_capability_id)) {
    copyIdentifier(source, properties, "$mcp_tool_name", 64);
  }
  for (const name of ["$mcp_client_name", "$mcp_client_version"]) {
    const value = safeClientLabel(source[name]);
    if (value) properties[name] = value;
  }
  const sessionId = safeIdentifier(source.$session_id);
  if (sessionId?.startsWith("ses_")) properties.$session_id = sessionId;

  const duration = safeNumber(source.$mcp_duration_ms);
  if (duration !== undefined) properties.$mcp_duration_ms = duration;
  const isError = safeBoolean(source.$mcp_is_error);
  if (isError !== undefined) properties.$mcp_is_error = isError;
  const errorClass = normalizedErrorClass(source.$mcp_error_type);
  if (errorClass) properties.$mcp_error_type = errorClass;

  if (Array.isArray(source.$mcp_listed_tool_names)) {
    properties.$mcp_listed_tool_names = source.$mcp_listed_tool_names
      .map((name) => safeIdentifier(name, 64))
      .filter((name): name is string => Boolean(name))
      .slice(0, 100);
  }
  const requestBytes = serializedBytes(source.$mcp_parameters);
  const responseBytes = serializedBytes(source.$mcp_response);
  if (requestBytes !== undefined) properties.usl_request_bytes = requestBytes;
  if (responseBytes !== undefined) properties.usl_response_bytes = responseBytes;

  for (const name of [
    "usl_build_id",
    "usl_capability_id",
    "usl_correlation_id",
    "usl_deployment_id",
    "usl_effect",
    "usl_environment",
    "usl_event_schema",
    "usl_layer",
    "usl_profile",
    "usl_request_id",
    "usl_server_version"
  ]) copyIdentifier(source, properties, name);
  const principalId = safeHexIdentifier(source.usl_principal_id, 64);
  if (principalId) properties.usl_principal_id = principalId;
  const traceId = safeHexIdentifier(source.usl_trace_id, 32);
  if (traceId) properties.usl_trace_id = traceId;
  const parentSpanId = safeHexIdentifier(source.usl_parent_span_id, 16);
  if (parentSpanId) properties.usl_parent_span_id = parentSpanId;
  if (Array.isArray(source.usl_toolsets)) {
    properties.usl_toolsets = source.usl_toolsets
      .map((value) => safeIdentifier(value, 64))
      .filter((value): value is string => Boolean(value))
      .slice(0, 20);
  }
  const sampled = safeBoolean(source.usl_trace_sampled);
  if (sampled !== undefined) properties.usl_trace_sampled = sampled;
  properties.usl_client_family = clientFamily(properties.$mcp_client_name);

  const distinctId = safeHexIdentifier(event.distinct_id, 64) ?? "anonymous";
  return { ...event, distinct_id: distinctId, properties };
}

export function sanitizePostHogEvent(event: PostHogCaptureEvent): PostHogCaptureEvent | null {
  try {
    return filterPostHogEvent(event);
  } catch {
    return null;
  }
}

function requestToolName(request: MCPRequestLike): string | undefined {
  return safeIdentifier(request.params?.name, 64);
}

function requestMetadata(request: MCPRequestLike): unknown {
  const params = request.params as Record<string, unknown> | undefined;
  return params?._meta;
}

function traceForAnalytics(
  request: MCPRequestLike,
  extra: CompatibleExtra | undefined,
  base: TraceContext | undefined
): TraceContext | undefined {
  if (base) return base;
  const headers = getRequestHeaders(extra);
  const normalizedHeaders = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") normalizedHeaders.set(name, value);
    else if (Array.isArray(value)) normalizedHeaders.set(name, value.join(","));
  }
  const fromHeaders = headers
    ? traceContextFromCarrier(traceCarrierFromHeaders(normalizedHeaders))
    : undefined;
  return fromHeaders ?? traceContextFromCarrier(traceCarrierFromMetadata([
    requestMetadata(request),
    extra?.mcpReq?._meta,
    extra?.mcpReq?.envelope
  ]));
}

class PostHogObservability implements Observability {
  private readonly posthog?: PostHog;
  private readonly instrumenter: InstrumentServer;
  private currentStatus: AnalyticsStatus;
  private closed = false;

  constructor(
    private readonly config: AnalyticsRuntimeConfig,
    dependencies: ObservabilityDependencies
  ) {
    this.currentStatus = config.status;
    this.instrumenter = dependencies.instrumentServer ?? instrument;
    if (config.status === "degraded") {
      emitEvent("analytics.configuration", {
        status: "degraded",
        missing_configuration: config.missingConfiguration?.join(",")
      });
      return;
    }
    if (config.status !== "ready") return;
    try {
      this.posthog = dependencies.posthog ?? new PostHog(config.apiKey!, {
        host: config.host!,
        disableGeoip: true,
        enableExceptionAutocapture: false,
        privacyMode: true,
        flushAt: 20,
        flushInterval: 10_000,
        maxQueueSize: 1_000
      });
    } catch {
      this.currentStatus = "degraded";
      emitEvent("analytics.configuration", { status: "degraded", reason: "initialization_failed" });
    }
  }

  get status(): AnalyticsStatus {
    return this.currentStatus;
  }

  principalId(principal: OdooPrincipal): string | undefined {
    if (this.currentStatus !== "ready" || !this.config.pseudonymizationKey) return undefined;
    return pseudonymousPrincipal(principal, this.config.pseudonymizationKey);
  }

  instrumentServer(
    server: McpServer,
    context: RequestContext,
    capabilities: readonly CapabilityMetadata[]
  ): void {
    if (this.currentStatus !== "ready" || !this.posthog) return;
    const principalId = context.analyticsPrincipalId ?? this.principalId(context.principal);
    if (!principalId) return;
    const capabilityByName = new Map(capabilities.map((capability) => [capability.name, capability]));
    const common = {
      usl_event_schema: "1",
      usl_environment: this.config.environment,
      usl_deployment_id: this.config.deploymentId!,
      usl_build_id: this.config.buildId!,
      usl_server_version: SERVER_VERSION,
      usl_profile: context.profile,
      usl_request_id: context.requestId,
      usl_correlation_id: context.correlationId,
      usl_principal_id: principalId
    };
    const options: MCPAnalyticsOptions = {
      context: false,
      enableConversationId: false,
      captureModel: false,
      reportMissing: false,
      enableExceptionAutocapture: false,
      identify: { distinctId: principalId },
      logger: () => undefined,
      eventProperties: (request, extra) => {
        const properties: Record<string, unknown> = { ...common };
        const capability = capabilityByName.get(requestToolName(request) ?? "");
        if (capability) {
          properties.usl_capability_id = capability.id;
          properties.usl_layer = capability.layer;
          properties.usl_effect = capability.effect;
          properties.usl_toolsets = [...capability.toolsets];
        }
        const activeTrace = traceForAnalytics(request, extra as CompatibleExtra | undefined, context.trace);
        if (activeTrace) {
          properties.usl_trace_id = activeTrace.traceId;
          properties.usl_parent_span_id = activeTrace.spanId;
          properties.usl_trace_sampled = activeTrace.sampled;
        }
        return properties;
      },
      beforeSend: sanitizePostHogEvent
    };
    try {
      this.instrumenter(server, this.posthog, options);
    } catch {
      this.currentStatus = "degraded";
      emitEvent("analytics.configuration", { status: "degraded", reason: "instrumentation_failed" });
    }
  }

  captureRuntimeEvent(event: EventName, dimensions: EventDimensions): void {
    if (this.currentStatus !== "ready" || !this.posthog || this.closed) return;
    const common: Record<string, unknown> = {
      usl_event_schema: "1",
      usl_environment: this.config.environment,
      usl_deployment_id: this.config.deploymentId,
      usl_build_id: this.config.buildId,
      usl_server_version: SERVER_VERSION,
      "$process_person_profile": false,
      "$geoip_disable": true
    };
    for (const name of ["request_id", "correlation_id", "profile", "trace_id", "parent_span_id"]) {
      const value = safeIdentifier(dimensions[name]);
      if (value) common[`usl_${name}`] = value;
    }
    if (typeof dimensions.trace_sampled === "boolean") common.usl_trace_sampled = dimensions.trace_sampled;
    const principalId = safeIdentifier(dimensions.principal_id) ?? `server_${this.config.deploymentId}`;
    let eventName: string | undefined;
    const properties: Record<string, unknown> = { ...common };

    if (event === "odoo.call.completed") {
      eventName = "usl_odoo_call_completed";
      const effect = safeIdentifier(dimensions.effect, 32);
      if (effect) properties.usl_effect = effect;
      const attempt = safeNumber(dimensions.attempt);
      if (attempt !== undefined) properties.usl_attempt = attempt;
      const retry = safeBoolean(dimensions.retry);
      if (retry !== undefined) properties.usl_retry = retry;
      const willRetry = safeBoolean(dimensions.will_retry);
      if (willRetry !== undefined) properties.usl_will_retry = willRetry;
      const status = typeof dimensions.status === "string" && SAFE_CUSTOM_STATUSES.has(dimensions.status)
        ? dimensions.status
        : "unknown";
      properties.usl_status = status;
      for (const name of ["duration_ms", "request_bytes", "response_bytes"]) {
        const value = safeNumber(dimensions[name]);
        if (value !== undefined) properties[`usl_${name}`] = value;
      }
    } else if (event === "mcp.request.completed") {
      eventName = "usl_mcp_request_completed";
      const status = typeof dimensions.status === "number"
        ? dimensions.status
        : safeIdentifier(dimensions.status, 32) ?? "unknown";
      properties.usl_status = status;
      const duration = safeNumber(dimensions.duration_ms);
      if (duration !== undefined) properties.usl_duration_ms = duration;
    } else if (event === "mcp.tool.completed") {
      eventName = "usl_mcp_tool_completed";
      for (const name of ["capability_id", "tool_name", "effect", "layer"]) {
        const value = safeIdentifier(dimensions[name]);
        if (value) properties[`usl_${name}`] = value;
      }
      if (typeof dimensions.toolsets === "string") {
        properties.usl_toolsets = dimensions.toolsets
          .split(",")
          .map((value) => safeIdentifier(value, 64))
          .filter((value): value is string => Boolean(value))
          .slice(0, 20);
      }
      properties.usl_status = normalizedErrorClass(dimensions.status) ?? "unknown";
      if (dimensions.status === "ok") properties.usl_status = "ok";
      for (const name of ["duration_ms", "request_bytes", "response_bytes"]) {
        const value = safeNumber(dimensions[name]);
        if (value !== undefined) properties[`usl_${name}`] = value;
      }
    } else if (event === "mcp.request.cancelled") {
      eventName = "usl_mcp_request_cancelled";
      for (const name of ["capability_id", "tool_name", "effect"]) {
        const value = safeIdentifier(dimensions[name]);
        if (value) properties[`usl_${name}`] = value;
      }
      const duration = safeNumber(dimensions.duration_ms);
      if (duration !== undefined) properties.usl_duration_ms = duration;
    } else if (event === "agent.snapshot.refresh") {
      eventName = "usl_agent_snapshot_refresh";
      for (const name of ["reason", "status"]) {
        const value = safeIdentifier(dimensions[name], 32);
        if (value) properties[`usl_${name}`] = value;
      }
      for (const name of ["queue_delay_ms", "duration_ms", "snapshot_age_ms"]) {
        const value = safeNumber(dimensions[name]);
        if (value !== undefined) properties[`usl_${name}`] = value;
      }
      const visibilityChanged = safeBoolean(dimensions.visibility_changed);
      if (visibilityChanged !== undefined) properties.usl_visibility_changed = visibilityChanged;
    }
    if (!eventName) return;
    try {
      this.posthog.capture({ distinctId: principalId, event: eventName, properties });
    } catch {
      // PostHog is an optional sink; capture failures never affect requests.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.posthog) return;
    try {
      await this.posthog.shutdown(2_000);
    } catch {
      // A bounded analytics flush is best effort during process shutdown.
    }
  }
}

export function createObservability(
  config: AnalyticsRuntimeConfig,
  dependencies: ObservabilityDependencies = {}
): Observability {
  return new PostHogObservability(config, dependencies);
}
