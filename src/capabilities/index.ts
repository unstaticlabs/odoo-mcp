import { OdooClient } from "../odoo/client.js";
import { registerAccountingCapabilities } from "./accounting.js";
import { registerGenericCapabilities } from "./generic.js";
import { CapabilityRegistry } from "./registry.js";
import { registerOperationalCapabilities } from "./operational.js";
import {
  registerBusinessActions,
  registerDocumentCapabilities,
  registerSemanticCapabilities
} from "./semantic.js";

export function createCapabilityRegistry(client: OdooClient): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerGenericCapabilities(registry, client);
  registerAccountingCapabilities(registry, client);
  registerSemanticCapabilities(registry, client);
  registerDocumentCapabilities(registry, client);
  registerBusinessActions(registry, client);
  registerOperationalCapabilities(registry, client);
  return registry;
}
