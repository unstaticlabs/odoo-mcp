import { describe, expect, it } from "vitest";
import { CURATED_FIELD_CONTRACTS } from "../../src/capabilities/curated_fields.js";
import { OdooClient } from "../../src/odoo/client.js";
import type { RequestContext } from "../../src/runtime/context.js";

const origin = process.env.ODOO_INTEGRATION_ORIGIN;
const database = process.env.ODOO_INTEGRATION_DATABASE;
const apiKey = process.env.ODOO_INTEGRATION_API_KEY;
const live = Boolean(origin && database && apiKey);

function context(): RequestContext {
  if (!origin || !database || !apiKey) throw new Error("Live Distribution test configuration is incomplete");
  return {
    requestId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    profile: "default",
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

/**
 * Read every field name the deployed database exposes for one model.
 *
 * `/doc-bearer` and `fields_get` are both filtered by the caller's access, and
 * they do not always agree, so the union is used: the point of this suite is to
 * catch a field that exists in no reading of the schema at all.
 */
async function deployedFieldNames(client: OdooClient, model: string): Promise<Set<string>> {
  const names = new Set<string>();
  const request = context();
  try {
    const document = await client.fetchApiDocument<{ fields?: Record<string, unknown> }>(request, model);
    for (const name of Object.keys(document.fields ?? {})) names.add(name);
  } catch {
    // fields_get below is the fallback, exactly as odoo_describe_model does it.
  }
  const raw = await client.call<Record<string, unknown>>(request, model, "fields_get", { attributes: ["type"] });
  for (const name of Object.keys(raw)) names.add(name);
  return names;
}

describe.skipIf(!live).sequential("curated field contracts against the deployed schema", () => {
  for (const contract of CURATED_FIELD_CONTRACTS) {
    it(`${contract.capability} reads only fields that exist on ${contract.model}`, async () => {
      const deployed = await deployedFieldNames(new OdooClient(), contract.model);
      expect(deployed.size).toBeGreaterThan(0);
      const missing = contract.fields.filter((field) => !deployed.has(field));
      expect(missing, `${contract.capability} names fields absent from ${contract.model}`).toEqual([]);
    }, 60_000);
  }
});
