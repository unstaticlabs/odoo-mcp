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

export function createHttpServerFactory(registry: CapabilityRegistry, profile: ProfileName) {
  return (mcpContext: McpRequestContext) => {
    const principal = principalFromAuthInfo(mcpContext.authInfo);
    return registry.createServer(createRequestContext(profile, principal, mcpContext.authInfo));
  };
}

export function createStdioServerFactory(
  registry: CapabilityRegistry,
  profile: ProfileName,
  principal: OdooPrincipal
) {
  return () => registry.createServer(createRequestContext(profile, principal));
}
