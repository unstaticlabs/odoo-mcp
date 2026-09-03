import { createCapabilityRegistry } from "../capabilities/index.js";
import { OdooClient } from "../odoo/client.js";
import { loadChatGptGoldenPrompts, loadEvalCorpus, loadFixtureManifest } from "./schema.js";
import { generateAllEvalSurfaces } from "./surfaces.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "validate";
  const corpus = await loadEvalCorpus();
  const fixtures = await loadFixtureManifest();
  const golden = await loadChatGptGoldenPrompts();
  const fixtureRefs = new Set(Object.keys(fixtures.refs));
  const unknownRefs = corpus.tasks.flatMap((task) => task.fixture_refs.filter((ref) => !fixtureRefs.has(ref)));
  if (unknownRefs.length) throw new Error(`Unknown fixture references: ${[...new Set(unknownRefs)].join(", ")}`);

  if (command === "validate") {
    process.stdout.write(`${JSON.stringify({
      version: corpus.version,
      fixture_version: fixtures.version,
      tasks: corpus.tasks.length,
      chatgpt_golden_prompts: golden.prompts.length,
      categories: Object.fromEntries(
        [...new Set(corpus.tasks.map((task) => task.category))].sort().map((category) => [
          category,
          corpus.tasks.filter((task) => task.category === category).length
        ])
      )
    }, null, 2)}\n`);
    return;
  }

  if (command === "surfaces") {
    const registry = createCapabilityRegistry(new OdooClient());
    const output = corpus.tasks.map((task) => ({
      task_id: task.id,
      profile: task.profile,
      surfaces: generateAllEvalSurfaces(registry, task).map((surface) => ({
        strategy: surface.strategy,
        static_tools: surface.staticTools.map((tool) => tool.name),
        deferred_tools: surface.deferredTools.map((tool) => tool.name),
        static_schema_tokens: surface.staticSchemaTokens,
        catalogue_schema_tokens: surface.catalogueSchemaTokens
      }))
    }));
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown eval command: ${command}`);
}

await main();
