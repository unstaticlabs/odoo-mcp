import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connected(
  fetcher: typeof fetch,
  accessMode: "read_only" | "read_write" | "mixed" = "read_write"
) {
  const odoo = new OdooClient(8, 1024 * 1024, fetcher);
  const server = createCapabilityRegistry(odoo, {
    mcpCommit: "a".repeat(40),
    gitopsCommit: "b".repeat(40)
  }).createServer({ ...requestContext(accessMode), profile: "default" });
  const client = new Client({ name: "feedback-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("Agent feedback capability", () => {
  it("is visible on the default surface for a read-only governed Agent", async () => {
    const client = await connected(vi.fn<typeof fetch>(), "read_only");

    expect((await client.listTools()).tools.map((tool) => tool.name))
      .toContain("odoo_submit_feedback");
  });

  it("submits one bounded Odoo transaction with server release identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      task_id: 321,
      display_name: "[Agent feedback] Cannot complete activity",
      project_id: 17,
      stage_id: 126,
      submitted_at: "2026-09-04 04:10:00"
    }));
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_submit_feedback",
      arguments: {
        category: "bug",
        impact: "major",
        title: "Cannot complete activity",
        summary: "The activity completion is denied.",
        affected_tool: "odoo_call_method",
        expected_behavior: "The activity completes.",
        actual_behavior: "The policy rejects mail.activity.",
        reproduction_steps: ["Call action_feedback on an assigned activity."],
        workaround: "Complete it in the Odoo UI."
      }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/json\/2\/usl\.agent\/submit_mcp_feedback$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      feedback: {
        category: "bug",
        correlation_id: "correlation-test",
        reproduction_steps: ["Call action_feedback on an assigned activity."]
      },
      release: {
        mcp_server_version: "1.1.0",
        mcp_commit: "a".repeat(40),
        gitops_commit: "b".repeat(40)
      },
      context: {
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        outcome: "succeeded",
        correlation_id: "correlation-test",
        record: { model: "project.task", id: 321 }
      }
    });
  });

  it("rejects incomplete bug feedback before contacting Odoo", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_submit_feedback",
      arguments: {
        category: "bug",
        impact: "major",
        title: "Incomplete",
        summary: "No reproduction details."
      }
    });

    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("makes one attempt and reports an unknown outcome after ambiguous transport failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("connection reset");
    });
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "odoo_submit_feedback",
      arguments: {
        category: "feature_request",
        impact: "suggestion",
        title: "Add a compact model description",
        summary: "Allow callers to request only selected model metadata."
      }
    });

    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      error: {
        outcome: "unknown",
        retryable: false,
        condition_retryable: true,
        retry_guidance: "reconcile_first",
        stage: "completion_ambiguous",
        known: { request_sent: "unknown", target_model: "project.task" },
        recovery: expect.stringContaining("Do not repeat the mutation yet")
      }
    });
  });
});
