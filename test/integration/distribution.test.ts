import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache } from "../../src/runtime/agent_access_cache.js";
import type { RequestContext } from "../../src/runtime/context.js";

const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;
const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
const live = Boolean(origin && database && apiKey);
const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

function context(profile: "default" | "advanced" = "default"): RequestContext {
  if (!origin || !database || !apiKey) throw new Error("Live Distribution test configuration is incomplete");
  return {
    requestId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    profile,
    principal: {
      targetId: "integration",
      publicOrigin: origin,
      internalOrigin: process.env.ODOO_INTEGRATION_INTERNAL_ORIGIN ?? origin,
      database,
      apiKey,
      authMode: "direct"
    }
  };
}

async function connected(profile: "default" | "advanced") {
  const odoo = new OdooClient();
  const requestContext = context(profile);
  const accessCache = new AgentAccessSnapshotCache(odoo);
  const snapshot = await accessCache.initialize(requestContext);
  requestContext.agentIdentity = snapshot.identity;
  requestContext.availableModules = snapshot.surface?.modules ?? null;
  requestContext.availablePublicMethods = snapshot.surface?.publicMethods ?? null;
  requestContext.availableModelAccess = snapshot.surface?.modelAccess ?? null;
  requestContext.touchAgentAccess = () => accessCache.touch(requestContext);
  requestContext.noteAgentAccessFailure = (error) => accessCache.noteAccessFailure(requestContext, error);
  const server = createCapabilityRegistry(odoo).createServer(requestContext);
  const client = new Client({ name: "distribution-integration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
    await accessCache.close();
  });
  return client;
}

describe.skipIf(!live).sequential("live USL Odoo Distribution", () => {
  it("authenticates to doc-bearer and exposes installed module metadata", async () => {
    const request = context();
    const document = await new OdooClient().fetchApiDocument<Record<string, unknown>>(request);
    expect(document).toBeTypeOf("object");
    expect(Array.isArray(document.modules)).toBe(true);
  }, 60_000);

  it("executes a bounded generic company read through MCP", async () => {
    const client = await connected("default");
    const result = await client.callTool({
      name: "odoo_search_records",
      arguments: {
        model: "res.company",
        domain: [],
        fields: ["name", "currency_id"],
        limit: 10,
        context: {}
      }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { records: expect.any(Array) } });
  }, 60_000);

  it("keeps the public-method substrate functional as a one-shot advanced tool", async () => {
    const client = await connected("advanced");
    const result = await client.callTool({
      name: "odoo_call_method",
      arguments: { model: "res.users", method: "context_get", kwargs: {}, context: {} }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        execution: { outcome: "succeeded" },
        result: { uid: expect.any(Number) }
      }
    });
  }, 60_000);
});
