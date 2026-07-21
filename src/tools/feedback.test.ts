import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OdooQueue } from "../odoo-queue";
import { SERVER_VERSION } from "../server";
import {
  buildFeedbackDescriptionHtml,
  feedbackTagIds,
  registerFeedbackTools,
  FEEDBACK_INBOX_STAGE_ID,
  FEEDBACK_PROJECT_ID,
  FEEDBACK_TITLE_PREFIX
} from "./feedback";
import { validatedToolHandler } from "./structured-test-util";

const props = {
  odooBaseUrl: "http://example.com",
  odooDb: "test-db",
  odooApiKey: "secret-key",
  clientName: "test client"
};

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return { enqueue } as unknown as OdooQueue;
}

function buildFeedbackHandler(queue: OdooQueue) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerFeedbackTools(server, () => props, queue);
  return validatedToolHandler(server, "feedback.submit") as (args: unknown) => Promise<ToolResult>;
}

const validInput = {
  title: "search_records drops explicit order",
  message: "Called search_records with order='name desc' on project.task; results came back unordered.",
  category: "bug" as const
};

describe("feedback helpers", () => {
  test("feedbackTagIds always includes MCP and adds the category tag", () => {
    expect(feedbackTagIds("bug")).toEqual([38, 30]);
    expect(feedbackTagIds("missing_feature")).toEqual([38, 31]);
    expect(feedbackTagIds("documentation_gap")).toEqual([38, 42]);
    expect(feedbackTagIds("dx_friction")).toEqual([38]);
  });

  test("buildFeedbackDescriptionHtml escapes message HTML and stamps metadata", () => {
    const html = buildFeedbackDescriptionHtml({
      category: "bug",
      message: "line one <script>alert(1)</script>\nline two",
      toolName: "search_records",
      client: "test-client"
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("line one");
    expect(html).toContain("<br>line two");
    expect(html).toContain("<code>search_records</code>");
    expect(html).toContain(`odoo-mcp v${SERVER_VERSION}`);
    expect(html).toContain("<b>Client:</b> test-client");
  });

  test("buildFeedbackDescriptionHtml omits the tool line when no tool is named", () => {
    const html = buildFeedbackDescriptionHtml({ category: "dx_friction", message: "x".repeat(20), client: "c" });
    expect(html).not.toContain("<b>Tool:</b>");
  });
});

describe("feedback.submit", () => {
  test("files a low-trust card in the tracker Inbox and posts the [agent-feedback] marker", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (method === "create") return [4242];
      return 99;
    });
    const handler = buildFeedbackHandler(queue);

    const result = await handler({ ...validInput, tool_name: "search_records" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      task_id: 4242,
      url: `http://example.com/odoo/project/${FEEDBACK_PROJECT_ID}/tasks/4242`
    });

    expect(calls.length).toBe(2);
    expect(calls[0].model).toBe("project.task");
    expect(calls[0].method).toBe("create");
    const vals = (calls[0].args.vals_list as Record<string, unknown>[])[0];
    expect(vals.name).toBe(`${FEEDBACK_TITLE_PREFIX} ${validInput.title}`);
    expect(vals.project_id).toBe(FEEDBACK_PROJECT_ID);
    expect(vals.stage_id).toBe(FEEDBACK_INBOX_STAGE_ID);
    expect(vals.tag_ids).toEqual([[6, 0, [38, 30]]]);
    expect(String(vals.description)).toContain("results came back unordered");

    expect(calls[1].method).toBe("message_post");
    expect(calls[1].args.ids).toEqual([4242]);
    const marker = String(calls[1].args.body);
    expect(marker).toContain("[agent-feedback] category=bug via=test-client");
    expect(marker).toContain(`server=${SERVER_VERSION}`);
  });

  test("never posts a trusted [agent-source] provenance token", async () => {
    const bodies: string[] = [];
    const queue = dispatchQueue((_model, method, args) => {
      if (method === "create") return [7];
      bodies.push(String(args.body));
      return 1;
    });
    const handler = buildFeedbackHandler(queue);

    await handler(validInput);

    expect(bodies.length).toBe(1);
    expect(bodies[0]).not.toContain("[agent-source]");
    expect(bodies[0]).not.toContain("engineering_task");
  });

  test("marker post failure still returns the task id with a warning", async () => {
    const queue = dispatchQueue((_model, method) => {
      if (method === "create") return [55];
      throw new Error("chatter down");
    });
    const handler = buildFeedbackHandler(queue);

    const result = await handler(validInput);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.task_id).toBe(55);
    expect(String(result.structuredContent?.marker_warning)).toContain("chatter down");
  });

  test("create failure returns a JSON error envelope", async () => {
    const queue = dispatchQueue(() => {
      throw new Error("odoo unavailable");
    });
    const handler = buildFeedbackHandler(queue);

    const result = await handler(validInput);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.model).toBe("project.task");
    expect(envelope.method).toBe("create");
    expect(envelope.details).toContain("odoo unavailable");
  });
});
