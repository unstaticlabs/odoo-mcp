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

function requestBody(fetcher: ReturnType<typeof vi.fn>, method: string) {
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith(`/json/2/${method}`));
  expect(call, `${method} was not called`).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

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
    expect(fetcher).toHaveBeenCalledTimes(4);
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

    expect(fetcher).toHaveBeenCalledTimes(1);
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
