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
  schema_version: 1,
  principal_kind: "agent",
  user_id: 41,
  agent: { id: 7, name: "ChatGPT Agent", purpose: "Use Odoo through MCP.", state: "active" },
  owner: { id: 5, name: "Valentin" },
  credential: { id: 9, name: "ChatGPT", expires_at: "2027-09-02 00:00:00" },
  company_id: 1,
  company_ids: [1, 2]
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
});
