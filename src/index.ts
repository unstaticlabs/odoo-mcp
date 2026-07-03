import { McpAgent, type Env, type Props } from "./server";

export { callOdoo } from "./odoo";
export { OdooQueue } from "./odoo-queue";
export { pickSmartFields, searchRecords, escapeHtml, countRecords } from "./tools/shared";
export { normalizeRecord, normalizeRecords } from "./normalizer";
export type { OdooFieldMeta, FieldsMeta, NormalizeOptions } from "./normalizer";
export { McpAgent };

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
