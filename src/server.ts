import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { callOdoo } from "./odoo";
import { OdooQueue } from "./odoo-queue";
import { registerReadTools } from "./tools/read";
import { registerResourceTemplates } from "./tools/resources";
import { registerWriteTools } from "./tools/write";

export interface Env {
  McpAgent: DurableObjectNamespace<McpAgent>;
  /** Token/grant storage for the ChatGPT OAuth shim (workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into handlers it invokes; absent on the raw header path. */
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface Props extends Record<string, unknown> {
  odooBaseUrl: string;
  odooDb: string;
  odooApiKey: string;
}

export class McpAgent extends McpAgentBase<Env, unknown, Props> {
  server = new McpServer({ name: "odoo-mcp", version: "0.1.0" });
  odooQueue = new OdooQueue(callOdoo);

  async init() {
    const getProps = () => this.props;
    registerReadTools(this.server, getProps, this.odooQueue);
    registerResourceTemplates(this.server, getProps, this.odooQueue);
    registerWriteTools(this.server, getProps, this.odooQueue);
  }
}
