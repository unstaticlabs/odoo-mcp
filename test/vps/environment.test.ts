import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const initial = requestContext("read_only");
const emptyIdentity = { ...initial.agentIdentity!, effective_applications: [] };

async function describeEnvironment(fetcher: typeof fetch, cached = emptyIdentity as NonNullable<typeof initial.agentIdentity>) {
  const context = {
    ...initial,
    agentIdentity: cached,
    availableModules: new Set(["usl_access_control"])
  };
  const registry = createCapabilityRegistry(new OdooClient(1, 1024 * 1024, fetcher));
  const server = registry.createServer(context);
  const client = new Client({ name: "local-identity-reader", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    return await client.callTool({ name: "odoo_describe_environment", arguments: {} });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("environment reads after a delegation changes", () => {
  it("describes only the identity and companies reconfirmed by Odoo", async () => {
    const live = { ...emptyIdentity, company_ids: [2], company_id: 2, companies: [{ id: 2, name: "Second workshop" }] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(live));
    const result = await describeEnvironment(fetcher);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: {
      user: { id: live.user_id, company_ids: [2] },
      companies: [{ id: 2, display_name: "Second workshop" }],
      effective_company_ids: [2],
      effective_applications: [],
      locale: {}
    } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/usl\.agent\/current_identity$/);
  });

  it("drops cached application rights before using directory access", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(emptyIdentity));
    const result = await describeEnvironment(fetcher, initial.agentIdentity!);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { effective_applications: [], locale: {}, companies: [{ id: 1 }, { id: 2 }] }
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/usl\.agent\/current_identity$/);
  });

  it("returns the native refusal if the credential has since been suspended", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      message: "This Agent is suspended.", context: { usl_code: "agent_suspended" }
    }, { status: 403 }));
    const result = await describeEnvironment(fetcher);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code: "agent_suspended" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
