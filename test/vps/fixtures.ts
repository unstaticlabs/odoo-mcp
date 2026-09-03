import type { RequestContext } from "../../src/runtime/context.js";

const testAgentIdentity = {
  schema_version: 3 as const,
  principal_kind: "agent" as const,
  user_id: 41,
  agent: {
    id: 7,
    name: "Test Agent",
    purpose: "Exercise the MCP capability registry.",
    state: "active" as const,
    access_mode: "read_write" as const,
    authority_reduced: false,
    partner_id: 43
  },
  owner: { id: 5, name: "Test Owner" },
  credential: { id: 9, name: "Test key", expires_at: "2027-09-02 00:00:00" },
  company_id: 1,
  company_ids: [1, 2],
  companies: [{ id: 1, name: "USL" }, { id: 2, name: "USL MEDIA" }],
  effective_applications: [{ id: 10, name: "Accounting", access: "read_write" as const }],
  effective_group_ids: [1, 10]
};

export function requestContext(accessMode: "read_only" | "read_write" | "mixed" = "read_write"): RequestContext {
  const writeAccess = accessMode !== "read_only";
  const expenseBatchMethods = accessMode === "read_only"
    ? new Set(["get_review_summary"])
    : new Set(["get_review_summary", "apply_context", "action_submit", "action_approve", "action_post"]);
  const modelAccess = new Map([
    "account.account",
    "account.move",
    "account.move.line",
    "account.tax",
    "hr.expense",
    "ir.attachment",
    "mail.activity",
    "mail.message",
    "project.project",
    "project.task",
    "rebuild.account.management.summary.line",
    "rebuild.account.overview",
    "rebuild.account.tax.report.line",
    "res.partner",
    "stock.picking",
    "usl.b2c.order",
    "usl.document",
    "usl.expense.batch"
  ].map((model) => [model, {
    read: true,
    create: writeAccess,
    write: writeAccess,
    unlink: writeAccess
  }] as const));
  const identity = {
    ...testAgentIdentity,
    agent: { ...testAgentIdentity.agent, access_mode: accessMode },
    effective_applications: accessMode === "mixed"
      ? [
          { id: 10, name: "Accounting", access: "read_only" as const },
          { id: 11, name: "Projects", access: "read_write" as const }
        ]
      : testAgentIdentity.effective_applications.map((application) => ({
          ...application,
          access: accessMode
        }))
  };
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
      ["usl.expense.batch", expenseBatchMethods],
      ["usl.home.service", new Set(["get_ai_attention"])],
      ["mail.activity", new Set(["activity_schedule"])],
      ["mail.thread", new Set(["action_archive", "message_post", "message_subscribe", "message_unsubscribe"])],
      ["hr.expense", writeAccess
        ? new Set([
            "action_reset",
            "action_submit",
            "action_approve",
            "action_submit_expenses",
            "action_approve_expenses",
            "action_post_entries"
          ])
        : new Set<string>()]
    ]),
    availableModelAccess: modelAccess,
    enabledFeatures: new Set(["document_materialization"]),
    principal: {
      targetId: "test",
      publicOrigin: "https://odoo.example",
      internalOrigin: "http://odoo:8069",
      database: "test",
      apiKey: "test-key",
      authMode: "direct"
    },
    agentIdentity: identity
  };
}
