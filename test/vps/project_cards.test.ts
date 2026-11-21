import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { formatSources, mergeSources, parseSources } from "../../src/capabilities/project_cards.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

const PROPERTIES = [
  { name: "a1b2c3", string: "Sources", type: "char", value: " github:org/repo#12 mattermost:host/abc " },
  { name: "d4e5f6", string: "Owner", type: "many2one", comodel: "res.users", value: [7, "Ada"] }
];

type Handler = (model: string, method: string, body: Record<string, unknown>) => unknown;

async function connected(handler: Handler) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const [model, method] = decodeURIComponent(String(input).split("/json/2/")[1]!).split("/");
    return Response.json(handler(model!, method!, JSON.parse(String(init?.body))));
  });
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({
    ...requestContext(), profile: "projects", availableModules: new Set(["base", "api_doc", "mail", "project"])
  });
  const client = new Client({ name: "project-card-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, fetcher };
}

function bodyOf(fetcher: ReturnType<typeof vi.fn>, method: string) {
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith(`/${method}`));
  return call ? JSON.parse(String(call[1]?.body)) as Record<string, any> : undefined;
}

function taskHandler(stages: unknown[] = [{ id: 5, name: "Done" }]): Handler {
  return (model, method, body) => {
    if (model === "project.task" && method === "read") {
      return [{ id: 42, display_name: "Card", project_id: [3, "P"], stage_id: [1, "Todo"], state: "01_in_progress", github_url: false, task_properties: PROPERTIES }];
    }
    if (model === "project.task.type") return stages;
    if (model === "project.task" && method === "web_save") {
      const vals = body.vals as Record<string, unknown>;
      return [{
        id: 42, display_name: "Card", project_id: { id: 3, display_name: "P" },
        stage_id: { id: vals.stage_id ?? 1, display_name: "Done" }, state: vals.state ?? "01_in_progress",
        github_url: vals.github_url ?? false, task_properties: vals.task_properties ?? PROPERTIES
      }];
    }
    return [];
  };
}

describe("Sources helpers", () => {
  it("dedupes, keeps the space-delimited format and leaves other properties untouched", () => {
    expect(parseSources(" a  b a ")).toEqual(["a", "b"]);
    expect(formatSources([])).toBe("");
    const merged = mergeSources(PROPERTIES, ["github:org/repo#12", "github:org/repo#13"], ["mattermost:host/abc"]);
    expect(merged.properties[0]).toMatchObject({ name: "a1b2c3", value: " github:org/repo#12 github:org/repo#13 " });
    expect(merged.properties[1]).toBe(PROPERTIES[1]);
  });

  it("refuses a project without exactly one Sources property", () => {
    expect(() => mergeSources([PROPERTIES[1]], ["x"], [])).toThrow(/Sources/);
  });
});

describe("projects_update_task", () => {
  it("writes stage, state, description, link and sources in one web_save and confirms the read-back", async () => {
    const { client, fetcher } = await connected(taskHandler());
    const result = await client.callTool({
      name: "projects_update_task",
      arguments: {
        task_id: 42, stage: "done", state: "1_done", link: "https://github.com/org/repo/pull/13",
        description: "<p>Shipped.</p>", description_is_html: true, sources_add: ["github:org/repo#13"]
      }
    });
    expect(result.isError).not.toBe(true);
    const saves = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/project.task/web_save"));
    expect(saves).toHaveLength(1);
    const body = bodyOf(fetcher, "web_save")!;
    expect(body.ids).toEqual([42]);
    expect(body.vals).toMatchObject({
      stage_id: 5, state: "1_done", github_url: "https://github.com/org/repo/pull/13", description: "<p>Shipped.</p>"
    });
    expect(body.vals.task_properties).toEqual([
      { ...PROPERTIES[0], value: " github:org/repo#12 mattermost:host/abc github:org/repo#13 " },
      PROPERTIES[1]
    ]);
    const stageSearch = bodyOf(fetcher, "search_read")!;
    expect(stageSearch.domain).toEqual([["name", "=ilike", "done"], ["project_ids", "in", [3]]]);
    expect(result.structuredContent).toMatchObject({
      data: {
        outcome: "succeeded",
        task: { state: "1_done", stage_id: { id: 5 }, link: "https://github.com/org/repo/pull/13" },
        changed: expect.arrayContaining(["stage_id", "state"])
      }
    });
    expect((result.structuredContent as { warnings?: string[] }).warnings ?? []).toEqual([]);
  });

  it.each([
    ["a stage without state", { stage_id: 5 }, /state/],
    ["markdown", { description: "## Brief\n- one", description_is_html: true }, /Markdown/],
    ["an undeclared description", { description: "<p>x</p>" }, /HTML/],
    ["a non-URL link", { link: "not a url" }, /http/],
    ["no change", {}, /No field/]
  ])("refuses %s before any write", async (_label, args, message) => {
    const { client, fetcher } = await connected(taskHandler());
    const result = await client.callTool({ name: "projects_update_task", arguments: { task_id: 42, ...args } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
    expect(bodyOf(fetcher, "web_save")).toBeUndefined();
  });

  it("refuses an unknown stage and clears a link with an empty string", async () => {
    const missing = await connected(taskHandler([]));
    const refused = await missing.client.callTool({ name: "projects_update_task", arguments: { task_id: 42, stage: "Nope", state: "1_done" } });
    expect(refused.isError).toBe(true);
    expect(bodyOf(missing.fetcher, "web_save")).toBeUndefined();

    const { client, fetcher } = await connected(taskHandler());
    const cleared = await client.callTool({ name: "projects_update_task", arguments: { task_id: 42, link: "" } });
    expect(cleared.isError).not.toBe(true);
    expect(bodyOf(fetcher, "web_save")!.vals).toEqual({ github_url: false });
  });

  it("warns when the read-back disagrees with the request", async () => {
    const base = taskHandler();
    const { client } = await connected((model, method, body) => {
      const result = base(model, method, body);
      return model === "project.task" && method === "web_save" ? [{ ...(result as any[])[0], state: "01_in_progress" }] : result;
    });
    const result = await client.callTool({ name: "projects_update_task", arguments: { task_id: 42, stage_id: 5, state: "1_done" } });
    expect((result.structuredContent as { warnings: string[] }).warnings.join(" ")).toContain("read-back state");
  });
});

describe("activities_complete", () => {
  it("completes several activities in one action_feedback call", async () => {
    const { client, fetcher } = await connected((model, method) => {
      if (method === "read") return [
        { id: 1, res_model: "project.task", res_id: 42, summary: "Call" },
        { id: 2, res_model: "project.task", res_id: 42, summary: "Review" }
      ];
      return model === "mail.activity" ? [11, 12] : [];
    });
    const result = await client.callTool({ name: "activities_complete", arguments: { activity_ids: [1, 2, 2], feedback: "Done, shipped in #13" } });
    expect(result.isError).not.toBe(true);
    const calls = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/mail.activity/action_feedback"));
    expect(calls).toHaveLength(1);
    expect(bodyOf(fetcher, "action_feedback")).toMatchObject({ ids: [1, 2], feedback: "Done, shipped in #13" });
    expect(result.structuredContent).toMatchObject({
      data: { outcome: "succeeded", completed: [{ activity_id: 1, record: { id: 42 } }, { activity_id: 2 }] }
    });
  });

  it("refuses missing activities without writing", async () => {
    const { client, fetcher } = await connected(() => [{ id: 1, res_model: "project.task", res_id: 42, summary: "Call" }]);
    const result = await client.callTool({ name: "activities_complete", arguments: { activity_ids: [1, 2], feedback: "ok" } });
    expect(result.isError).toBe(true);
    expect(bodyOf(fetcher, "action_feedback")).toBeUndefined();
  });
});

describe("projects_get_task_context card fields", () => {
  it("returns link, deprecated PR url when set, and labelled properties with parsed Sources", async () => {
    const { client } = await connected((model, method) => {
      if (model === "project.task" && method === "read") {
        return [{ id: 42, display_name: "Card", state: "01_in_progress", github_url: "https://x.test/1", usl_feedback_pr_url: "https://x.test/old", task_properties: PROPERTIES }];
      }
      return [];
    });
    const result = await client.callTool({ name: "projects_get_task_context", arguments: { task_id: 42 } });
    const task = (result.structuredContent as any).data.context.task;
    expect(task).toMatchObject({
      link: "https://x.test/1", usl_feedback_pr_url: "https://x.test/old",
      sources: ["github:org/repo#12", "mattermost:host/abc"],
      properties: [{ name: "a1b2c3", label: "Sources", type: "char" }, { label: "Owner" }]
    });
    expect(task.task_properties).toBeUndefined();
  });
});
