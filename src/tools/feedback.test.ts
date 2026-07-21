import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import type { OdooQueue } from "../odoo-queue";
import { SERVER_VERSION } from "../server";
import {
  buildFeedbackDescriptionHtml,
  feedbackTagIds,
  registerFeedbackTools,
  resolveFeedbackStageId,
  FEEDBACK_INBOX_STAGE_NAME,
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

const conn = { url: props.odooBaseUrl, db: props.odooDb, apiKey: props.odooApiKey };

const INBOX_STAGE_ID = 126;

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

function dispatchQueue(responder: (model: string, method: string, args: Record<string, unknown>) => unknown): OdooQueue {
  const enqueue = mock(async (...a: unknown[]) => responder(a[1] as string, a[2] as string, a[3] as Record<string, unknown>));
  return { enqueue } as unknown as OdooQueue;
}

function buildFeedbackHandler(queue: OdooQueue, cache?: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerFeedbackTools(server, () => props, queue, cache);
  return validatedToolHandler(server, "feedback.submit") as (args: unknown) => Promise<ToolResult>;
}

/** Responder core: stage lookup finds Inbox, create returns `createId`, message_post returns 99. */
function stagedResponder(createId: number) {
  return (model: string, method: string): unknown => {
    if (model === "project.task.type" && method === "search_read") return [{ id: INBOX_STAGE_ID }];
    if (method === "create") return [createId];
    return 99;
  };
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

describe("resolveFeedbackStageId", () => {
  test("looks up the Inbox stage by name scoped to the feedback project", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      return [{ id: INBOX_STAGE_ID }];
    });

    const id = await resolveFeedbackStageId(queue, conn);

    expect(id).toBe(INBOX_STAGE_ID);
    expect(calls).toEqual([
      {
        model: "project.task.type",
        method: "search_read",
        args: {
          domain: [
            ["project_ids", "in", [FEEDBACK_PROJECT_ID]],
            ["name", "=", FEEDBACK_INBOX_STAGE_NAME]
          ],
          fields: ["id"],
          limit: 1
        }
      }
    ]);
  });

  test("returns null when no stage matches or the lookup throws", async () => {
    expect(await resolveFeedbackStageId(dispatchQueue(() => []), conn)).toBeNull();
    expect(
      await resolveFeedbackStageId(
        dispatchQueue(() => {
          throw new Error("odoo down");
        }),
        conn
      )
    ).toBeNull();
  });

  test("caches the resolved id — second call makes no Odoo round-trip", async () => {
    const cache = new TtlCache();
    let lookups = 0;
    const queue = dispatchQueue(() => {
      lookups++;
      return [{ id: INBOX_STAGE_ID }];
    });

    expect(await resolveFeedbackStageId(queue, conn, cache)).toBe(INBOX_STAGE_ID);
    expect(await resolveFeedbackStageId(queue, conn, cache)).toBe(INBOX_STAGE_ID);
    expect(lookups).toBe(1);
  });

  test("does not cache failed lookups", async () => {
    const cache = new TtlCache();
    let lookups = 0;
    const queue = dispatchQueue(() => {
      lookups++;
      return [];
    });

    expect(await resolveFeedbackStageId(queue, conn, cache)).toBeNull();
    expect(await resolveFeedbackStageId(queue, conn, cache)).toBeNull();
    expect(lookups).toBe(2);
  });
});

describe("feedback.submit", () => {
  test("resolves the Inbox stage, files a low-trust card, and posts the [agent-feedback] marker", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      return stagedResponder(4242)(model, method);
    });
    const handler = buildFeedbackHandler(queue);

    const result = await handler({ ...validInput, tool_name: "search_records" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      task_id: 4242,
      url: `http://example.com/odoo/project/${FEEDBACK_PROJECT_ID}/tasks/4242`
    });

    expect(calls.length).toBe(3);
    expect(calls[0].model).toBe("project.task.type");
    expect(calls[1].model).toBe("project.task");
    expect(calls[1].method).toBe("create");
    const vals = (calls[1].args.vals_list as Record<string, unknown>[])[0];
    expect(vals.name).toBe(`${FEEDBACK_TITLE_PREFIX} ${validInput.title}`);
    expect(vals.project_id).toBe(FEEDBACK_PROJECT_ID);
    expect(vals.stage_id).toBe(INBOX_STAGE_ID);
    expect(vals.tag_ids).toEqual([[6, 0, [38, 30]]]);
    expect(String(vals.description)).toContain("results came back unordered");

    expect(calls[2].method).toBe("message_post");
    expect(calls[2].args.ids).toEqual([4242]);
    const marker = String(calls[2].args.body);
    expect(marker).toContain("[agent-feedback] category=bug via=test-client");
    expect(marker).toContain(`server=${SERVER_VERSION}`);
  });

  test("stage lookup failure omits stage_id (Odoo defaults to the first stage) instead of failing", async () => {
    const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
    const queue = dispatchQueue((model, method, args) => {
      calls.push({ model, method, args });
      if (model === "project.task.type") throw new Error("stage gone");
      if (method === "create") return [4243];
      return 99;
    });
    const handler = buildFeedbackHandler(queue);

    const result = await handler(validInput);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.task_id).toBe(4243);
    const vals = (calls[1].args.vals_list as Record<string, unknown>[])[0];
    expect("stage_id" in vals).toBe(false);
    expect(vals.project_id).toBe(FEEDBACK_PROJECT_ID);
  });

  test("uses the shared cache so repeat submissions skip the stage lookup", async () => {
    const cache = new TtlCache();
    let stageLookups = 0;
    const queue = dispatchQueue((model, method) => {
      if (model === "project.task.type") {
        stageLookups++;
        return [{ id: INBOX_STAGE_ID }];
      }
      if (method === "create") return [1];
      return 99;
    });
    const handler = buildFeedbackHandler(queue, cache);

    await handler(validInput);
    await handler(validInput);

    expect(stageLookups).toBe(1);
  });

  test("never posts a trusted [agent-source] provenance token", async () => {
    const bodies: string[] = [];
    const queue = dispatchQueue((model, method, args) => {
      if (model === "project.task.type") return [{ id: INBOX_STAGE_ID }];
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
    const queue = dispatchQueue((model, method) => {
      if (model === "project.task.type") return [{ id: INBOX_STAGE_ID }];
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
    const queue = dispatchQueue((model) => {
      if (model === "project.task.type") return [{ id: INBOX_STAGE_ID }];
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
