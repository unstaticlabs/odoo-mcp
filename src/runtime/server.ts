import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";
import { OdooClient } from "../odoo/client.js";
import { createCapabilityRegistry } from "../capabilities/index.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
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
  observability: Observability;
}

export function createRuntimeServices(config: RuntimeConfig): RuntimeServices {
  const observability = createObservability(config.analytics);
  const client = new OdooClient(config.targetConcurrency, config.responseBytes);
  return { client, registry: createCapabilityRegistry(client), observability };
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
    context.availableModules = await services.client.installedModules(context, mcpContext.requestInfo?.signal);
    const server = services.registry.createServer(context);
    services.observability.instrumentServer(
      server,
      context,
      services.registry.list(profile, context.availableModules)
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
    context.availableModules = await services.client.installedModules(context);
    const server = services.registry.createServer(context);
    services.observability.instrumentServer(
      server,
      context,
      services.registry.list(profile, context.availableModules)
    );
    return server;
  };
}
