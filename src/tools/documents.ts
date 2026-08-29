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
import type { TtlCache } from "../cache";
import type { OdooCallOptions } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { buildRecordUrl, odooOrigin } from "./record-urls";
import { mcpErrorFromException, mcpStructured, requireConnection } from "./shared";

const DOCUMENT_MODEL = "usl.document";
const DOCUMENT_CACHE_TTL_MS = 60_000;
const DEFAULT_LIST_LIMIT = 25;
const MAX_SEARCH_BYTES = 128 * 1024;
const MAX_LIST_BYTES = 96 * 1024;
const MAX_DETAIL_BYTES = 64 * 1024;
const MAX_EXCERPT_CHARACTERS = 500;
const DOCUMENT_LINK_NOTE =
  " Results carry `web_url`, the canonical clickable Odoo link; cite the document by title and link, never as a bare id.";

const zSearchMode = z.enum(["hybrid", "exact", "semantic"]);
const zBackgroundMode = z.enum(["include", "exclude", "only"]);
const zSavedViewScope = z.enum(["all", "shared", "personal"]);
const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const zDocumentFilters = z.object({
  saved_view_id: z.number().int().positive().optional(),
  company_id: z.number().int().positive().optional(),
  tag_ids: z.array(z.number().int().positive()).max(100).transform((ids) => [...new Set(ids)]).optional(),
  correspondent_id: z.number().int().positive().optional(),
  document_type_id: z.number().int().positive().optional(),
  date_from: zIsoDate.optional(),
  date_to: zIsoDate.optional(),
  added_from: zIsoDate.optional(),
  added_to: zIsoDate.optional(),
  source: z.enum(["odoo_upload", "odoo_attachment", "odoo_generated", "paperless"]).optional(),
  confidentiality: z.enum(["internal", "accounting", "hr", "private"]).optional(),
  review_state: z.enum(["needs_attention", "classified", "reviewed"]).optional(),
  linked_state: z.enum(["linked", "unlinked"]).optional(),
  linked_model: z.string().trim().min(1).max(100).optional(),
  linked_id: z.number().int().positive().optional(),
  background_mode: zBackgroundMode.default("include")
}).superRefine((filters, ctx) => {
  if (filters.date_from && filters.date_to && filters.date_from > filters.date_to)
    ctx.addIssue({ code: "custom", message: "date_from must not be after date_to", path: ["date_to"] });
  if (filters.added_from && filters.added_to && filters.added_from > filters.added_to)
    ctx.addIssue({ code: "custom", message: "added_from must not be after added_to", path: ["added_to"] });
  if (Boolean(filters.linked_id) !== Boolean(filters.linked_model))
    ctx.addIssue({ code: "custom", message: "linked_model and linked_id must be provided together", path: ["linked_model"] });
});
const zCatalogValue = z.object({ id: z.number().int().positive(), name: z.string().max(500) });
const zWarning = z.object({
  code: z.string().max(100),
  message: z.string().max(2000),
  recoverable: z.boolean().optional(),
  source: z.string().max(100).optional()
});
const zWarnings = z.array(zWarning).max(25);
const zProvenance = z.object({
  source: z.string().max(100),
  rank: z.number().int().positive().optional(),
  similarity: z.number().finite().optional()
});
const zDocument = z.object({
  id: z.number().int().positive(),
  name: z.string().max(1000).optional(),
  document_date: z.string().max(64).optional(),
  archive_added_at: z.string().max(64).optional(),
  availability_state: z.string().max(100).optional(),
  filename: z.string().max(1000).optional(),
  mime_type: z.string().max(255).optional(),
  mimetype: z.string().max(255).optional(),
  file_size: z.number().int().nonnegative().optional(),
  source: z.string().max(100).optional(),
  intake_role: z.string().max(100).optional(),
  current_version: z.string().max(200).optional(),
  version_count: z.number().int().nonnegative().optional(),
  link_count: z.number().int().nonnegative().optional(),
  confidentiality: z.string().max(100).optional(),
  review_state: z.string().max(100).optional(),
  company: z.union([zCatalogValue, z.literal(false)]).optional(),
  tags: z.array(zCatalogValue).max(100).optional(),
  correspondent: z.union([zCatalogValue, z.literal(false)]).optional(),
  document_type: z.union([zCatalogValue, z.literal(false)]).optional(),
  excerpt: z.string().max(MAX_EXCERPT_CHARACTERS).optional(),
  provenance: z.array(zProvenance).max(25).optional(),
  web_url: z.string().url().optional(),
  preview_url: z.string().url().optional(),
  download_url: z.string().url().optional()
});
const zVersion = z.object({
  id: z.number().int().positive(),
  version_id: z.union([z.string().max(200), z.number().int().nonnegative()]).optional(),
  label: z.string().max(500).optional(),
  created_at: z.string().max(64).optional(),
  filename: z.string().max(1000).optional(),
  mime_type: z.string().max(255).optional(),
  page_count: z.number().int().nonnegative().optional(),
  is_current: z.boolean(),
  is_received_original: z.boolean(),
  source: z.string().max(100).optional(),
  preview_url: z.string().url().optional(),
  download_url: z.string().url().optional()
});
const zDocumentLink = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().max(1000),
  model: z.string().max(100),
  record_id: z.number().int().positive(),
  company: z.string().max(500).optional(),
  document_role: z.string().max(100).optional(),
  linked_at: z.string().max(64).optional(),
  version_id: z.union([z.string().max(200), z.number().int().nonnegative(), z.literal(false)]).optional(),
  web_url: z.string().url()
});
const zSavedViewSummary = z.object({
  id: z.number().int().positive(),
  key: z.string().max(200),
  name: z.string().max(500),
  scope: z.enum(["shared", "personal"])
});
const zSavedView = z.object({
  id: z.number().int().positive(),
  key: z.string().max(200),
  name: z.string().max(500),
  scope: z.enum(["shared", "personal"]),
  system_rule: z.string().max(200),
  archive_native: z.boolean(),
  needs_attention: z.boolean(),
  filters: z.record(z.string(), z.unknown()),
  tags: z.array(zCatalogValue).max(100),
  correspondents: z.array(zCatalogValue).max(100),
  document_types: z.array(zCatalogValue).max(100),
  quick_filters: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      key: z.string().max(200),
      name: z.string().max(500),
      kind: z.string().max(100)
    })
  ).max(100)
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
  saved_view: z.union([zSavedViewSummary, z.literal(false)])
};
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
} as const;

type UnknownRecord = Record<string, unknown>;

const DOCUMENT_FIELDS = [
  "id", "name", "document_date", "archive_added_at", "company", "confidentiality", "review_state", "availability_state",
  "correspondent", "document_type", "tags", "filename", "mime_type", "mimetype", "file_size", "source", "intake_role",
  "current_version", "version_count", "link_count", "excerpt", "provenance"
] as const;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function catalogValue(value: unknown, nameMax = 500): { id: number; name: string } | false | undefined {
  if (value === false) return false;
  if (value == null) return undefined;
  const record = asRecord(value);
  const id = positiveInt(record.id);
  const name = boundedString(record.name, nameMax);
  return id && name !== undefined ? { id, name } : undefined;
}

function catalogValues(value: unknown, limit = 100, nameMax = 500): Array<{ id: number; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((item) => {
    const normalized = catalogValue(item, nameMax);
    return normalized && typeof normalized === "object" ? [normalized] : [];
  });
}

function warnings(value: unknown): Array<{ code: string; message: string; recoverable?: boolean; source?: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).map((item) => {
    const record = asRecord(item);
    return {
      code: boundedString(record.code, 100) ?? "warning",
      message: boundedString(record.message ?? record.details, 2000) ?? "The Documents backend returned a warning.",
      ...(typeof record.recoverable === "boolean" ? { recoverable: record.recoverable } : {}),
      ...(boundedString(record.source, 100) ? { source: boundedString(record.source, 100) } : {})
    };
  });
}

function safeFilters(value: unknown): UnknownRecord {
  const record = asRecord(value);
  const allowed = new Set([
    "company_id", "tag_ids", "correspondent_id", "document_type_id", "date_from", "date_to", "added_from", "added_to",
    "source", "confidentiality", "review_state", "linked_state", "linked_model", "linked_id", "background_mode", "query",
    "linked_record"
  ]);
  const filtered: UnknownRecord = Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).slice(0, 25));
  if (Array.isArray(filtered.tag_ids))
    filtered.tag_ids = [...new Set(filtered.tag_ids.filter((id) => positiveInt(id)).slice(0, 100))];
  for (const key of ["company_id", "correspondent_id", "document_type_id", "linked_id"] as const) {
    if (filtered[key] !== undefined && !positiveInt(filtered[key])) delete filtered[key];
  }
  for (const key of [
    "date_from", "date_to", "added_from", "added_to", "source", "confidentiality", "review_state", "linked_state",
    "linked_model", "background_mode", "query", "linked_record"
  ] as const) {
    if (filtered[key] !== undefined) {
      const normalized = boundedString(filtered[key], key === "query" ? 2048 : key === "linked_model" || key === "linked_record" ? 200 : 32);
      if (normalized === undefined) delete filtered[key];
      else filtered[key] = normalized;
    }
  }
  return filtered;
}

function validateDocumentFilters(value: unknown): UnknownRecord {
  const filters = asRecord(value);
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  for (const key of ["date_from", "date_to", "added_from", "added_to"] as const) {
    if (filters[key] !== undefined && (typeof filters[key] !== "string" || !isoDate.test(filters[key])))
      throw new Error(`${key} must use YYYY-MM-DD`);
  }
  if (typeof filters.date_from === "string" && typeof filters.date_to === "string" && filters.date_from > filters.date_to)
    throw new Error("date_from must not be after date_to");
  if (typeof filters.added_from === "string" && typeof filters.added_to === "string" && filters.added_from > filters.added_to)
    throw new Error("added_from must not be after added_to");
  if (Boolean(filters.linked_id) !== Boolean(filters.linked_model))
    throw new Error("linked_model and linked_id must be provided together");
  return {
    ...filters,
    ...(Array.isArray(filters.tag_ids) ? { tag_ids: [...new Set(filters.tag_ids)] } : {})
  };
}

function savedViewSummary(value: unknown): UnknownRecord | false {
  if (value === false || value == null) return false;
  const record = asRecord(value);
  return {
    id: positiveInt(record.id),
    key: boundedString(record.key, 200) ?? "",
    name: boundedString(record.name, 500) ?? "",
    scope: record.scope === "personal" ? "personal" : "shared"
  };
}

function savedView(value: unknown): UnknownRecord | null {
  const record = asRecord(value);
  const id = positiveInt(record.id);
  if (!id) return null;
  const quickFilters = Array.isArray(record.quick_filters)
    ? record.quick_filters.slice(0, 4).flatMap((item) => {
        const quick = asRecord(item);
        const quickId = nonnegativeInt(quick.id);
        return quickId !== undefined ? [{
          id: quickId,
          key: boundedString(quick.key, 200) ?? "",
          name: boundedString(quick.name, 500) ?? "",
          kind: boundedString(quick.kind, 100) ?? ""
        }] : [];
      })
    : [];
  const result: UnknownRecord = {
    id,
    key: boundedString(record.key, 200) ?? "",
    name: boundedString(record.name, 500) ?? "",
    scope: record.scope === "personal" ? "personal" : "shared",
    system_rule: boundedString(record.system_rule, 200) ?? "",
    archive_native: record.archive_native === true,
    needs_attention: record.needs_attention === true,
    filters: safeFilters(record.filters),
    tags: catalogValues(record.tags, 10, 300),
    correspondents: catalogValues(record.correspondents, 10, 300),
    document_types: catalogValues(record.document_types, 10, 300),
    quick_filters: quickFilters
  };
  return result;
}

function provenance(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).flatMap((item) => {
    const record = asRecord(item);
    const source = boundedString(record.source, 100);
    if (!source) return [];
    return [{
      source,
      ...(positiveInt(record.rank) ? { rank: positiveInt(record.rank) } : {}),
      ...(typeof record.similarity === "number" && Number.isFinite(record.similarity) ? { similarity: record.similarity } : {})
    }];
  });
}

function absolutePath(baseUrl: string, path: unknown): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  return `${odooOrigin(baseUrl)}${path}`;
}

function decorateDocument(baseUrl: string, value: unknown): UnknownRecord {
  const record = asRecord(value);
  const projected: UnknownRecord = Object.fromEntries(
    DOCUMENT_FIELDS.flatMap((key) => record[key] !== undefined ? [[key, record[key]]] : [])
  );
  const id = positiveInt(record.id);
  const webUrl = buildRecordUrl(baseUrl, DOCUMENT_MODEL, id, record);
  const previewUrl = absolutePath(baseUrl, record.preview_path);
  const downloadUrl = absolutePath(baseUrl, record.download_path);
  if (typeof projected.name === "string") projected.name = projected.name.slice(0, 1000);
  if (typeof projected.excerpt === "string") projected.excerpt = projected.excerpt.slice(0, MAX_EXCERPT_CHARACTERS);
  for (const [key, max] of [
    ["document_date", 64], ["archive_added_at", 64], ["availability_state", 100], ["filename", 1000], ["mime_type", 255],
    ["mimetype", 255], ["source", 100], ["intake_role", 100], ["current_version", 200], ["confidentiality", 100],
    ["review_state", 100]
  ] as const) {
    const normalized = boundedString(projected[key], max);
    if (normalized === undefined) delete projected[key];
    else projected[key] = normalized;
  }
  for (const key of ["id"] as const) {
    const normalized = positiveInt(projected[key]);
    if (normalized === undefined) delete projected[key];
    else projected[key] = normalized;
  }
  if (typeof projected.file_size !== "number" || !Number.isInteger(projected.file_size) || projected.file_size < 0)
    delete projected.file_size;
  for (const key of ["version_count", "link_count"] as const)
    if (typeof projected[key] !== "number" || !Number.isInteger(projected[key]) || projected[key] < 0) delete projected[key];
  for (const key of ["company", "correspondent", "document_type"] as const) {
    const normalized = catalogValue(projected[key]);
    if (normalized === undefined) delete projected[key];
    else projected[key] = normalized;
  }
  if (projected.tags !== undefined) projected.tags = catalogValues(projected.tags, 25, 300);
  if (projected.provenance !== undefined) projected.provenance = provenance(projected.provenance);
  const result: UnknownRecord = {
    ...projected,
    ...(webUrl ? { web_url: webUrl } : {}),
    ...(previewUrl ? { preview_url: previewUrl } : {}),
    ...(downloadUrl ? { download_url: downloadUrl } : {})
  };
  for (const key of ["tags", "provenance"] as const) {
    const rows = result[key];
    while (Array.isArray(rows) && rows.length > 0 && jsonBytes(result) > 8 * 1024) rows.pop();
  }
  return result;
}

function decorateSearch(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  const results = Array.isArray(payload.results)
    ? payload.results.slice(0, 25).map((item) => decorateDocument(baseUrl, item)).filter((item) => positiveInt(item.id))
    : [];
  const result: UnknownRecord = {
    results,
    count: typeof payload.count === "number" && payload.count >= 0 ? Math.floor(payload.count) : results.length,
    offset: typeof payload.offset === "number" && payload.offset >= 0 ? Math.floor(payload.offset) : 0,
    limit: typeof payload.limit === "number" && payload.limit > 0 ? Math.min(25, Math.floor(payload.limit)) : results.length || 1,
    has_more: payload.has_more === true,
    truncated: payload.truncated === true || (Array.isArray(payload.results) && payload.results.length > results.length),
    warnings: warnings(payload.warnings),
    mode: ["browse", "hybrid", "exact", "semantic"].includes(String(payload.mode)) ? payload.mode : "exact",
    query: boundedString(payload.query, 2048) ?? "",
    saved_view: savedViewSummary(payload.saved_view)
  };
  boundArrayPayload(result, "results", MAX_SEARCH_BYTES, true);
  return result;
}

function decorateSimilar(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  const results = Array.isArray(payload.results)
    ? payload.results.slice(0, 25).map((item) => decorateDocument(baseUrl, item)).filter((item) => positiveInt(item.id))
    : [];
  const result: UnknownRecord = {
    source_document_id: positiveInt(payload.source_document_id),
    results,
    count: typeof payload.count === "number" && payload.count >= 0 ? Math.floor(payload.count) : results.length,
    warnings: warnings(payload.warnings),
    saved_view: savedViewSummary(payload.saved_view)
  };
  boundArrayPayload(result, "results", MAX_SEARCH_BYTES);
  return result;
}

function decorateVersions(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  const versions = Array.isArray(payload.versions)
    ? payload.versions.slice(0, 100).flatMap((raw) => {
        const version = asRecord(raw);
        const id = positiveInt(version.id);
        if (!id) return [];
        const previewUrl = absolutePath(baseUrl, version.preview_path);
        const downloadUrl = absolutePath(baseUrl, version.download_path);
        return {
          id,
          ...(typeof version.version_id === "string"
            ? { version_id: version.version_id.slice(0, 200) }
            : typeof version.version_id === "number" && Number.isInteger(version.version_id) && version.version_id >= 0
              ? { version_id: version.version_id }
              : {}),
          ...(boundedString(version.label, 500) ? { label: boundedString(version.label, 500) } : {}),
          ...(boundedString(version.created_at, 64) ? { created_at: boundedString(version.created_at, 64) } : {}),
          ...(boundedString(version.filename, 1000) ? { filename: boundedString(version.filename, 1000) } : {}),
          ...(boundedString(version.mime_type, 255) ? { mime_type: boundedString(version.mime_type, 255) } : {}),
          ...(typeof version.page_count === "number" && Number.isInteger(version.page_count) && version.page_count >= 0
            ? { page_count: version.page_count } : {}),
          is_current: version.is_current === true,
          is_received_original: version.is_received_original === true,
          ...(boundedString(version.source, 100) ? { source: boundedString(version.source, 100) } : {}),
          ...(previewUrl ? { preview_url: previewUrl } : {}),
          ...(downloadUrl ? { download_url: downloadUrl } : {})
        };
      })
    : [];
  const result = { document_id: positiveInt(payload.document_id), versions };
  boundArrayPayload(result, "versions", MAX_DETAIL_BYTES);
  return result;
}

function decorateLinks(baseUrl: string, payload: UnknownRecord): UnknownRecord {
  const links = Array.isArray(payload.links)
    ? payload.links.slice(0, 100).flatMap((raw) => {
        const link = asRecord(raw);
        const model = boundedString(link.model, 100);
        const recordId = positiveInt(link.record_id);
        const name = boundedString(link.name, 1000);
        if (!model || !recordId || name === undefined) return [];
        const webUrl = buildRecordUrl(baseUrl, String(link.model ?? ""), link.record_id, link);
        if (!webUrl) return [];
        return [{
          ...(positiveInt(link.id) ? { id: positiveInt(link.id) } : {}),
          name,
          model,
          record_id: recordId,
          ...(boundedString(link.company, 500) ? { company: boundedString(link.company, 500) } : {}),
          ...(boundedString(link.document_role, 100) ? { document_role: boundedString(link.document_role, 100) } : {}),
          ...(boundedString(link.linked_at, 64) ? { linked_at: boundedString(link.linked_at, 64) } : {}),
          ...(typeof link.version_id === "string"
            ? { version_id: link.version_id.slice(0, 200) }
            : typeof link.version_id === "number" && Number.isInteger(link.version_id) && link.version_id >= 0
              ? { version_id: link.version_id }
              : link.version_id === false ? { version_id: false } : {}),
          web_url: webUrl
        }];
      })
    : [];
  const result = { document_id: positiveInt(payload.document_id), links };
  boundArrayPayload(result, "links", MAX_DETAIL_BYTES);
  return result;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundArrayPayload(payload: UnknownRecord, key: string, maxBytes: number, markTruncated = false): void {
  const rows = payload[key];
  if (!Array.isArray(rows)) return;
  while (rows.length > 0 && jsonBytes(payload) * 2 > maxBytes) {
    rows.pop();
    payload.has_more = true;
    if (markTruncated) payload.truncated = true;
  }
  if (jsonBytes(payload) * 2 > maxBytes) throw new Error(`Documents response exceeds ${maxBytes} bytes`);
}

function normalizeCatalogPayload(payload: UnknownRecord): UnknownRecord {
  const results = catalogValues(payload.results);
  const result: UnknownRecord = {
    results,
    offset: typeof payload.offset === "number" && payload.offset >= 0 ? Math.floor(payload.offset) : 0,
    limit: typeof payload.limit === "number" && payload.limit > 0 ? Math.min(100, Math.floor(payload.limit)) : DEFAULT_LIST_LIMIT,
    has_more: payload.has_more === true || (Array.isArray(payload.results) && payload.results.length > results.length)
  };
  boundArrayPayload(result, "results", MAX_LIST_BYTES);
  return result;
}

function normalizeSavedViewsPayload(payload: UnknownRecord): UnknownRecord {
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults.slice(0, 100).flatMap((item) => {
    const normalized = savedView(item);
    return normalized ? [normalized] : [];
  });
  const result: UnknownRecord = {
    results,
    offset: typeof payload.offset === "number" && payload.offset >= 0 ? Math.floor(payload.offset) : 0,
    limit: typeof payload.limit === "number" && payload.limit > 0 ? Math.min(100, Math.floor(payload.limit)) : DEFAULT_LIST_LIMIT,
    has_more: payload.has_more === true || rawResults.length > results.length
  };
  boundArrayPayload(result, "results", MAX_LIST_BYTES);
  return result;
}

const DOCUMENT_CALL_POLICIES: Record<string, OdooCallOptions> = {
  mcp_search: { timeoutMs: 45_000, maxAttempts: 2, retryTimeouts: false, retryNetworkErrors: true },
  mcp_find_similar: { timeoutMs: 45_000, maxAttempts: 2, retryTimeouts: false, retryNetworkErrors: true },
  mcp_get_content: { timeoutMs: 30_000, maxAttempts: 2, retryTimeouts: false, retryNetworkErrors: true }
};

async function credentialFingerprint(apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function callDocumentsFacade(
  queue: OdooQueue,
  getProps: () => Props | undefined,
  method: string,
  args: UnknownRecord,
  cache?: TtlCache
): Promise<{ conn: ReturnType<typeof requireConnection>; payload: UnknownRecord }> {
  const conn = requireConnection(getProps());
  const startedAt = Date.now();
  const compute = async () => asRecord(await queue.enqueue(conn, DOCUMENT_MODEL, method, args, DOCUMENT_CALL_POLICIES[method]));
  let cacheHit = false;
  let payload: UnknownRecord;
  if (cache) {
    const fingerprint = await credentialFingerprint(conn.apiKey);
    const key = `documents:${odooOrigin(conn.url)}:${conn.db}:${fingerprint}:${method}:${JSON.stringify(args)}`;
    const before = cache.getMetrics().cache_hits;
    payload = await cache.getOrCompute(key, DOCUMENT_CACHE_TTL_MS, compute);
    cacheHit = cache.getMetrics().cache_hits > before;
  } else {
    payload = await compute();
  }
  console.info(JSON.stringify({
    event: "documents_facade_call",
    method,
    duration_ms: Date.now() - startedAt,
    payload_bytes: jsonBytes(payload),
    cache_hit: cacheHit
  }));
  return { conn, payload };
}

function legacyText(payload: UnknownRecord): string {
  return JSON.stringify(payload);
}

export function registerDocumentsTools(
  server: McpServer,
  getProps: () => Props | undefined,
  queue: OdooQueue,
  cache?: TtlCache
) {
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
        const normalizedFilters: UnknownRecord = {
          ...validateDocumentFilters(filters),
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
        if (jsonBytes(document) * 2 > MAX_DETAIL_BYTES) throw new Error(`Documents response exceeds ${MAX_DETAIL_BYTES} bytes`);
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
        const normalizedOffset = typeof payload.offset === "number" && payload.offset >= 0 ? Math.floor(payload.offset) : offset;
        const boundedLimit = Math.min(limit, 8000);
        const content = boundedString(payload.content, boundedLimit) ?? "";
        const totalCharacters = typeof payload.total_characters === "number" && payload.total_characters >= 0
          ? Math.floor(payload.total_characters)
          : normalizedOffset + content.length;
        const hasMore = payload.has_more === true || normalizedOffset + content.length < totalCharacters;
        const result = {
          document_id,
          content,
          offset: normalizedOffset,
          limit: boundedLimit,
          next_offset: hasMore ? normalizedOffset + content.length : false,
          has_more: hasMore,
          total_characters: totalCharacters
        };
        return mcpStructured(result, legacyText(result));
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
        saved_view: z.union([zSavedViewSummary, z.literal(false)])
      }
    },
    async ({ document_id, limit, filters }) => {
      try {
        const normalizedFilters: UnknownRecord = {
          ...validateDocumentFilters(filters),
          background_mode: filters?.background_mode ?? "include"
        };
        const { conn, payload } = await callDocumentsFacade(queue, getProps, "mcp_find_similar", {
          document_id,
          limit: limit ?? 10,
          ...normalizedFilters
        });
        const result = decorateSimilar(conn.url, payload);
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
      outputSchema: { document_id: z.number().int().positive(), versions: z.array(zVersion).max(100) }
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
          limit: z.number().int().min(1).max(100).default(DEFAULT_LIST_LIMIT),
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
          const normalizedQuery = (query ?? "").trim();
          const normalizedLimit = limit ?? DEFAULT_LIST_LIMIT;
          const normalizedOffset = offset ?? 0;
          const { payload } = await callDocumentsFacade(
            queue,
            getProps,
            method,
            { query: normalizedQuery, limit: normalizedLimit, offset: normalizedOffset },
            cache
          );
          const result = normalizeCatalogPayload(payload);
          return mcpStructured(result, legacyText(result));
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
        limit: z.number().int().min(1).max(100).default(DEFAULT_LIST_LIMIT),
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
        const normalizedArgs = {
          query: query ?? "",
          scope: scope ?? "all",
          limit: limit ?? DEFAULT_LIST_LIMIT,
          offset: offset ?? 0
        };
        const { payload } = await callDocumentsFacade(queue, getProps, "mcp_list_saved_views", normalizedArgs, cache);
        const result = normalizeSavedViewsPayload(payload);
        return mcpStructured(result, legacyText(result));
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
      outputSchema: { document_id: z.number().int().positive(), links: z.array(zDocumentLink).max(100) }
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
