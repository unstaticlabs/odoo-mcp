import type { RequestContext } from "../../src/runtime/context.js";

export function requestContext(): RequestContext {
  return {
    requestId: "request-test",
    correlationId: "correlation-test",
    profile: "default",
    availablePublicMethods: new Map([
      ["usl.document", new Set([
        "mcp_search",
        "mcp_get",
        "mcp_get_versions",
        "mcp_get_links",
        "mcp_get_content",
        "mcp_find_similar",
        "mcp_list_saved_views",
        "mcp_list_tags",
        "mcp_list_correspondents",
        "mcp_list_types",
        "link_to_record",
        "unlink_from_record",
        "mcp_create_download_grant",
        "mcp_revoke_download_grant"
      ])],
      ["usl.expense.batch", new Set([
        "get_review_summary",
        "apply_context",
        "action_submit",
        "action_approve",
        "action_post"
      ])],
      ["usl.home.service", new Set(["get_ai_attention"])]
    ]),
    enabledFeatures: new Set(["document_materialization"]),
    principal: {
      targetId: "test",
      publicOrigin: "https://odoo.example",
      internalOrigin: "http://odoo:8069",
      database: "test",
      apiKey: "test-key",
      authMode: "direct"
    }
  };
}
