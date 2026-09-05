import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ProfileNameSchema } from "../runtime/context.js";

export const EvalCategorySchema = z.enum([
  "straightforward",
  "cross_domain",
  "long_tail",
  "held_out",
  "discovery",
  "multi_company",
  "consequential",
  "adversarial"
]);

export const EvalTaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  category: EvalCategorySchema,
  profile: ProfileNameSchema,
  toolsets: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).max(5),
  prompt: z.string().min(20).max(2_000),
  fixture_refs: z.array(z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/)).min(1).max(20),
  held_out: z.boolean(),
  oracle: z.object({
    outcome: z.enum(["answer", "state_change", "refuse", "unsupported"]),
    must_use_one_of: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    forbidden_capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    max_tool_calls: z.number().int().min(0).max(30),
    assertions: z.array(z.string().min(4).max(500)).min(1).max(20)
  }).strict()
}).strict();

export const EvalCorpusSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  distribution_ref: z.string().min(7).max(64),
  fixture_version: z.string().min(1).max(100),
  tasks: z.array(EvalTaskSchema).length(60)
}).strict();

export const FixtureManifestSchema = z.object({
  version: z.string().min(1).max(100),
  database_template: z.string().min(1).max(100),
  company_external_ids: z.array(z.string()).min(2),
  refs: z.record(z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/), z.object({
    model: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/),
    values: z.record(z.string(), z.unknown()),
    relations: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
  }).strict())
}).strict();

export const EvalObservationSchema = z.object({
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  strategy: z.enum(["A", "B", "C", "D", "E"]),
  client: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  run_date: z.string().datetime(),
  completed: z.boolean(),
  correct: z.boolean(),
  safe: z.boolean(),
  tool_calls: z.array(z.object({
    name: z.string(),
    status: z.string(),
    argument_corrections: z.number().int().nonnegative().default(0)
  }).strict()),
  schema_tokens_exposed: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  latency_ms: z.number().int().nonnegative(),
  notes: z.string().max(2_000).optional()
}).strict();

export const ChatGptGoldenPromptSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  scenario: z.enum([
    "direct_method",
    "indirect_expense_approval",
    "specialized_tool_preference",
    "missing_doc_bearer",
    "read_only_identity",
    "irreversible_deletion",
    "agent_feedback",
    "everyday_workflow"
  ]),
  profile: ProfileNameSchema,
  backend_metadata: z.enum(["available", "unavailable"]),
  prompt: z.string().min(20).max(2_000),
  expected: z.object({
    visible_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    hidden_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    preferred_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    forbidden_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    assertions: z.array(z.string().min(4).max(500)).min(1).max(20)
  }).strict()
}).strict();

export const ChatGptGoldenPromptsSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prompts: z.array(ChatGptGoldenPromptSchema).min(7).max(40)
}).strict();

export type EvalCorpus = z.infer<typeof EvalCorpusSchema>;
export type EvalTask = z.infer<typeof EvalTaskSchema>;
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
export type ChatGptGoldenPrompt = z.infer<typeof ChatGptGoldenPromptSchema>;

export async function loadEvalCorpus(path = resolve(process.cwd(), "evals/corpus.json")): Promise<EvalCorpus> {
  return EvalCorpusSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadFixtureManifest(
  path = resolve(process.cwd(), "evals/fixtures/usl-eval-v1.json")
): Promise<FixtureManifest> {
  return FixtureManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadChatGptGoldenPrompts(
  path = resolve(process.cwd(), "evals/chatgpt-golden-prompts.json")
): Promise<z.infer<typeof ChatGptGoldenPromptsSchema>> {
  return ChatGptGoldenPromptsSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
