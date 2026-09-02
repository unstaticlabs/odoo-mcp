import type { RequestContext } from "../../src/runtime/context.js";

const testAgentIdentity = {
  schema_version: 1 as const,
  principal_kind: "agent" as const,
  user_id: 41,
  agent: {
    id: 7,
    name: "Test Agent",
    purpose: "Exercise the MCP capability registry.",
    state: "active" as const
  },
  owner: { id: 5, name: "Test Owner" },
  credential: { id: 9, name: "Test key", expires_at: "2027-09-02 00:00:00" },
  company_id: 1,
  company_ids: [1, 2]
};

export function requestContext(): RequestContext {
  return {
    requestId: "request-test",
    correlationId: "correlation-test",
    profile: "default",
    principal: {
      targetId: "test",
      publicOrigin: "https://odoo.example",
      internalOrigin: "http://odoo:8069",
      database: "test",
      apiKey: "test-key",
      authMode: "direct"
    },
    agentIdentity: testAgentIdentity,
    validateAgentIdentity: async () => testAgentIdentity
  };
}
