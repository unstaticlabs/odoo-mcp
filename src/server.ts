import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { callOdoo } from "./odoo";
import { OdooQueue } from "./odoo-queue";
import { TtlCache } from "./cache";
import {
  registerBookkeepingTools,
  registerReportLineTools,
  registerReturnPreviewTools,
  registerSafeWritePlannerTools,
  registerSourceDocumentTools
} from "./tools/bookkeeping";
import { registerReadTools } from "./tools/read";
import { registerResourceTemplates } from "./tools/resources";
import { registerProjectWriteTools } from "./tools/projects";
import { registerWriteTools } from "./tools/write";

export interface Env {
  McpAgent: DurableObjectNamespace<McpAgent>;
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

export class McpAgent extends McpAgentBase<Env, unknown, Props> {
  // Bump this on every future tool-surface change: it's the cache-busting key clients use to refetch the tool list.
  server = new McpServer({ name: "odoo-mcp", version: "0.7.3" });
  odooQueue = new OdooQueue(callOdoo);
  // In-memory only — resets on DO eviction, same as odooQueue above.
  cache = new TtlCache();

  async init() {
    const getProps = () => this.props;
    registerReadTools(this.server, getProps, this.odooQueue, this.cache);
    registerResourceTemplates(this.server, getProps, this.odooQueue);
    registerWriteTools(this.server, getProps, this.odooQueue);
    registerProjectWriteTools(this.server, getProps, this.odooQueue);
    registerBookkeepingTools(this.server, getProps, this.odooQueue, this.cache);
    registerReturnPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    registerReportLineTools(this.server, getProps, this.odooQueue, this.cache);
    registerSourceDocumentTools(this.server, getProps, this.odooQueue);
    // Tools have no direct env access; thread the HMAC secret through as a getter.
    registerSafeWritePlannerTools(this.server, getProps, this.odooQueue, this.cache, () => this.env.CONFIRMATION_SECRET);
  }
}
