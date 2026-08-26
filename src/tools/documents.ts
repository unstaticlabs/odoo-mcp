/**
 * Permission-scoped Documents tools (`documents.*`).
 *
 * Every operation calls one explicit `usl.document.mcp_*` facade method. The
 * Worker never receives a Paperless token and never assembles a Paperless API
 * call: Odoo remains the identity, company, record-rule, linked-record, and
 * archive-binary authorization boundary.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { buildRecordUrl, odooOrigin } from "./record-urls";
import { mcpErrorFromException, mcpStructured, requireConnection } from "./shared";

const DOCUMENT_MODEL = "usl.document";
const DOCUMENT_LINK_NOTE =
  " Results carry `web_url`, the canonical clickable Odoo link; cite the document by title and link, never as a bare id.";

const zSearchMode = z.enum(["hybrid", "exact", "semantic"]);
const zBackgroundMode = z.enum(["include", "exclude", "only"]);
const zSavedViewScope = z.enum(["all", "shared", "personal"]);
const zDocumentFilters = z.object({
  saved_view_id: z.number().int().positive().optional(),
  company_id: z.number().int().positive().optional(),
  tag_ids: z.array(z.number().int().positive()).max(100).optional(),
  correspondent_id: z.number().int().positive().optional(),
  document_type_id: z.number().int().positive().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  added_from: z.string().optional(),
  added_to: z.string().optional(),
  source: z.enum(["odoo_upload", "odoo_attachment", "odoo_generated", "paperless"]).optional(),
  confidentiality: z.enum(["internal", "accounting", "hr", "private"]).optional(),
  review_state: z.enum(["needs_attention", "classified", "reviewed"]).optional(),
  linked_state: z.enum(["linked", "unlinked"]).optional(),
  linked_model: z.string().trim().min(1).max(100).optional(),
  linked_id: z.number().int().positive().optional(),
  background_mode: zBackgroundMode.default("include")
});
const zDocument = z.record(z.string(), z.unknown());
const zWarnings = z.array(z.record(z.string(), z.unknown()));
const zCatalogValue = z.object({ id: z.number().int().positive(), name: z.string() });
const zSavedView = z.object({
  id: z.number().int().positive(),
  key: z.string(),
  name: z.string(),
  scope: z.enum(["shared", "personal"]),
  system_rule: z.string(),
  archive_native: z.boolean(),
  needs_attention: z.boolean(),
  filters: z.record(z.string(), z.unknown()),
  tags: z.array(zCatalogValue),
  correspondents: z.array(zCatalogValue),
  document_types: z.array(zCatalogValue),
  quick_filters: z.array(
    z.object({
      id: z.number().int().positive(),
      key: z.string(),
      name: z.string(),
      kind: z.string()
    })
  )
});
const zSearchOutput = {
  results: z.array(zDocument),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  has_more: z.boolean(),
  truncated: z.boolean(),
  warnings: zWarnings,
  mode: z.enum(["browse", "hybrid", "exact", "semantic"]),
  query: z.string(),
  saved_view: z.union([zSavedView, z.literal(false)])
};
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
} as const;

type UnknownRecord = Record<string, unknown>;

function absolutePath(baseUrl: string, path: unknown): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  return `${odooOrigin(baseUrl)}${path}`;
}

function decorateDocument(baseUrl: string, value: unknown): UnknownRecord {
  const record = (value ?? {}) as UnknownRecord;
  const { web_path, preview_path, download_path, ...rest } = record;
  const id = record.id;
  return {
    ...rest,
    ...(buildRecordUrl(baseUrl, DOCUMENT_MODEL, id, record) ? { web_url: buildRecordUrl(baseUrl, DOCUMENT_MODEL, id, record) } : {}),
    ...(absolutePath(baseUrl, preview_path) ? { preview_url: absolutePath(baseUrl, preview_path) } : {}),
    ...(absolutePath(baseUrl, download_path) ? { download_url: absolutePath(baseUrl, download_path) } : {})
  };
}

function decorateSearch(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  return {
    ...payload,
    results: Array.isArray(payload.results) ? payload.results.map((item) => decorateDocument(baseUrl, item)) : []
  };
}

function decorateVersions(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  const versions = Array.isArray(payload.versions)
    ? payload.versions.map((raw) => {
        const version = (raw ?? {}) as UnknownRecord;
        const { preview_path, download_path, ...rest } = version;
        return {
          ...rest,
          ...(absolutePath(baseUrl, preview_path) ? { preview_url: absolutePath(baseUrl, preview_path) } : {}),
          ...(absolutePath(baseUrl, download_path) ? { download_url: absolutePath(baseUrl, download_path) } : {})
        };
      })
    : [];
  return { ...payload, versions };
}

function decorateLinks(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  const links = Array.isArray(payload.links)
    ? payload.links.map((raw) => {
        const link = (raw ?? {}) as UnknownRecord;
        const webUrl = buildRecordUrl(baseUrl, String(link.model ?? ""), link.record_id, link);
        return { ...link, ...(webUrl ? { web_url: webUrl } : {}) };
      })
    : [];
  return { ...payload, links };
}

async function callDocumentsFacade(
  queue: OdooQueue,
  getProps: () => Props | undefined,
  method: string,
  args: UnknownRecord
): Promise<{ conn: ReturnType<typeof requireConnection>; payload: UnknownRecord }> {
  const conn = requireConnection(getProps());
  const payload = (await queue.enqueue(conn, DOCUMENT_MODEL, method, args)) as UnknownRecord;
  return { conn, payload };
}

function legacyText(payload: UnknownRecord): string {
  return JSON.stringify(payload, null, 2);
}

export function registerDocumentsTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "documents.search",
    {
      title: "Search Documents",
      description:
        "Read-only: permission-scoped Odoo and Paperless retrieval. `hybrid` returns exact lexical results first and appends local BGE-M3 semantic matches; `exact` never embeds; `semantic` is meaning-only and never generative. Set `filters.saved_view_id` to search inside an accessible saved view. An empty query browses that view, or replays its stored query when present. Hybrid mode degrades to exact search with a structured warning when embeddings are unavailable. OCR excerpts are bounded and only returned after Odoo archive-binary authorization." +
        DOCUMENT_LINK_NOTE,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().trim().max(2048).default(""),
        mode: zSearchMode.default("hybrid"),
        limit: z.number().int().min(1).max(25).default(10),
        offset: z.number().int().min(0).max(49).default(0),
        filters: zDocumentFilters.default({ background_mode: "include" })
      },
      outputSchema: zSearchOutput
    },
    async ({ query, mode, limit, offset, filters }) => {
      try {
        const normalizedQuery = query ?? "";
        const normalizedMode = mode ?? "hybrid";
        const normalizedLimit = limit ?? 10;
        const normalizedOffset = offset ?? 0;
        const normalizedFilters = {
          ...(filters ?? {}),
          background_mode: filters?.background_mode ?? "include"
        };
        if (normalizedOffset + normalizedLimit > 50) throw new Error("offset + limit must not exceed 50");
        if (!normalizedQuery && !normalizedFilters.saved_view_id)
          throw new Error("query or filters.saved_view_id is required");
        const { conn, payload } = await callDocumentsFacade(queue, getProps, "mcp_search", {
          query: normalizedQuery,
          mode: normalizedMode,
          limit: normalizedLimit,
          offset: normalizedOffset,
          ...normalizedFilters
        });
        const result = decorateSearch(conn.url, payload);
        return mcpStructured(result, legacyText(result));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_search" });
      }
    }
  );

  server.registerTool(
    "documents.get",
    {
      title: "Get Document",
      description: "Read-only: fetch one governed document's bounded metadata without OCR or integrity hashes." + DOCUMENT_LINK_NOTE,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { document_id: z.number().int().positive() },
      outputSchema: { document: zDocument }
    },
    async ({ document_id }) => {
      try {
        const { conn, payload } = await callDocumentsFacade(queue, getProps, "mcp_get", { document_id });
        const document = decorateDocument(conn.url, payload);
        return mcpStructured({ document }, legacyText(document));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_get" });
      }
    }
  );

  server.registerTool(
    "documents.get_content",
    {
      title: "Get Document Content",
      description:
        "Read-only: return one bounded page of OCR text after Odoo record rules, linked-record access, archive availability, and synchronized Paperless permissions all pass. Reinvoke with next_offset; this tool never returns an unbounded document.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        document_id: z.number().int().positive(),
        offset: z.number().int().min(0).max(1_000_000).default(0),
        limit: z.number().int().min(1).max(8000).default(4000)
      },
      outputSchema: {
        document_id: z.number().int().positive(),
        content: z.string(),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        next_offset: z.union([z.number().int().positive(), z.literal(false)]),
        has_more: z.boolean(),
        total_characters: z.number().int().nonnegative()
      }
    },
    async ({ document_id, offset, limit }) => {
      try {
        const { payload } = await callDocumentsFacade(queue, getProps, "mcp_get_content", {
          document_id,
          offset,
          limit
        });
        return mcpStructured(payload, legacyText(payload));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_get_content" });
      }
    }
  );

  server.registerTool(
    "documents.find_similar",
    {
      title: "Find Similar Documents",
      description:
        "Read-only: find BGE-M3-nearest governed documents using an authorized source document. Optional filters, including `saved_view_id`, constrain candidates before vector retrieval. The source OCR stays inside Paperless; Odoo supplies the mandatory candidate scope and rechecks every returned root." +
        DOCUMENT_LINK_NOTE,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        document_id: z.number().int().positive(),
        limit: z.number().int().min(1).max(25).default(10),
        filters: zDocumentFilters.default({ background_mode: "include" })
      },
      outputSchema: {
        source_document_id: z.number().int().positive(),
        results: z.array(zDocument),
        count: z.number().int().nonnegative(),
        warnings: zWarnings,
        saved_view: z.union([zSavedView, z.literal(false)])
      }
    },
    async ({ document_id, limit, filters }) => {
      try {
        const normalizedFilters = {
          ...(filters ?? {}),
          background_mode: filters?.background_mode ?? "include"
        };
        const { conn, payload } = await callDocumentsFacade(queue, getProps, "mcp_find_similar", {
          document_id,
          limit: limit ?? 10,
          ...normalizedFilters
        });
        const result = decorateSearch(conn.url, payload);
        return mcpStructured(result, legacyText(result));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_find_similar" });
      }
    }
  );

  server.registerTool(
    "documents.get_versions",
    {
      title: "Get Document Versions",
      description:
        "Read-only: list governed file-version metadata and guarded Odoo preview/download links. Integrity hashes are intentionally omitted.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { document_id: z.number().int().positive() },
      outputSchema: { document_id: z.number().int().positive(), versions: z.array(zDocument) }
    },
    async ({ document_id }) => {
      try {
        const { conn, payload } = await callDocumentsFacade(queue, getProps, "mcp_get_versions", { document_id });
        const result = decorateVersions(conn.url, payload);
        return mcpStructured(result, legacyText(result));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_get_versions" });
      }
    }
  );

  const registerCatalogTool = (
    name: "documents.list_tags" | "documents.list_correspondents" | "documents.list_types",
    title: string,
    method: "mcp_list_tags" | "mcp_list_correspondents" | "mcp_list_types",
    noun: string
  ) => {
    server.registerTool(
      name,
      {
        title,
        description: `Read-only: list the active Paperless ${noun} catalog through Odoo's Documents ACLs.`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
          query: z.string().max(200).default(""),
          limit: z.number().int().min(1).max(100).default(100),
          offset: z.number().int().min(0).max(1000).default(0)
        },
        outputSchema: {
          results: z.array(z.object({ id: z.number().int().positive(), name: z.string() })),
          offset: z.number().int().nonnegative(),
          limit: z.number().int().positive(),
          has_more: z.boolean()
        }
      },
      async ({ query, limit, offset }) => {
        try {
          const { payload } = await callDocumentsFacade(queue, getProps, method, { query, limit, offset });
          return mcpStructured(payload, legacyText(payload));
        } catch (err) {
          return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method });
        }
      }
    );
  };

  registerCatalogTool("documents.list_tags", "List Document Tags", "mcp_list_tags", "tag");
  registerCatalogTool(
    "documents.list_correspondents",
    "List Document Correspondents",
    "mcp_list_correspondents",
    "correspondent"
  );
  registerCatalogTool("documents.list_types", "List Document Types", "mcp_list_types", "document-type");

  server.registerTool(
    "documents.list_saved_views",
    {
      title: "List Document Saved Views",
      description:
        "Read-only: list only shared and caller-owned Odoo Documents saved views available to the connected user. Returned IDs can be passed as `filters.saved_view_id` to `documents.search` or `documents.find_similar`; private views owned by another user are indistinguishable from missing views.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().trim().max(200).default(""),
        scope: zSavedViewScope.default("all"),
        limit: z.number().int().min(1).max(100).default(100),
        offset: z.number().int().min(0).max(1000).default(0)
      },
      outputSchema: {
        results: z.array(zSavedView),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        has_more: z.boolean()
      }
    },
    async ({ query, scope, limit, offset }) => {
      try {
        const { payload } = await callDocumentsFacade(queue, getProps, "mcp_list_saved_views", {
          query: query ?? "",
          scope: scope ?? "all",
          limit: limit ?? 100,
          offset: offset ?? 0
        });
        return mcpStructured(payload, legacyText(payload));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_list_saved_views" });
      }
    }
  );

  server.registerTool(
    "documents.get_links",
    {
      title: "Get Document Links",
      description:
        "Read-only: list only linked Odoo records the caller can currently read. Each link has a canonical `web_url`; cite the linked record by name and link, never as a bare id.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { document_id: z.number().int().positive() },
      outputSchema: { document_id: z.number().int().positive(), links: z.array(zDocument) }
    },
    async ({ document_id }) => {
      try {
        const { conn, payload } = await callDocumentsFacade(queue, getProps, "mcp_get_links", { document_id });
        const result = decorateLinks(conn.url, payload);
        return mcpStructured(result, legacyText(result));
      } catch (err) {
        return mcpErrorFromException(err, { model: DOCUMENT_MODEL, method: "mcp_get_links" });
      }
    }
  );
}
