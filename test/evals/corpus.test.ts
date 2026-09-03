import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import {
  loadChatGptGoldenPrompts,
  loadEvalCorpus,
  loadFixtureManifest
} from "../../src/evals/schema.js";
import { generateAllEvalSurfaces, generateEvalSurface } from "../../src/evals/surfaces.js";
import { OdooClient } from "../../src/odoo/client.js";

const expectedCounts = {
  straightforward: 10,
  cross_domain: 10,
  long_tail: 10,
  held_out: 10,
  discovery: 5,
  multi_company: 5,
  consequential: 5,
  adversarial: 5
} as const;

describe("agent-interface evaluation corpus", () => {
  it("contains 60 uniquely identified tasks in the promised category split", async () => {
    const corpus = await loadEvalCorpus();
    expect(new Set(corpus.tasks.map((task) => task.id)).size).toBe(60);
    for (const [category, count] of Object.entries(expectedCounts)) {
      expect(corpus.tasks.filter((task) => task.category === category)).toHaveLength(count);
    }
    expect(corpus.tasks.every((task) => task.held_out === (task.category === "held_out"))).toBe(true);
  });

  it("resolves every fixture and named capability against versioned repository state", async () => {
    const [corpus, fixtures] = await Promise.all([loadEvalCorpus(), loadFixtureManifest()]);
    const fixtureRefs = new Set(Object.keys(fixtures.refs));
    const registry = createCapabilityRegistry(new OdooClient());
    const capabilities = new Set(registry.list("all").map((tool) => tool.name));

    expect(corpus.fixture_version).toBe(fixtures.version);
    for (const task of corpus.tasks) {
      expect(task.fixture_refs.every((ref) => fixtureRefs.has(ref)), task.id).toBe(true);
      expect(
        [...task.oracle.must_use_one_of, ...task.oracle.forbidden_capabilities]
          .every((name) => capabilities.has(name)),
        task.id
      ).toBe(true);
    }
  });

  it("keeps a generic fallback available in every held-out task oracle", async () => {
    const corpus = await loadEvalCorpus();
    for (const task of corpus.tasks.filter((candidate) => candidate.held_out)) {
      expect(task.oracle.must_use_one_of.some((name) => name.startsWith("odoo_")), task.id).toBe(true);
    }
  });

  it("validates the six ChatGPT discovery and safety golden prompts", async () => {
    const golden = await loadChatGptGoldenPrompts();
    const registry = createCapabilityRegistry(new OdooClient());
    const knownTools = new Set(registry.list("all").map((tool) => tool.name));
    expect(new Set(golden.prompts.map((prompt) => prompt.scenario))).toEqual(new Set([
      "direct_method",
      "indirect_expense_approval",
      "specialized_tool_preference",
      "missing_doc_bearer",
      "read_only_identity",
      "irreversible_deletion"
    ]));
    for (const prompt of golden.prompts) {
      expect(
        [
          ...prompt.expected.visible_tools,
          ...prompt.expected.hidden_tools,
          ...prompt.expected.preferred_tools,
          ...prompt.expected.forbidden_tools
        ].every((name) => knownTools.has(name)),
        prompt.id
      ).toBe(true);
    }
  });

  it("generates deterministic A/B/C/D/E interfaces and meets the selected token target", async () => {
    const corpus = await loadEvalCorpus();
    const registry = createCapabilityRegistry(new OdooClient());
    const task = corpus.tasks.find((candidate) => candidate.id === "cross_partner_invoice_documents")!;
    const surfaces = generateAllEvalSurfaces(registry, task);

    expect(surfaces.map((surface) => surface.strategy)).toEqual(["A", "B", "C", "D", "E"]);
    const staticAll = generateEvalSurface(registry, task, "A");
    const hardDomain = generateEvalSurface(registry, task, "B");
    const selected = generateEvalSurface(registry, task, "E");
    expect(hardDomain.staticTools.every((tool) => tool.toolsets.includes("contacts"))).toBe(true);
    expect(selected.staticTools.map((tool) => tool.name)).toEqual([
      "odoo_search_capabilities",
      "odoo_search_models",
      "odoo_describe_model",
      "odoo_search_records",
      "odoo_read_records"
    ]);
    expect(selected.staticSchemaTokens).toBeLessThanOrEqual(staticAll.staticSchemaTokens * 0.3);
    expect(selected.deferredTools).toContainEqual(expect.objectContaining({ name: "odoo_call_method" }));
    expect(selected.catalogueSchemaTokens).toBe(staticAll.catalogueSchemaTokens);
  });
});
