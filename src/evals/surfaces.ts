import type { CapabilityMetadata, CapabilityRegistry } from "../capabilities/registry.js";
import type { EvalTask } from "./schema.js";

export type SurfaceStrategy = "A" | "B" | "C" | "D" | "E";

export interface EvalSurface {
  strategy: SurfaceStrategy;
  description: string;
  staticTools: CapabilityMetadata[];
  deferredTools: CapabilityMetadata[];
  staticSchemaTokens: number;
  catalogueSchemaTokens: number;
}

function tokens(tools: readonly CapabilityMetadata[]): number {
  return tools.reduce((sum, tool) => sum + tool.schemaTokens, 0);
}

export function generateEvalSurface(
  registry: CapabilityRegistry,
  task: EvalTask,
  strategy: SurfaceStrategy
): EvalSurface {
  const all = registry.list("all");
  let staticTools: CapabilityMetadata[];
  let deferredTools: CapabilityMetadata[] = [];
  let description: string;

  switch (strategy) {
    case "A":
      staticTools = all;
      description = "Large static catalogue: every capability definition is directly visible.";
      break;
    case "B": {
      const primaryToolset = task.toolsets[0]!;
      staticTools = all.filter((tool) => tool.toolsets.includes(primaryToolset));
      description = `Hard isolated ${primaryToolset} surface without the universal cross-domain substrate.`;
      break;
    }
    case "C":
      staticTools = registry.list(task.profile);
      description = `Static canonical-registry profile: ${task.profile}.`;
      break;
    case "D":
      staticTools = [];
      deferredTools = all;
      description = "Full catalogue available only through native client tool search.";
      break;
    case "E":
      staticTools = all.filter((tool) => tool.alwaysLoad);
      deferredTools = all.filter((tool) => !tool.alwaysLoad);
      description = "Selected architecture: five universal discovery/read primitives plus deferred semantic and action tools.";
      break;
  }

  return {
    strategy,
    description,
    staticTools,
    deferredTools,
    staticSchemaTokens: tokens(staticTools),
    catalogueSchemaTokens: tokens([...staticTools, ...deferredTools])
  };
}

export function generateAllEvalSurfaces(registry: CapabilityRegistry, task: EvalTask): EvalSurface[] {
  return (["A", "B", "C", "D", "E"] as const).map((strategy) => generateEvalSurface(registry, task, strategy));
}
