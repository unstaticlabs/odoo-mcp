import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callOdoo } from "../odoo";
import type { Props } from "../server";
import { countRecords, parseDomainParam, requireConnection, searchRecords } from "./shared";

export function registerResourceTemplates(server: McpServer, getProps: () => Props | undefined) {
  server.registerResource(
    "record",
    new ResourceTemplate("odoo://{model}/record/{id}", { list: undefined }),
    { description: "Read-only: fetch a single Odoo record by id.", mimeType: "application/json" },
    async (uri, variables) => {
      const model = typeof variables.model === "string" ? variables.model : "";
      if (!model.trim()) throw new Error("model must be a non-empty string");
      const idRaw = typeof variables.id === "string" ? variables.id : "";
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer");

      const rows = (await searchRecords(
        requireConnection(getProps()),
        model,
        [["id", "=", id]],
        null,
        1
      )) as unknown[];
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`No ${model} record found for id ${id}`);
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(rows[0], null, 2) }] };
    }
  );

  server.registerResource(
    "search",
    new ResourceTemplate("odoo://{model}/search", { list: undefined }),
    { description: "Read-only: model-agnostic Odoo search_read via URI (domain/fields/limit query params).", mimeType: "application/json" },
    async (uri, variables) => {
      const model = typeof variables.model === "string" ? variables.model : "";
      if (!model.trim()) throw new Error("model must be a non-empty string");

      const domain = parseDomainParam(uri);
      const fieldsParam = uri.searchParams.get("fields");
      const fields = fieldsParam
        ? fieldsParam
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : null;
      const limitParam = uri.searchParams.get("limit");
      const limitNum = limitParam ? Number(limitParam) : 10;
      const limit = Number.isInteger(limitNum) && limitNum > 0 ? limitNum : 10;

      const rows = await searchRecords(requireConnection(getProps()), model, domain, fields, limit);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerResource(
    "count",
    new ResourceTemplate("odoo://{model}/count", { list: undefined }),
    { description: "Read-only: count Odoo records matching a domain (search_count) via URI.", mimeType: "application/json" },
    async (uri, variables) => {
      const model = typeof variables.model === "string" ? variables.model : "";
      if (!model.trim()) throw new Error("model must be a non-empty string");

      const domain = parseDomainParam(uri);
      const count = await countRecords(requireConnection(getProps()), model, domain);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ count }, null, 2) }] };
    }
  );

  server.registerResource(
    "fields",
    new ResourceTemplate("odoo://{model}/fields", { list: undefined }),
    { description: "Read-only: get field schema (name, type, string label) for an Odoo model.", mimeType: "application/json" },
    async (uri, variables) => {
      const model = typeof variables.model === "string" ? variables.model : "";
      if (!model.trim()) throw new Error("model must be a non-empty string");

      const fields = await callOdoo(requireConnection(getProps()), model, "fields_get", {
        attributes: ["type", "string"]
      });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(fields, null, 2) }] };
    }
  );
}
