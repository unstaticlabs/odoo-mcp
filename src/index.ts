import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

/** Thin Odoo JSON-2 client. Never logs or echoes the caller's API key. */
async function callOdoo(
  conn: OdooConnection,
  model: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const endpoint = `${conn.url.replace(/\/+$/, "")}/json/2/${model}/${method}`;

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
      body: JSON.stringify(args)
    });
  } catch {
    throw new Error(`Odoo request to ${model}.${method} failed: network error`);
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

const DEFAULT_TASK_FIELDS = ["id", "name", "stage_id", "project_id"];

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
        if (!this.props) {
          throw new Error("Missing Odoo connection props");
        }
        const tasks = await callOdoo(
          {
            url: this.props.odooBaseUrl,
            db: this.props.odooDb,
            apiKey: this.props.odooApiKey
          },
          "project.task",
          "search_read",
          { domain, fields }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }]
        };
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
