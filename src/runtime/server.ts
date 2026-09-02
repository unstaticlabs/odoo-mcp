import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";
import { OdooClient } from "../odoo/client.js";
import { loadAgentIdentity } from "../odoo/agent_identity.js";
import { createCapabilityRegistry } from "../capabilities/index.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { RuntimeConfig } from "./config.js";
import {
  createRequestContext,
  principalFromAuthInfo,
  type OdooPrincipal,
  type ProfileName
} from "./context.js";

export interface RuntimeServices {
  client: OdooClient;
  registry: CapabilityRegistry;
}

export function createRuntimeServices(config: RuntimeConfig): RuntimeServices {
  const client = new OdooClient(config.targetConcurrency, config.responseBytes);
  return { client, registry: createCapabilityRegistry(client) };
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
    context.validateAgentIdentity = async (signal) => {
      const identity = await loadAgentIdentity(services.client, context, signal);
      context.agentIdentity = identity;
      return identity;
    };
    await context.validateAgentIdentity(mcpContext.requestInfo?.signal);
    context.availableModules = await services.client.installedModules(context, mcpContext.requestInfo?.signal);
    return services.registry.createServer(context);
  };
}

export function createStdioServerFactory(
  services: RuntimeServices,
  profile: ProfileName,
  principal: OdooPrincipal
) {
  return async () => {
    const context = createRequestContext(profile, principal);
    context.validateAgentIdentity = async (signal) => {
      const identity = await loadAgentIdentity(services.client, context, signal);
      context.agentIdentity = identity;
      return identity;
    };
    await context.validateAgentIdentity();
    context.availableModules = await services.client.installedModules(context);
    return services.registry.createServer(context);
  };
}
