import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import { attributedContext } from "../odoo/schemas.js";
import { SERVER_VERSION } from "../version.js";
import type { CapabilityReleaseIdentity } from "./index.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const FeedbackInputSchema = z.object({
  category: z.enum(["bug", "feature_request", "documentation_gap", "usability"]),
  impact: z.enum(["blocking", "major", "minor", "suggestion"]),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(10_000),
  affected_tool: z.string().trim().min(1).max(128).optional(),
  expected_behavior: z.string().trim().min(1).max(10_000).optional(),
  actual_behavior: z.string().trim().min(1).max(10_000).optional(),
  reproduction_steps: z.array(z.string().trim().min(1).max(2_000)).max(20).optional(),
  workaround: z.string().trim().min(1).max(10_000).optional()
}).strict().superRefine((value, issue) => {
  if (value.category !== "bug") return;
  if (!value.expected_behavior) {
    issue.addIssue({ code: "custom", path: ["expected_behavior"], message: "Bug feedback requires expected_behavior" });
  }
  if (!value.actual_behavior) {
    issue.addIssue({ code: "custom", path: ["actual_behavior"], message: "Bug feedback requires actual_behavior" });
  }
  if (!value.reproduction_steps?.length) {
    issue.addIssue({ code: "custom", path: ["reproduction_steps"], message: "Bug feedback requires at least one reproduction step" });
  }
});

const FeedbackOutputSchema = z.object({
  result: z.object({
    task_id: z.number().int().positive(),
    display_name: z.string(),
    project_id: z.number().int().positive(),
    stage_id: z.number().int().positive(),
    submitted_at: z.string()
  }).strict(),
  correlation_id: z.string(),
  outcome: z.enum(["succeeded", "unknown"]),
  record: z.object({
    model: z.literal("project.task"),
    id: z.number().int().positive(),
    display_name: z.string(),
    url: z.string().url()
  }).strict()
}).strict();

type FeedbackResult = z.infer<typeof FeedbackOutputSchema>["result"];

export function registerFeedbackCapability(
  registry: CapabilityRegistry,
  client: OdooClient,
  releaseIdentity: CapabilityReleaseIdentity
): void {
  registry.add(defineCapability({
    id: "agent.feedback.submit",
    name: "odoo_submit_feedback",
    title: "Submit Odoo MCP Feedback",
    description:
      "Submit one structured bug report, feature request, documentation gap, or usability report to the governed Odoo MCP development inbox. Use only for actionable product feedback, never for ordinary project-task creation. The server adds the Agent identity, UTC time, correlation ID, and available MCP, Odoo, and GitOps release identities. Reports are explicitly marked low-trust and may record unknown for unavailable release identities.",
    layer: "business_action",
    toolsets: ["core", "advanced"],
    profiles: ["advanced"],
    effect: "write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    keywords: ["feedback", "bug", "issue", "feature request", "documentation", "usability", "report MCP problem"],
    requiredModules: ["usl_access_control", "project"],
    requiredPublicMethods: [{ model: "usl.agent", method: "submit_mcp_feedback" }],
    defaultVisible: true,
    alwaysLoad: false,
    sortOrder: 920,
    input: FeedbackInputSchema,
    output: FeedbackOutputSchema,
    async handler(input, context, signal) {
      const receipt = await client.call<FeedbackResult>(
        context,
        "usl.agent",
        "submit_mcp_feedback",
        {
          feedback: {
            ...input,
            correlation_id: context.correlationId
          },
          release: {
            mcp_server_version: SERVER_VERSION,
            mcp_commit: releaseIdentity.mcpCommit,
            gitops_commit: releaseIdentity.gitopsCommit
          },
          context: attributedContext({}, context.correlationId)
        },
        {
          kind: "mutation",
          signal,
          reconciliation: {
            targetModel: "project.task",
            fields: ["name", "project_id", "stage_id", "description", "tag_ids"],
            suggestedTool: "odoo_search_records",
            instructions:
              "Search the configured MCP development project for the exact feedback title and correlation ID before repeating. If a matching task exists, do not submit another report."
          }
        }
      );
      return receipt.finalize((result) => ({
        data: {
          result,
          correlation_id: context.correlationId,
          outcome: "succeeded" as const,
          record: {
            model: "project.task" as const,
            id: result.task_id,
            display_name: result.display_name,
            url: `${context.principal.publicOrigin}/odoo/project.task/${result.task_id}`
          }
        }
      }), (result) => ({ knownIds: [result.task_id] }));
    }
  }));
}
