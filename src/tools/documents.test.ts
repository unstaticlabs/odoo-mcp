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
  test("registers only the ten explicit read-only facade tools", () => {
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
        "documents.list_saved_views",
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
        warnings: [],
        mode: "hybrid",
        query: "contract renewal",
        saved_view: false
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

  test("requires either a query or an accessible saved view", async () => {
    const { calls, handler } = buildServer(() => {
      throw new Error("must not run");
    });

    const result = await handler("documents.search")({});

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("browses a saved view without forcing lexical or semantic text", async () => {
    const savedView = {
      id: 12,
      key: "view:12",
      name: "My reviewed evidence",
      scope: "personal",
      system_rule: "saved",
      archive_native: false,
      needs_attention: false,
      filters: { review_state: "reviewed" },
      tags: [],
      correspondents: [],
      document_types: [],
      quick_filters: []
    };
    const { calls, handler } = buildServer(() => ({
      results: [],
      count: 0,
      offset: 0,
      limit: 10,
      has_more: false,
      truncated: false,
      warnings: [],
      mode: "browse",
      query: "",
      saved_view: savedView
    }));

    const result = await handler("documents.search")({ filters: { saved_view_id: 12 } });

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toEqual({
      model: "usl.document",
      method: "mcp_search",
      args: {
        query: "",
        mode: "hybrid",
        limit: 10,
        offset: 0,
        saved_view_id: 12,
        background_mode: "include"
      }
    });
    expect(result.structuredContent?.saved_view).toEqual(savedView);
  });

  test("forwards the complete saved-view semantic filter scope", async () => {
    const { calls, handler } = buildServer(() => ({
      results: [],
      count: 0,
      offset: 0,
      limit: 5,
      has_more: false,
      truncated: false,
      warnings: [],
      mode: "semantic",
      query: "renewal meaning",
      saved_view: false
    }));

    const result = await handler("documents.search")({
      query: "renewal meaning",
      mode: "semantic",
      limit: 5,
      filters: {
        saved_view_id: 17,
        company_id: 3,
        added_from: "2026-01-01",
        source: "paperless",
        confidentiality: "accounting",
        review_state: "reviewed",
        linked_state: "linked"
      }
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0].args).toEqual({
      query: "renewal meaning",
      mode: "semantic",
      limit: 5,
      offset: 0,
      saved_view_id: 17,
      company_id: 3,
      added_from: "2026-01-01",
      source: "paperless",
      confidentiality: "accounting",
      review_state: "reviewed",
      linked_state: "linked",
      background_mode: "include"
    });
  });
});

describe("documents.list_saved_views", () => {
  test("calls only the governed Odoo saved-view facade", async () => {
    const savedView = {
      id: 21,
      key: "accounting",
      name: "Accounting evidence",
      scope: "shared",
      system_rule: "accounting",
      archive_native: false,
      needs_attention: false,
      filters: {},
      tags: [],
      correspondents: [],
      document_types: [],
      quick_filters: []
    };
    const { calls, handler } = buildServer(() => ({
      results: [savedView],
      offset: 0,
      limit: 25,
      has_more: false
    }));

    const result = await handler("documents.list_saved_views")({
      query: "Accounting",
      scope: "shared",
      limit: 25,
      offset: 0
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        model: "usl.document",
        method: "mcp_list_saved_views",
        args: { query: "Accounting", scope: "shared", limit: 25, offset: 0 }
      }
    ]);
    expect((result.structuredContent?.results as unknown[])[0]).toEqual(savedView);
  });
});

describe("documents.find_similar", () => {
  test("forwards saved-view and structured candidate filters", async () => {
    const savedView = {
      id: 31,
      key: "view:31",
      name: "Reviewed accounting",
      scope: "personal",
      system_rule: "saved",
      archive_native: false,
      needs_attention: false,
      filters: { review_state: "reviewed" },
      tags: [],
      correspondents: [],
      document_types: [],
      quick_filters: []
    };
    const { calls, handler } = buildServer(() => ({
      source_document_id: 7,
      results: [],
      count: 0,
      warnings: [],
      saved_view: savedView
    }));

    const result = await handler("documents.find_similar")({
      document_id: 7,
      filters: {
        saved_view_id: 31,
        confidentiality: "accounting",
        linked_model: "project.project",
        linked_id: 14
      }
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0]).toEqual({
      model: "usl.document",
      method: "mcp_find_similar",
      args: {
        document_id: 7,
        limit: 10,
        saved_view_id: 31,
        confidentiality: "accounting",
        linked_model: "project.project",
        linked_id: 14,
        background_mode: "include"
      }
    });
    expect(result.structuredContent?.saved_view).toEqual(savedView);
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
