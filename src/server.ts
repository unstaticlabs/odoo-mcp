import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { callOdoo } from "./odoo";
import { OdooQueue } from "./odoo-queue";
import { TtlCache } from "./cache";
import { registerBillingReadTools, registerBillingWriteTools, registerExpenseLifecycleTools } from "./tools/billing";
import { registerFeedbackTools } from "./tools/feedback";
import {
  registerBookkeepingTools,
  registerReportLineTools,
  registerReturnPreviewTools,
  registerSafeWritePlannerTools,
  registerSourceDocumentTools
} from "./tools/bookkeeping";
import { registerProjectsTools } from "./tools/projects";
import { registerReadTools } from "./tools/read";
import { registerResourceTemplates } from "./tools/resources";
import { registerWriteTools } from "./tools/write";

export interface Env {
  McpAgent: DurableObjectNamespace<McpAgent>;
  AccountingAgent: DurableObjectNamespace<AccountingAgent>;
  ProjectsAgent: DurableObjectNamespace<ProjectsAgent>;
  /** Token/grant storage for the ChatGPT OAuth shim (workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into handlers it invokes; absent on the raw header path. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** HMAC secret for stateless safe-write confirmation tokens (wrangler `vars`/secret). */
  CONFIRMATION_SECRET?: string;
}

export interface Props extends Record<string, unknown> {
  odooBaseUrl: string;
  odooDb: string;
  odooApiKey: string;
  clientName?: string;
}

// Bump this on every future tool-surface change: it's the cache-busting key clients use to
// refetch the tool list (also stamped into feedback.submit cards to identify the surface seen).
export const SERVER_VERSION = "0.17.2";

/**
 * Shared plumbing for every endpoint-specific agent. Subclasses differ only in
 * which toolset init() registers; queue, cache, and Props handling are identical,
 * so a token or header credential works the same against any endpoint.
 */
abstract class OdooAgentBase extends McpAgentBase<Env, unknown, Props> {
  odooQueue = new OdooQueue(callOdoo);
  // In-memory only — resets on DO eviction, same as odooQueue above.
  cache = new TtlCache();
}

/** Full tool surface at /mcp — the original server, kept intact for existing connectors. */
export class McpAgent extends OdooAgentBase {
  server = new McpServer({ name: "odoo-mcp", version: SERVER_VERSION });

  async init() {
    const getProps = () => this.props;
    registerProjectsTools(this.server, getProps, this.odooQueue, this.cache);
    registerReadTools(this.server, getProps, this.odooQueue, this.cache);
    registerResourceTemplates(this.server, getProps, this.odooQueue);
    registerWriteTools(this.server, getProps, this.odooQueue, () => this.env.CONFIRMATION_SECRET);
    registerBillingReadTools(this.server, getProps, this.odooQueue);
    registerBillingWriteTools(this.server, getProps, this.odooQueue);
    registerExpenseLifecycleTools(this.server, getProps, this.odooQueue);
    registerFeedbackTools(this.server, getProps, this.odooQueue, this.cache);
    registerBookkeepingTools(this.server, getProps, this.odooQueue, this.cache);
    registerReturnPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    registerReportLineTools(this.server, getProps, this.odooQueue, this.cache);
    registerSourceDocumentTools(this.server, getProps, this.odooQueue);
    // Tools have no direct env access; thread the HMAC secret through as a getter.
    registerSafeWritePlannerTools(this.server, getProps, this.odooQueue, this.cache, () => this.env.CONFIRMATION_SECRET);
  }
}

/**
 * Accounting-only surface at /accounting/mcp: bookkeeping, billing, and the
 * safe-write planner — deliberately no raw CRUD, so clients with small tool
 * budgets (ChatGPT) get a focused decision space.
 */
export class AccountingAgent extends OdooAgentBase {
  server = new McpServer({ name: "odoo-mcp-accounting", version: SERVER_VERSION });

  async init() {
    const getProps = () => this.props;
    registerBillingReadTools(this.server, getProps, this.odooQueue);
    registerBillingWriteTools(this.server, getProps, this.odooQueue);
    registerExpenseLifecycleTools(this.server, getProps, this.odooQueue);
    registerFeedbackTools(this.server, getProps, this.odooQueue, this.cache);
    registerBookkeepingTools(this.server, getProps, this.odooQueue, this.cache);
    registerReturnPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    registerReportLineTools(this.server, getProps, this.odooQueue, this.cache);
    registerSourceDocumentTools(this.server, getProps, this.odooQueue);
    registerSafeWritePlannerTools(this.server, getProps, this.odooQueue, this.cache, () => this.env.CONFIRMATION_SECRET);
  }
}

/** Projects-only surface at /projects/mcp — same purity rule as accounting. */
export class ProjectsAgent extends OdooAgentBase {
  server = new McpServer({ name: "odoo-mcp-projects", version: SERVER_VERSION });

  async init() {
    const getProps = () => this.props;
    registerProjectsTools(this.server, getProps, this.odooQueue, this.cache);
    registerFeedbackTools(this.server, getProps, this.odooQueue, this.cache);
  }
}
