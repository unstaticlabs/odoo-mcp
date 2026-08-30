import { OdooClient } from "../odoo/client.js";
import { registerGenericCapabilities } from "./generic.js";
import { CapabilityRegistry } from "./registry.js";

export function createCapabilityRegistry(client: OdooClient): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerGenericCapabilities(registry, client);
  return registry;
}
