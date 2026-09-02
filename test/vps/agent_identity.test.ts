import { describe, expect, it } from "vitest";
import { loadAgentIdentity } from "../../src/odoo/agent_identity.js";
import { OdooClient, OdooError, toolFailureFromError } from "../../src/odoo/client.js";
import { createRequestContext } from "../../src/runtime/context.js";

const principal = {
  targetId: "default",
  publicOrigin: "https://odoo.example",
  internalOrigin: "http://odoo:8069",
  database: "usl",
  apiKey: "secret",
  authMode: "direct" as const
};

const identity = {
  schema_version: 2,
  principal_kind: "agent",
  user_id: 41,
  agent: {
    id: 7,
    name: "ChatGPT Agent",
    purpose: "Use Odoo through MCP.",
    state: "active",
    access_mode: "read_only",
    authority_reduced: false,
    partner_id: 43
  },
  owner: { id: 5, name: "Valentin" },
  credential: { id: 9, name: "ChatGPT", expires_at: "2027-09-02 00:00:00" },
  company_id: 1,
  company_ids: [1, 2],
  companies: [{ id: 1, name: "USL" }, { id: 2, name: "USL MEDIA" }],
  effective_applications: [
    { id: 10, name: "Accounting", access: "read_only" },
    { id: "settings", name: "Settings", access: "read_only" }
  ],
  effective_group_ids: [1, 10]
};

describe("governed Agent identity", () => {
  it("accepts the Odoo identity contract", async () => {
    const client = new OdooClient(1, 1024 * 1024, async () => Response.json(identity));
    await expect(loadAgentIdentity(client, createRequestContext("default", principal))).resolves.toEqual(identity);
  });

  it("rejects human or malformed identities with actionable instructions", async () => {
    const client = new OdooClient(1, 1024 * 1024, async () => Response.json({ uid: 5 }));
    await expect(loadAgentIdentity(client, createRequestContext("default", principal))).rejects.toThrow(
      "Create an Agent in My Agents"
    );
  });

  it("preserves stable Odoo Agent safety codes in MCP failures", async () => {
    const client = new OdooClient(1, 1024 * 1024, async () => Response.json({
      message: "This Agent is suspended.",
      context: { usl_code: "agent_suspended" }
    }, { status: 403 }));
    let caught: unknown;
    try {
      await loadAgentIdentity(client, createRequestContext("default", principal));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OdooError);
    expect(toolFailureFromError(caught)).toMatchObject({
      code: "agent_suspended",
      retryable: false
    });
  });

  it("maps read-only denials to an actionable structured MCP failure", async () => {
    const client = new OdooClient(1, 1024 * 1024, async () => Response.json({
      message: "This Agent has read-only access.",
      context: { usl_code: "agent_read_only_action_denied" }
    }, { status: 403 }));
    let caught: unknown;
    try {
      await client.call(createRequestContext("default", principal), "project.task", "write", {
        ids: [1],
        vals: { name: "Denied" }
      }, { kind: "mutation" });
    } catch (error) {
      caught = error;
    }
    expect(toolFailureFromError(caught)).toMatchObject({
      code: "agent_read_only_action_denied",
      retryable: false,
      recovery: expect.stringContaining("read/write profile")
    });
  });
});
