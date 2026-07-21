/**
 * Agent feedback channel (`feedback.submit`).
 *
 * Files agent-reported bugs / documentation gaps / missing features / DX friction as
 * `project.task` cards in the maintainers' odoo-mcp tracker, where the normal triage
 * flow picks them up.
 *
 * TRUST MODEL — deliberate, do not "fix":
 * Feedback text is distilled from arbitrary agent conversations, i.e. untrusted input.
 * Cards created here must therefore stay on the low-trust triage path. This tool NEVER
 * posts an `[agent-source]` trusted-provenance token (unlike create_record's project.task
 * path) — the chatter marker uses the distinct `[agent-feedback]` prefix precisely so
 * downstream provenance parsers cannot read feedback cards as trusted work items.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import { SERVER_VERSION, type Props } from "../server";
import { assessWriteOperation } from "../write-safety";
import {
  escapeHtml,
  mcpErrorFromException,
  mcpStructured,
  mcpWriteBlockedError,
  plaintextToHtml,
  requireConnection
} from "./shared";

/** Target project for feedback cards (odoo-mcp tracker). */
export const FEEDBACK_PROJECT_ID = 17;
/** Inbox stage of the feedback project — where the triage automation fires. */
export const FEEDBACK_INBOX_STAGE_ID = 119;
/** Task-name prefix marking agent-filed feedback (filter/dedup handle, not a trust token). */
export const FEEDBACK_TITLE_PREFIX = "[agent-feedback]";

export const FEEDBACK_CATEGORIES = ["bug", "documentation_gap", "missing_feature", "dx_friction"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** Always-applied tag: MCP. */
export const FEEDBACK_BASE_TAG_IDS = [38] as const;

/** Category-specific tag on top of the base tags (Bug / Feature / Docs). */
export const FEEDBACK_CATEGORY_TAG_IDS: Record<FeedbackCategory, number | null> = {
  bug: 30,
  documentation_gap: 42,
  missing_feature: 31,
  dx_friction: null
};

/** Exported for unit testing. */
export function feedbackTagIds(category: FeedbackCategory): number[] {
  const categoryTag = FEEDBACK_CATEGORY_TAG_IDS[category];
  return categoryTag == null ? [...FEEDBACK_BASE_TAG_IDS] : [...FEEDBACK_BASE_TAG_IDS, categoryTag];
}

/** Exported for unit testing. */
export function buildFeedbackDescriptionHtml(input: {
  category: FeedbackCategory;
  message: string;
  toolName?: string;
  client: string;
}): string {
  const meta = [
    `<b>Category:</b> ${escapeHtml(input.category)}`,
    ...(input.toolName ? [`<b>Tool:</b> <code>${escapeHtml(input.toolName)}</code>`] : []),
    `<b>Server:</b> odoo-mcp v${escapeHtml(SERVER_VERSION)}`,
    `<b>Client:</b> ${escapeHtml(input.client)}`
  ].join("<br>");
  return `<p>${meta}</p><p>${plaintextToHtml(input.message)}</p>`;
}

export function registerFeedbackTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "feedback.submit",
    {
      title: "Submit Connector Feedback",
      description:
        "Report bugs, documentation gaps, missing features, or developer-experience friction with this Odoo MCP " +
        "server to its maintainers. Use this instead of silently working around a problem — a wrong or misleading " +
        "tool description, an error envelope that didn't help, a missing capability you had to approximate. " +
        "Include the exact tool, what you expected, and what actually happened (verbatim error text helps). " +
        "Never include credentials, API keys, or personal/financial data from the conversation. " +
        "Reports are triaged by humans; submitting one does not change server behavior.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        title: z.string().min(5).max(120).describe("Short imperative summary of the issue (becomes the tracker card title)"),
        message: z
          .string()
          .min(20)
          .max(4000)
          .describe(
            "Concrete details: which tool, the inputs you used, what you expected, what actually happened, " +
              "and exact error text if any. No credentials or sensitive data."
          ),
        category: z.enum(FEEDBACK_CATEGORIES),
        tool_name: z.string().max(100).optional().describe("The odoo-mcp tool this feedback concerns, if any")
      },
      outputSchema: {
        task_id: z.number().int().describe("Id of the created tracker card"),
        url: z.string().describe("Direct Odoo URL of the created card"),
        marker_warning: z
          .string()
          .optional()
          .describe("The card was created but posting the [agent-feedback] chatter marker failed")
      }
    },
    async ({ title, message, category, tool_name }) => {
      const props = getProps();
      const client = (props?.clientName ?? server.server.getClientVersion()?.name ?? "unknown").replace(/\s+/g, "-");

      const values = {
        name: `${FEEDBACK_TITLE_PREFIX} ${title}`,
        description: buildFeedbackDescriptionHtml({ category, message, toolName: tool_name, client }),
        project_id: FEEDBACK_PROJECT_ID,
        stage_id: FEEDBACK_INBOX_STAGE_ID,
        tag_ids: [[6, 0, feedbackTagIds(category)]]
      };

      // Same gate invariant as every connector write; project.task create with these fields always passes.
      const verdict = assessWriteOperation({ model: "project.task", method: "create", args: { vals_list: [values] } });
      if (!verdict.allowed) {
        return mcpWriteBlockedError({ model: "project.task", method: "create" }, verdict);
      }

      let conn: ReturnType<typeof requireConnection>;
      let taskId: number;
      try {
        conn = requireConnection(props);
        const ids = (await queue.enqueue(conn, "project.task", "create", { vals_list: [values] })) as number[];
        taskId = ids[0];
      } catch (err) {
        return mcpErrorFromException(err, { model: "project.task", method: "create" });
      }

      const url = `${conn.url.replace(/\/+$/, "")}/odoo/project/${FEEDBACK_PROJECT_ID}/tasks/${taskId}`;
      // Distinct low-trust marker — see the trust-model note in the module docstring.
      const marker = `${FEEDBACK_TITLE_PREFIX} category=${category} via=${client} server=${SERVER_VERSION}`;

      try {
        await queue.enqueue(conn, "project.task", "message_post", {
          ids: [taskId],
          body: plaintextToHtml(marker),
          body_is_html: true,
          message_type: "comment"
        });
        return mcpStructured(
          { task_id: taskId, url },
          `Feedback recorded as task ${taskId} (${url}). Thank you — the maintainers triage these.`
        );
      } catch (err) {
        // Marker failure must never fail the report: the card exists either way.
        const errMessage = err instanceof Error ? err.message : String(err);
        const marker_warning = `created task ${taskId} but failed to post the [agent-feedback] marker (${errMessage})`;
        return mcpStructured(
          { task_id: taskId, url, marker_warning },
          `Feedback recorded as task ${taskId} (${url}). Warning: ${marker_warning}.`
        );
      }
    }
  );
}
