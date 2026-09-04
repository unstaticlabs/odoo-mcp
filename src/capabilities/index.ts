import { OdooClient } from "../odoo/client.js";
import { registerAccountingCapabilities } from "./accounting.js";
import { registerGenericCapabilities } from "./generic.js";
import { registerFeedbackCapability } from "./feedback.js";
import { CapabilityRegistry } from "./registry.js";
import { registerOperationalCapabilities } from "./operational.js";
import {
  registerBusinessActions,
  registerDocumentCapabilities,
  registerSemanticCapabilities
} from "./semantic.js";

export interface CapabilityReleaseIdentity {
  mcpCommit: string;
  gitopsCommit: string;
}

const unknownReleaseIdentity: CapabilityReleaseIdentity = {
  mcpCommit: "unknown",
  gitopsCommit: "unknown"
};

export function createCapabilityRegistry(
  client: OdooClient,
  releaseIdentity: CapabilityReleaseIdentity = unknownReleaseIdentity
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerGenericCapabilities(registry, client);
  registerAccountingCapabilities(registry, client);
  registerSemanticCapabilities(registry, client);
  registerDocumentCapabilities(registry, client);
  registerBusinessActions(registry, client);
  registerOperationalCapabilities(registry, client);
  registerFeedbackCapability(registry, client, releaseIdentity);
  return registry;
}
