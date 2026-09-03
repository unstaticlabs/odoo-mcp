import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";
import { OdooClient } from "../odoo/client.js";
import { createCapabilityRegistry } from "../capabilities/index.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { AgentAccessSnapshotCache, type AgentAccessSnapshot } from "./agent_access_cache.js";
import type { RuntimeConfig } from "./config.js";
import {
  createRequestContext,
  principalFromAuthInfo,
  type OdooPrincipal,
  type ProfileName
} from "./context.js";
import { createObservability, traceContextFromHttp, type Observability } from "./observability.js";

export interface RuntimeServices {
  client: OdooClient;
  registry: CapabilityRegistry;
  enabledFeatures: ReadonlySet<string>;
  observability: Observability;
  accessCache: AgentAccessSnapshotCache;
}

export function createRuntimeServices(config: RuntimeConfig): RuntimeServices {
  const observability = createObservability(config.analytics);
  const client = new OdooClient(config.targetConcurrency, config.responseBytes);
  const enabledFeatures = new Set(
    config.documentMaterializationEnabled ? ["document_materialization"] : []
  );
  return {
    client,
    registry: createCapabilityRegistry(client),
    enabledFeatures,
    observability,
    accessCache: new AgentAccessSnapshotCache(client, {
      maximumStaleMs: config.accessSnapshotMaxStaleMs,
      refreshTimeoutMs: config.accessRefreshTimeoutMs
    })
  };
}

function applySnapshot(context: ReturnType<typeof createRequestContext>, snapshot: AgentAccessSnapshot): void {
  context.agentIdentity = snapshot.identity;
  context.availableModules = snapshot.surface?.modules ?? null;
  context.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
  context.availableModelAccess = snapshot.surface?.modelAccess ?? null;
}

export function directAuthInfo(
  principal: OdooPrincipal,
  requestId: string = crypto.randomUUID(),
  correlationId: string = crypto.randomUUID()
): AuthInfo {
  return {
    token: "direct-odoo-credentials",
    clientId: "direct",
    scopes: ["odoo"],
    extra: { odoo: principal, requestId, correlationId }
  };
}

export function createHttpServerFactory(services: RuntimeServices, profile: ProfileName) {
  return async (mcpContext: McpRequestContext) => {
    const principal = principalFromAuthInfo(mcpContext.authInfo);
    const context = createRequestContext(profile, principal, mcpContext.authInfo);
    context.eventObserver = services.observability;
    context.analyticsPrincipalId = services.observability.principalId(principal);
    context.trace = traceContextFromHttp(mcpContext.requestInfo?.headers);
    applySnapshot(context, services.accessCache.get(principal));
    context.touchAgentAccess = () => services.accessCache.touch(context);
    context.noteAgentAccessFailure = (error) => services.accessCache.noteAccessFailure(context, error);
    context.enabledFeatures = services.enabledFeatures;
    const server = services.registry.createServer(context);
    services.observability.instrumentServer(
      server,
      context,
      services.registry.list(profile, {
        modules: context.availableModules,
        publicMethods: context.availablePublicMethods,
        modelAccess: context.availableModelAccess,
        enabledFeatures: context.enabledFeatures,
      })
    );
    return server;
  };
}

export function createStdioServerFactory(
  services: RuntimeServices,
  profile: ProfileName,
  principal: OdooPrincipal
) {
  return async () => {
    const context = createRequestContext(profile, principal);
    context.eventObserver = services.observability;
    context.analyticsPrincipalId = services.observability.principalId(principal);
    const snapshot = await services.accessCache.initialize(context);
    applySnapshot(context, snapshot);
    context.touchAgentAccess = () => services.accessCache.touch(context);
    context.noteAgentAccessFailure = (error) => services.accessCache.noteAccessFailure(context, error);
    context.enabledFeatures = services.enabledFeatures;
    const server = services.registry.createServer(context, {
      dynamic: true,
      subscribe: (listener) => {
        services.accessCache.subscribe(principal, listener);
      }
    });
    services.observability.instrumentServer(
      server,
      context,
      services.registry.list(profile, {
        modules: context.availableModules,
        publicMethods: context.availablePublicMethods,
        modelAccess: context.availableModelAccess,
        enabledFeatures: context.enabledFeatures,
      })
    );
    return server;
  };
}
