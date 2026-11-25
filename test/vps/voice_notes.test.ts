import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const BASE_MODULES = ["base", "api_doc", "mail", "project", "usl_project"];

async function taskMessages(modules: string[] | null, messages: Record<string, unknown>[]) {
  let requested: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/project.task/read")) {
      return Response.json([{ id: 42, display_name: "[QA] Launch", depend_on_ids: [], depend_on_count: 0, closed_depend_on_count: 0 }]);
    }
    if (url.endsWith("/mail.message/search_read")) {
      requested = body.fields;
      return Response.json(messages);
    }
    return Response.json([]);
  });
  const server = createCapabilityRegistry(new OdooClient(8, 1024 * 1024, fetcher)).createServer({
    ...requestContext(), profile: "projects", ...(modules ? { availableModules: new Set(modules) } : {}),
  });
  const client = new Client({ name: "voice-note-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const result = await client.callTool({ name: "projects_get_task_context", arguments: { task_id: 42 } });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as { data: { context: { messages: Record<string, unknown>[] } } };
    return { requested, messages: content.data.context.messages };
  } finally {
    await client.close(); await server.close();
  }
}

describe("voice note transcripts in record context", () => {
  it("returns the transcript of a voice note whose body is empty", async () => {
    const note = [{ attachment_id: 420, state: "done", text: "[QA] Prepare the minutes before tomorrow." }];
    const { requested, messages } = await taskMessages([...BASE_MODULES, "usl_voice"], [
      { id: 9, body: "<div class=\"o-paragraph\"><br></div>", message_type: "comment", usl_voice_notes: note },
      { id: 8, body: "<p>[QA] Written note</p>", message_type: "comment", usl_voice_notes: false },
    ]);
    expect(requested).toContain("usl_voice_notes");
    expect(messages[0]).toMatchObject({ id: 9, usl_voice_notes: note });
    expect(messages[1]).not.toHaveProperty("usl_voice_notes");
  });

  it("keeps a pending transcription visible so the reader knows text is coming", async () => {
    const note = [{ attachment_id: 421, state: "pending", text: "" }];
    const { requested, messages } = await taskMessages([...BASE_MODULES, "usl_voice"], [
      { id: 9, body: "", message_type: "comment", usl_voice_notes: note },
    ]);
    expect(requested).toContain("usl_voice_notes");
    expect(messages[0]).toMatchObject({ usl_voice_notes: note });
  });

  it("does not ask for the field when the add-on is not installed", async () => {
    const { requested, messages } = await taskMessages(BASE_MODULES, [{ id: 8, body: "<p>[QA] Written note</p>", message_type: "comment" }]);
    expect(requested).not.toContain("usl_voice_notes");
    expect(messages).toEqual([{ id: 8, body: "<p>[QA] Written note</p>", message_type: "comment" }]);
  });

  it("does not ask for the field when the installed modules are unknown", async () => {
    // An unknown field fails the whole read, so an unknown module set must not guess.
    const { requested } = await taskMessages(null, []);
    expect(requested).not.toContain("usl_voice_notes");
  });
});
