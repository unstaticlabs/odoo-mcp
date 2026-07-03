import type { OdooConnection } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";

export const DEFAULT_TASK_FIELDS = ["id", "name", "stage_id", "project_id"];
export const DEFAULT_GENERIC_FIELDS = ["id", "display_name"];

interface OdooFieldMeta {
  type: string;
  store?: boolean;
}

const TECHNICAL_FIELD_NAMES = new Set(["create_uid", "create_date", "write_uid", "write_date", "__last_update"]);
const EXPENSIVE_FIELD_TYPES = new Set(["binary", "one2many", "many2many"]);
const PRIORITY_FIELD_NAMES = ["id", "name", "display_name", "state", "active"];
export const SMART_FIELD_LIMIT = 15;
export const ALL_FIELDS_SENTINEL = "__all__";

/** Exported for unit testing (see callOdoo export pattern). */
export function pickSmartFields(fieldsMeta: Record<string, OdooFieldMeta>): string[] {
  const candidateNames = Object.entries(fieldsMeta)
    .filter(([name, meta]) => {
      if (name.startsWith("__") || TECHNICAL_FIELD_NAMES.has(name)) return false;
      if (EXPENSIVE_FIELD_TYPES.has(meta.type)) return false;
      if (meta.store === false) return false;
      return true;
    })
    .map(([name]) => name);

  const priority = PRIORITY_FIELD_NAMES.filter((name) => candidateNames.includes(name));
  const rest = candidateNames.filter((name) => !priority.includes(name));
  return [...priority, ...rest].slice(0, SMART_FIELD_LIMIT);
}
export const CORE_MODEL_ALLOWLIST = ["project.task", "project.project", "res.partner", "res.users"];

export function requireConnection(props: Props | undefined): OdooConnection {
  if (!props) throw new Error("Missing Odoo connection props");
  return { url: props.odooBaseUrl, db: props.odooDb, apiKey: props.odooApiKey };
}

export function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Exported for unit testing (see callOdoo export pattern). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function searchRecords(
  queue: OdooQueue,
  conn: OdooConnection,
  model: string,
  domain: unknown[],
  fields: string[] | null,
  limit: number,
  order?: string,
  offset?: number
): Promise<unknown> {
  const cappedLimit = Math.min(limit, 100);
  const resolvedFields = await resolveFields(queue, conn, model, fields);
  return queue.enqueue(conn, model, "search_read", {
    domain,
    fields: resolvedFields,
    limit: cappedLimit,
    offset: offset ?? 0,
    ...(order ? { order } : {})
  });
}

export async function countRecords(queue: OdooQueue, conn: OdooConnection, model: string, domain: unknown[]): Promise<number> {
  if (!model || !model.trim()) throw new Error("model must be a non-empty string");
  return (await queue.enqueue(conn, model, "search_count", { domain })) as number;
}

/** Parses a JSON-array domain from a resource URI's `domain` query param; defaults to []. */
export function parseDomainParam(uri: URL): unknown[] {
  const raw = uri.searchParams.get("domain");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("domain query param must be valid JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("domain query param must be a JSON array");
  return parsed;
}

async function resolveFields(
  queue: OdooQueue,
  conn: OdooConnection,
  model: string,
  fields: string[] | null
): Promise<string[]> {
  if (fields !== null && fields.length === 1 && fields[0] === ALL_FIELDS_SENTINEL) {
    return []; // empty fields array => Odoo search_read returns all fields natively
  }
  if (fields !== null) return fields;

  try {
    const meta = (await queue.enqueue(conn, model, "fields_get", {
      attributes: ["type", "store"]
    })) as Record<string, OdooFieldMeta>;
    return pickSmartFields(meta);
  } catch {
    return DEFAULT_GENERIC_FIELDS; // fields_get failed (e.g. bad model) — fall back rather than error the whole search
  }
}
