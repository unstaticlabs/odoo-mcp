import { describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OdooError } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import { registerDocumentsTools } from "./documents";
import { validatedToolHandler } from "./structured-test-util";

const props = {
  odooBaseUrl: "http://odoo.example.com/",
  odooDb: "test-db",
  odooApiKey: "documents-secret-key"
};

type ToolResult = {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
};

function buildServer(responder: (method: string, args: Record<string, unknown>) => unknown) {
  const calls: { model: string; method: string; args: Record<string, unknown> }[] = [];
  const queue = {
    enqueue: mock(async (_conn: unknown, model: string, method: string, args: Record<string, unknown>) => {
      calls.push({ model, method, args });
      return responder(method, args);
    })
  } as unknown as OdooQueue;
  const server = new McpServer({ name: "documents-test", version: "0.0.0" });
  registerDocumentsTools(server, () => props, queue);
  const handler = (name: string) => validatedToolHandler(server, name) as (args: unknown) => Promise<ToolResult>;
  return { server, calls, handler };
}

describe("documents.* registration", () => {
  test("registers only the nine explicit read-only facade tools", () => {
    const { server } = buildServer(() => ({}));
    const tools = (server as unknown as { _registeredTools: Record<string, any> })._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(
      [
        "documents.find_similar",
        "documents.get",
        "documents.get_content",
        "documents.get_links",
        "documents.get_versions",
        "documents.list_correspondents",
        "documents.list_tags",
        "documents.list_types",
        "documents.search"
      ].sort()
    );
    for (const tool of Object.values(tools) as any[]) {
      expect(tool.title).toBeTruthy();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });
});

describe("documents.search", () => {
  test("calls only mcp_search and turns governed paths into Odoo URLs", async () => {
    const { calls, handler } = buildServer((method) => {
      expect(method).toBe("mcp_search");
      return {
        results: [
          {
            id: 42,
            name: "Supplier contract",
            web_path: "/odoo/usl.document/42",
            preview_path: "/usl_documents/42/preview",
            download_path: "/usl_documents/42/download?original=1",
            excerpt: "bounded OCR",
            provenance: [{ source: "paperless_lexical", rank: 1 }]
          }
        ],
        count: 1,
        offset: 0,
        limit: 10,
        has_more: false,
        truncated: false,
        warnings: []
      };
    });

    const result = await handler("documents.search")({
      query: "contract renewal",
      mode: "hybrid",
      limit: 10,
      offset: 0,
      filters: { company_id: 3, tag_ids: [8], background_mode: "exclude" }
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        model: "usl.document",
        method: "mcp_search",
        args: {
          query: "contract renewal",
          mode: "hybrid",
          limit: 10,
          offset: 0,
          company_id: 3,
          tag_ids: [8],
          background_mode: "exclude"
        }
      }
    ]);
    const item = (result.structuredContent?.results as Record<string, unknown>[])[0];
    expect(item.web_url).toBe("http://odoo.example.com/odoo/usl.document/42");
    expect(item.preview_url).toBe("http://odoo.example.com/usl_documents/42/preview");
    expect(item.download_url).toBe("http://odoo.example.com/usl_documents/42/download?original=1");
    expect(item.web_path).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  test("rejects an unbounded search window before calling Odoo", async () => {
    const { calls, handler } = buildServer(() => {
      throw new Error("must not run");
    });

    const result = await handler("documents.search")({
      query: "contract",
      limit: 25,
      offset: 49
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("documents bounded reads", () => {
  test("get_content forwards only bounded pagination", async () => {
    const { calls, handler } = buildServer(() => ({
      document_id: 7,
      content: "page",
      offset: 200,
      limit: 400,
      next_offset: 204,
      has_more: true,
      total_characters: 1000
    }));

    const result = await handler("documents.get_content")({ document_id: 7, offset: 200, limit: 400 });

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toEqual({
      model: "usl.document",
      method: "mcp_get_content",
      args: { document_id: 7, offset: 200, limit: 400 }
    });
    expect(result.structuredContent?.content).toBe("page");
  });

  test("versions and links receive guarded clickable URLs", async () => {
    const { handler } = buildServer((method) => {
      if (method === "mcp_get_versions") {
        return {
          document_id: 7,
          versions: [
            {
              id: 2,
              preview_path: "/usl_documents/7/preview?version=v1",
              download_path: "/usl_documents/7/download?original=1&version=v1"
            }
          ]
        };
      }
      return {
        document_id: 7,
        links: [{ id: 9, name: "Task", model: "project.task", record_id: 55 }]
      };
    });

    const versions = await handler("documents.get_versions")({ document_id: 7 });
    const links = await handler("documents.get_links")({ document_id: 7 });

    expect((versions.structuredContent?.versions as Record<string, unknown>[])[0].preview_url).toBe(
      "http://odoo.example.com/usl_documents/7/preview?version=v1"
    );
    expect((links.structuredContent?.links as Record<string, unknown>[])[0].web_url).toBe(
      "http://odoo.example.com/odoo/all-tasks/55"
    );
  });

  test("Odoo authorization failures are structured and never echo credentials", async () => {
    const { handler } = buildServer(() => {
      throw new OdooError({
        message: "Access Denied",
        code: "permission_denied",
        httpStatus: 403,
        model: "usl.document",
        method: "mcp_get",
        details: "The document is unavailable."
      });
    });

    const result = await handler("documents.get")({ document_id: 999999 });

    expect(result.isError).toBe(true);
    const text = result.content.map((item) => item.text).join("\n");
    expect(text).toContain("permission_denied");
    expect(text).not.toContain(props.odooApiKey);
  });
});
