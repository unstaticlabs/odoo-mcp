import type { RequestContext } from "../../src/runtime/context.js";

const testAgentIdentity = {
  schema_version: 3 as const,
  principal_kind: "agent" as const,
  user_id: 41,
  agent: {
    id: 7,
    name: "Test Agent",
    purpose: "Exercise the MCP capability registry.",
    state: "active" as const,
    access_mode: "read_write" as const,
    authority_reduced: false,
    partner_id: 43
  },
  owner: { id: 5, name: "Test Owner" },
  credential: { id: 9, name: "Test key", expires_at: "2027-09-02 00:00:00" },
  company_id: 1,
  company_ids: [1, 2],
  companies: [{ id: 1, name: "USL" }, { id: 2, name: "USL MEDIA" }],
  effective_applications: [{ id: 10, name: "Accounting", access: "read_write" as const }],
  effective_group_ids: [1, 10]
};

export function requestContext(accessMode: "read_only" | "read_write" | "mixed" = "read_write"): RequestContext {
  const identity = {
    ...testAgentIdentity,
    agent: { ...testAgentIdentity.agent, access_mode: accessMode },
    effective_applications: testAgentIdentity.effective_applications.map((application) => ({
      ...application,
      access: accessMode
    }))
  };
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
    agentIdentity: identity,
    validateAgentIdentity: async () => identity
  };
}
