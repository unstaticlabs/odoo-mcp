import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ODOO_TIMEOUT_MS = 15_000;
const ODOO_MAX_ATTEMPTS = 3;
const ODOO_RETRY_DELAY_MS = 500;
const ODOO_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);


export interface Env {
  McpAgent: DurableObjectNamespace<McpAgent>;
}

export interface Props extends Record<string, unknown> {
  odooBaseUrl: string;
  odooDb: string;
  odooApiKey: string;
}

interface OdooConnection {
  url: string;
  db: string;
  apiKey: string;
}

function extractOdooErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === "string") return errorRecord.message;
    const data = errorRecord.data;
    if (data && typeof data === "object") {
      const message = (data as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  if (typeof record.message === "string") return record.message;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thin Odoo JSON-2 client. Never logs or echoes the caller's API key. */
export async function callOdoo(
  conn: OdooConnection,
  model: string,
  method: string,
  args: Record<string, unknown>,
  timeoutMs: number = ODOO_TIMEOUT_MS
): Promise<unknown> {
  const endpoint = `${conn.url.replace(/\/+$/, "")}/json/2/${model}/${method}`;

  for (let attempt = 1; attempt <= ODOO_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${conn.apiKey}`,
          "X-Odoo-Database": conn.db,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(args),
        signal: controller.signal
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < ODOO_MAX_ATTEMPTS) {
          continue;
        }
        throw new Error(`Odoo request to ${model}.${method} timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Odoo request to ${model}.${method} failed: network error`);
    } finally {
      clearTimeout(timer);
    }

    if (ODOO_RETRYABLE_STATUS.has(response.status) && attempt < ODOO_MAX_ATTEMPTS) {
      await sleep(ODOO_RETRY_DELAY_MS);
      continue;
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const detail = extractOdooErrorMessage(payload) ?? response.statusText;
      throw new Error(`Odoo ${model}.${method} failed (${response.status}): ${detail}`);
    }

    if (payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)) {
      const detail = extractOdooErrorMessage(payload) ?? "unknown error";
      throw new Error(`Odoo ${model}.${method} returned an error: ${detail}`);
    }

    if (payload && typeof payload === "object" && "result" in (payload as Record<string, unknown>)) {
      return (payload as Record<string, unknown>).result;
    }
    return payload;
  }

  throw new Error(`Odoo request to ${model}.${method} failed`);
}


const DEFAULT_TASK_FIELDS = ["id", "name", "stage_id", "project_id"];
const DEFAULT_GENERIC_FIELDS = ["id", "display_name"];

interface OdooFieldMeta {
  type: string;
  store?: boolean;
}

const TECHNICAL_FIELD_NAMES = new Set(["create_uid", "create_date", "write_uid", "write_date", "__last_update"]);
const EXPENSIVE_FIELD_TYPES = new Set(["binary", "one2many", "many2many"]);
const PRIORITY_FIELD_NAMES = ["id", "name", "display_name", "state", "active"];
const SMART_FIELD_LIMIT = 15;
const ALL_FIELDS_SENTINEL = "__all__";

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
const CORE_MODEL_ALLOWLIST = ["project.task", "project.project", "res.partner", "res.users"];

function requireConnection(props: Props | undefined): OdooConnection {
  if (!props) throw new Error("Missing Odoo connection props");
  return { url: props.odooBaseUrl, db: props.odooDb, apiKey: props.odooApiKey };
}

function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export async function searchRecords(
  conn: OdooConnection,
  model: string,
  domain: unknown[],
  fields: string[] | null,
  limit: number
): Promise<unknown> {
  const cappedLimit = Math.min(limit, 100);
  const resolvedFields = await resolveFields(conn, model, fields);
  return callOdoo(conn, model, "search_read", {
    domain,
    fields: resolvedFields,
    limit: cappedLimit
  });
}

async function resolveFields(conn: OdooConnection, model: string, fields: string[] | null): Promise<string[]> {
  if (fields !== null && fields.length === 1 && fields[0] === ALL_FIELDS_SENTINEL) {
    return []; // empty fields array => Odoo search_read returns all fields natively
  }
  if (fields !== null) return fields;

  try {
    const meta = (await callOdoo(conn, model, "fields_get", {
      attributes: ["type", "store"]
    })) as Record<string, OdooFieldMeta>;
    return pickSmartFields(meta);
  } catch {
    return DEFAULT_GENERIC_FIELDS; // fields_get failed (e.g. bad model) — fall back rather than error the whole search
  }
}

export class McpAgent extends McpAgentBase<Env, unknown, Props> {
  server = new McpServer({ name: "odoo-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "projects.list_tasks",
      {
        description: "Read-only: list Odoo project.task records matching a domain.",
        inputSchema: {
          domain: z.array(z.any()).default([]),
          fields: z.array(z.string()).default(DEFAULT_TASK_FIELDS)
        }
      },
      async ({ domain, fields }) => {
        try {
          const tasks = await searchRecords(requireConnection(this.props), "project.task", domain, fields, 100);
          return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] };
        } catch (err) {
          return mcpError(err instanceof Error ? err.message : "projects.list_tasks failed");
        }
      }
    );

    this.server.registerTool(
      "list_models",
      {
        description: "Read-only: list enabled/installed Odoo models (name and technical model name).",
        inputSchema: {}
      },
      async () => {
        const conn = requireConnection(this.props);
        try {
          const rows = await searchRecords(conn, "ir.model", [], ["model", "name"], 100);
          return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
        } catch {
          const fallback = CORE_MODEL_ALLOWLIST.map((model) => ({ model }));
          return { content: [{ type: "text" as const, text: JSON.stringify(fallback, null, 2) }] };
        }
      }
    );

    this.server.registerTool(
      "search_records",
      {
        description: "Read-only: model-agnostic Odoo search_read.",
        inputSchema: {
          model: z.string(),
          domain: z.array(z.any()).default([]),
          fields: z.array(z.string()).nullable().default(null),
          limit: z.number().int().min(1).max(100).default(10)
        }
      },
      async ({ model, domain, fields, limit }) => {
        if (!model || !model.trim()) return mcpError("model must be a non-empty string");
        try {
          const rows = await searchRecords(requireConnection(this.props), model, domain, fields, limit);
          return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
        } catch (err) {
          return mcpError(err instanceof Error ? err.message : "search_records failed");
        }
      }
    );

    this.server.registerTool(
      "get_record",
      {
        description: "Read-only: fetch a single Odoo record by id.",
        inputSchema: {
          model: z.string(),
          record_id: z.number(),
          fields: z.array(z.string()).nullable().default(null)
        }
      },
      async ({ model, record_id, fields }) => {
        if (!model || !model.trim()) return mcpError("model must be a non-empty string");
        if (!Number.isInteger(record_id) || record_id <= 0) return mcpError("record_id must be a positive integer");
        try {
          const rows = (await searchRecords(
            requireConnection(this.props),
            model,
            [["id", "=", record_id]],
            fields,
            1
          )) as unknown[];
          if (!Array.isArray(rows) || rows.length === 0) {
            return mcpError(`No ${model} record found for id ${record_id}`);
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(rows[0], null, 2) }] };
        } catch (err) {
          return mcpError(err instanceof Error ? err.message : "get_record failed");
        }
      }
    );

    this.server.registerTool(
      "get_fields",
      {
        description: "Read-only: get field schema (name, type, string label) for an Odoo model.",
        inputSchema: {
          model: z.string()
        }
      },
      async ({ model }) => {
        if (!model || !model.trim()) return mcpError("model must be a non-empty string");
        try {
          const fields = await callOdoo(requireConnection(this.props), model, "fields_get", {
            attributes: ["type", "string"]
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(fields, null, 2) }] };
        } catch (err) {
          return mcpError(err instanceof Error ? err.message : "get_fields failed");
        }
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/mcp")) {
      return new Response("Not found", { status: 404 });
    }

    const authHeader = request.headers.get("Authorization");
    const odooBaseUrl = request.headers.get("X-Odoo-Url");
    const odooDb = request.headers.get("X-Odoo-Db");
    const odooApiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

    if (!odooApiKey || !odooBaseUrl || !odooDb) {
      return new Response(
        JSON.stringify({ error: "Missing or malformed Authorization / X-Odoo-Url / X-Odoo-Db headers" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const props: Props = { odooBaseUrl, odooDb, odooApiKey };
    return McpAgent.serve("/mcp", { binding: "McpAgent" }).fetch(request, env, { ...ctx, props });
  }
} satisfies ExportedHandler<Env>;
