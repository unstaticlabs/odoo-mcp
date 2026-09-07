import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connected(fetcher: typeof fetch) {
  const server = createCapabilityRegistry(
    new OdooClient(8, 1024 * 1024, fetcher)
  ).createServer(requestContext());
  const client = new Client({ name: "write-path-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// odoo_call_method consults the authenticated API document to learn whether Odoo
// classifies the method as readonly. That GET is metadata, not a business call,
// so the one-attempt mutation contract is asserted over JSON-2 calls only.
function jsonCalls(fetcher: ReturnType<typeof vi.fn>, suffix = "") {
  return fetcher.mock.calls.filter(([url]) =>
    String(url).includes("/json/2/") && String(url).endsWith(suffix));
}

function requestBody(fetcher: ReturnType<typeof vi.fn>, method: string) {
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith(`/json/2/${method}`));
  expect(call, `${method} was not called`).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

function requestBodies(fetcher: ReturnType<typeof vi.fn>, method: string) {
  return fetcher.mock.calls
    .filter(([url]) => String(url).endsWith(`/json/2/${method}`))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function warningsOf(result: { structuredContent?: unknown }) {
  return ((result.structuredContent as { warnings?: string[] } | undefined)?.warnings) ?? [];
}

// The four bodies every rich-text write path must handle. Raw HTML with the
// flag set is the caller's own markup; escaped HTML with the flag set is the
// mistake that stored visible tags on 16 project tasks.
const RAW_HTML = "<p><b>Context:</b><br>Most users open this on a phone.</p>";
const ESCAPED_HTML = "&lt;p&gt;&lt;b&gt;Context:&lt;/b&gt;&lt;br&gt;Most users open this on a phone.&lt;/p&gt;";
const PLAIN_LINES = "First line\nSecond line";
const PLAIN_ANGLE = "Call HYPERION <before arrival>";

describe("common Agent write paths", () => {
  it("routes update, public method, Chatter, and Activity writes exactly once", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/message_post")) return Response.json({ id: 77 });
      if (String(url).endsWith("/activity_schedule")) return Response.json(88);
      return Response.json(true);
    });
    const client = await connected(fetcher);

    const update = await client.callTool({
      name: "odoo_update_records",
      arguments: {
        model: "project.task",
        ids: [492],
        values: { description: "Confirmed itinerary", priority: "1" },
        context: { allowed_company_ids: [1] }
      }
    });
    const method = await client.callTool({
      name: "odoo_call_method",
      arguments: {
        model: "project.task",
        method: "write",
        ids: [492],
        kwargs: { vals: { priority: "1" } },
        context: { allowed_company_ids: [1] }
      }
    });
    const message = await client.callTool({
      name: "odoo_post_message",
      arguments: {
        model: "project.task",
        id: 492,
        body: "Call HYPERION <before arrival>",
        subtype: "mail.mt_note",
        context: { allowed_company_ids: [1] }
      }
    });
    const activity = await client.callTool({
      name: "activities_schedule",
      arguments: {
        model: "project.task",
        id: 492,
        activity_type_id: 4,
        user_id: 9,
        summary: "Call HYPERION",
        date_deadline: "2026-09-08",
        context: { allowed_company_ids: [1] }
      }
    });

    for (const result of [update, method, message]) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        data: { execution: { correlation_id: "correlation-test", outcome: "succeeded" } }
      });
    }
    expect(activity.isError).not.toBe(true);
    expect(activity.structuredContent).toMatchObject({
      data: { correlation_id: "correlation-test", outcome: "succeeded" }
    });
    expect(jsonCalls(fetcher)).toHaveLength(4);
    expect(requestBody(fetcher, "project.task/write")).toEqual({
      ids: [492],
      vals: { description: "Confirmed itinerary", priority: "1" },
      context: {
        allowed_company_ids: [1],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    const writeCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/project.task/write"));
    expect(writeCalls).toHaveLength(2);
    expect(JSON.parse(String(writeCalls[1]?.[1]?.body))).toEqual({
      vals: { priority: "1" },
      ids: [492],
      context: {
        allowed_company_ids: [1],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(requestBody(fetcher, "project.task/message_post")).toEqual({
      ids: [492],
      body: "<p>Call HYPERION &lt;before arrival&gt;</p>",
      body_is_html: true,
      subtype_xmlid: "mail.mt_note",
      context: {
        allowed_company_ids: [1],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(requestBody(fetcher, "project.task/activity_schedule")).toEqual({
      ids: [492],
      activity_type_id: 4,
      user_id: 9,
      summary: "Call HYPERION",
      date_deadline: "2026-09-08",
      context: {
        allowed_company_ids: [1],
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
  });

  it("turns an upstream 502 during a mutation into an explicit unknown outcome", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      "<html>Bad Gateway</html>",
      { status: 502 }
    ));
    const client = await connected(fetcher);
    const result = await client.callTool({
      name: "odoo_call_method",
      arguments: {
        model: "project.task",
        method: "activity_schedule",
        ids: [492],
        kwargs: {
          act_type_xmlid: "mail.mail_activity_data_call",
          date_deadline: "2026-09-08",
          summary: "Call hotel",
          user_id: 9
        },
        context: {}
      }
    });

    expect(jsonCalls(fetcher, "/project.task/activity_schedule")).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
      error: {
        code: "MCP_UPSTREAM_UNAVAILABLE",
        request_id: "request-test",
        correlation_id: "correlation-test",
        retryable: false,
        condition_retryable: true,
        outcome: "unknown",
        retry_guidance: "reconcile_first",
        stage: "completion_ambiguous",
        known: {
          request_sent: "yes",
          response_received: "yes",
          result_received: "no",
          target_model: "project.task",
          record_ids: [492]
        }
      }
    });
  });
});

describe("the rich-text escaping contract", () => {
  it("stores a project task description exactly as the flag promises", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([2538]));
    const client = await connected(fetcher);
    const create = async (description: string, description_is_html: boolean) => client.callTool({
      name: "projects_create_task",
      arguments: { name: "Add haptic feedback", project_id: 15, description, description_is_html }
    });

    const rawHtml = await create(RAW_HTML, true);
    const escapedHtml = await create(ESCAPED_HTML, true);
    const plainLines = await create(PLAIN_LINES, false);
    const plainAngle = await create(PLAIN_ANGLE, false);

    for (const result of [rawHtml, escapedHtml, plainLines, plainAngle]) {
      expect(result.isError).not.toBe(true);
    }
    const descriptions = requestBodies(fetcher, "project.task/create")
      .map((body) => (body.vals_list as Record<string, unknown>[])[0]?.description);
    expect(descriptions[0]).toBe(RAW_HTML);
    expect(descriptions[1]).toBe(RAW_HTML);
    expect(descriptions[2]).toBe("First line<br>Second line");
    expect(descriptions[3]).toBe("Call HYPERION &lt;before arrival&gt;");

    expect(warningsOf(rawHtml)).toEqual([]);
    expect(warningsOf(plainLines)).toEqual([]);
    expect(warningsOf(plainAngle)).toEqual([]);
    expect(warningsOf(escapedHtml)).toHaveLength(1);
    expect(warningsOf(escapedHtml)[0]).toContain("description");
    expect(warningsOf(escapedHtml)[0]).toContain("description_is_html");
  });

  it("posts a Chatter body exactly as the flag promises", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 77 }));
    const client = await connected(fetcher);
    const post = async (body: string, body_is_html: boolean) => client.callTool({
      name: "odoo_post_message",
      arguments: { model: "project.task", id: 492, body, body_is_html }
    });

    const rawHtml = await post(RAW_HTML, true);
    const escapedHtml = await post(ESCAPED_HTML, true);
    const plainLines = await post(PLAIN_LINES, false);
    const plainAngle = await post(PLAIN_ANGLE, false);

    for (const result of [rawHtml, escapedHtml, plainLines, plainAngle]) {
      expect(result.isError).not.toBe(true);
    }
    const bodies = requestBodies(fetcher, "project.task/message_post").map((body) => body.body);
    expect(bodies[0]).toBe(RAW_HTML);
    expect(bodies[1]).toBe(RAW_HTML);
    expect(bodies[2]).toBe("<p>First line<br>Second line</p>");
    expect(bodies[3]).toBe("<p>Call HYPERION &lt;before arrival&gt;</p>");

    expect(warningsOf(rawHtml)).toEqual([]);
    expect(warningsOf(plainLines)).toEqual([]);
    expect(warningsOf(plainAngle)).toEqual([]);
    expect(warningsOf(escapedHtml)).toHaveLength(1);
    expect(warningsOf(escapedHtml)[0]).toContain("body_is_html");
  });

  it("schedules an activity note under the same contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(88));
    const client = await connected(fetcher);
    const schedule = async (note: string, note_is_html: boolean) => client.callTool({
      name: "activities_schedule",
      arguments: {
        model: "project.task", id: 492, activity_type_id: 4, user_id: 9,
        summary: "Review the card", note, note_is_html
      }
    });

    const escapedHtml = await schedule(ESCAPED_HTML, true);
    const plainAngle = await schedule(PLAIN_ANGLE, false);

    const notes = requestBodies(fetcher, "project.task/activity_schedule").map((body) => body.note);
    expect(notes[0]).toBe(RAW_HTML);
    expect(notes[1]).toBe("Call HYPERION &lt;before arrival&gt;");
    expect(warningsOf(escapedHtml)[0]).toContain("note_is_html");
    expect(warningsOf(plainAngle)).toEqual([]);
  });

  it("states who escapes the body in the schema of every rich-text write path", async () => {
    const client = await connected(vi.fn<typeof fetch>(async () => Response.json(true)));
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const property = (tool: string, field: string) => {
      const properties = (tools.get(tool)?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }).properties ?? {};
      return properties[field]?.description ?? "";
    };

    for (const [tool, field, flag] of [
      ["projects_create_task", "description", "description_is_html"],
      ["odoo_post_message", "body", "body_is_html"],
      ["activities_schedule", "note", "note_is_html"]
    ] as const) {
      expect(property(tool, field), `${tool}.${field}`).toContain(flag);
      expect(property(tool, flag), `${tool}.${flag}`).toContain("false (default): the server escapes");
      expect(property(tool, flag), `${tool}.${flag}`).toContain("raw HTML");
    }
    expect(property("odoo_update_records", "values")).toContain("exactly as given");
  });

  it("leaves a body that only mentions an escaped tag inside real markup untouched", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 78 }));
    const client = await connected(fetcher);
    const body = "<p>Write &lt;b&gt; to make text bold.</p>";
    const result = await client.callTool({
      name: "odoo_post_message",
      arguments: { model: "project.task", id: 492, body, body_is_html: true }
    });

    expect(result.isError).not.toBe(true);
    expect(requestBody(fetcher, "project.task/message_post").body).toBe(body);
    expect(warningsOf(result)).toEqual([]);
  });
});
