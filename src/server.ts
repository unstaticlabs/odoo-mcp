import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools/read";
import { registerResourceTemplates } from "./tools/resources";
import { registerWriteTools } from "./tools/write";

export interface Env {
  McpAgent: DurableObjectNamespace<McpAgent>;
}

export interface Props extends Record<string, unknown> {
  odooBaseUrl: string;
  odooDb: string;
  odooApiKey: string;
}

export class McpAgent extends McpAgentBase<Env, unknown, Props> {
  server = new McpServer({ name: "odoo-mcp", version: "0.1.0" });

  async init() {
    const getProps = () => this.props;
    registerReadTools(this.server, getProps);
    registerResourceTemplates(this.server, getProps);
    registerWriteTools(this.server, getProps);
  }
}
