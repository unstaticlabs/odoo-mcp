import { McpAgent as McpAgentBase } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { callOdoo } from "./odoo";
import { OdooQueue } from "./odoo-queue";
import { notAppliedMutationExecution } from "./mutation";
import { TtlCache } from "./cache";
import { registerBillingReadTools, registerBillingWriteTools, registerExpenseLifecycleTools } from "./tools/billing";
import { registerFeedbackTools } from "./tools/feedback";
import { SERVER_VERSION } from "./version";
import { registerInventoryTools } from "./tools/inventory";
import {
  registerBookkeepingTools,
  registerReportLineTools,
  registerReturnPreviewTools,
  registerBookkeepingPreviewTools,
  registerSourceDocumentTools
} from "./tools/bookkeeping";
import { registerDocumentsTools } from "./tools/documents";
import { registerProjectsTools, registerProjectWriteTools } from "./tools/projects";
import { registerReadTools } from "./tools/read";
import { registerAgentGuidance, registerResourceTemplates, SERVER_INSTRUCTIONS } from "./tools/resources";
import { registerWriteTools } from "./tools/write";

export interface Env {
  McpAgent: DurableObjectNamespace<McpAgent>;
  AccountingAgent: DurableObjectNamespace<AccountingAgent>;
  ProjectsAgent: DurableObjectNamespace<ProjectsAgent>;
  DocumentsAgent: DurableObjectNamespace<DocumentsAgent>;
  OdooOriginCoordinator: DurableObjectNamespace;
  /** Token/grant storage for the ChatGPT OAuth shim (workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into handlers it invokes; absent on the raw header path. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Explicit local-development exception; hosted non-loopback HTTP remains forbidden. */
  ALLOW_LOCAL_HTTP_ODOO?: string;
}

export interface Props extends Record<string, unknown> {
  odooBaseUrl: string;
  odooDb: string;
  odooApiKey: string;
  clientName?: string;
  authMode?: "header" | "oauth";
  workerOrigin?: string;
}

// Bump this on every future tool-surface change: it's the cache-busting key clients use to
// refetch the tool list (also stamped into feedback.submit cards to identify the surface seen).
export { SERVER_VERSION } from "./version";

const MUTATION_ERROR_WRAPPED = Symbol("mutation-error-wrapped");

/**
 * Ensure even local/fixed-intent refusals from mutating tools carry a root key,
 * correlation id, and truthful not-applied outcome. Errors raised from
 * `runMutation` already carry richer execution evidence and are left intact.
 */
function attachMutationErrorMetadata(server: McpServer): void {
  type ToolResult = {
    isError?: boolean;
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  type RegisteredTool = {
    annotations?: { readOnlyHint?: boolean };
    handler: ((input: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>) & {
      [MUTATION_ERROR_WRAPPED]?: boolean;
    };
    update: (updates: { callback: (input: Record<string, unknown>, extra?: unknown) => Promise<ToolResult> }) => void;
  };
  const tools = Reflect.get(server, "_registeredTools") as Record<string, RegisteredTool>;
  for (const [toolName, tool] of Object.entries(tools)) {
    if (tool.annotations?.readOnlyHint !== false || tool.handler[MUTATION_ERROR_WRAPPED]) continue;
    const original = tool.handler;
    const wrapped = async (input: Record<string, unknown>, extra?: unknown): Promise<ToolResult> => {
      const result = await original(input, extra);
      if (!result?.isError || !Array.isArray(result.content)) return result;
      const textIndex = result.content.findIndex((block) => block.type === "text" && typeof block.text === "string");
      if (textIndex < 0) return result;
      const originalText = result.content[textIndex].text as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(originalText);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "execution" in parsed) return result;

      const execution = await notAppliedMutationExecution(
        typeof input?.idempotency_key === "string" ? input.idempotency_key : undefined
      );
      const envelope =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>), execution }
          : {
              error: "tool_error",
              tool: toolName,
              model: null,
              method: null,
              http_status: null,
              details: originalText,
              recoverable: false,
              execution
            };
      const content = [...result.content];
      content[textIndex] = { ...content[textIndex], text: JSON.stringify(envelope) };
      return { ...result, content };
    };
    wrapped[MUTATION_ERROR_WRAPPED] = true;
    tool.update({ callback: wrapped });
  }
}

/**
 * Shared plumbing for every endpoint-specific agent. Subclasses differ only in
 * which toolset init() registers; queue, cache, and Props handling are identical,
 * so a token or header credential works the same against any endpoint.
 */
abstract class OdooAgentBase extends McpAgentBase<Env, unknown, Props> {
  private odooQueueInstance?: OdooQueue;
  get odooQueue(): OdooQueue {
    return (this.odooQueueInstance ??= new OdooQueue(callOdoo, {
      coordinator: this.env.OdooOriginCoordinator,
      handshakeRequired: true
    }));
  }
  /** Dependency-injection hook used by local tests; production never assigns this property. */
  set odooQueue(queue: OdooQueue) {
    this.odooQueueInstance = queue;
  }
  // In-memory only — resets on DO eviction, same as odooQueue above.
  cache = new TtlCache();
}

/** Full tool surface at /mcp — the original server, kept intact for existing connectors. */
export class McpAgent extends OdooAgentBase {
  server = new McpServer({ name: "odoo-mcp", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  async init() {
    const getProps = () => this.props;
    registerAgentGuidance(this.server);
    registerProjectsTools(this.server, getProps, this.odooQueue, this.cache);
    registerProjectWriteTools(this.server, getProps, this.odooQueue);
    registerDocumentsTools(this.server, getProps, this.odooQueue, this.cache);
    registerReadTools(this.server, getProps, this.odooQueue, this.cache);
    registerResourceTemplates(this.server, getProps, this.odooQueue);
    registerWriteTools(this.server, getProps, this.odooQueue);
    registerBillingReadTools(this.server, getProps, this.odooQueue);
    registerBillingWriteTools(this.server, getProps, this.odooQueue);
    registerExpenseLifecycleTools(this.server, getProps, this.odooQueue);
    registerInventoryTools(this.server, getProps, this.odooQueue);
    registerFeedbackTools(this.server, getProps, this.odooQueue, this.cache);
    registerBookkeepingTools(this.server, getProps, this.odooQueue, this.cache);
    registerReturnPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    registerReportLineTools(this.server, getProps, this.odooQueue, this.cache);
    registerSourceDocumentTools(this.server, getProps, this.odooQueue);
    registerBookkeepingPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    attachMutationErrorMetadata(this.server);
  }
}

/**
 * Accounting-only surface at /accounting/mcp: bookkeeping, billing, and the
 * advisory bookkeeping preview. Endpoint composition is intentionally unchanged
 * by the authorization redesign.
 */
export class AccountingAgent extends OdooAgentBase {
  server = new McpServer(
    { name: "odoo-mcp-accounting", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  async init() {
    const getProps = () => this.props;
    registerAgentGuidance(this.server);
    registerBillingReadTools(this.server, getProps, this.odooQueue);
    registerBillingWriteTools(this.server, getProps, this.odooQueue);
    registerExpenseLifecycleTools(this.server, getProps, this.odooQueue);
    registerInventoryTools(this.server, getProps, this.odooQueue);
    registerFeedbackTools(this.server, getProps, this.odooQueue, this.cache);
    registerBookkeepingTools(this.server, getProps, this.odooQueue, this.cache);
    registerReturnPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    registerReportLineTools(this.server, getProps, this.odooQueue, this.cache);
    registerSourceDocumentTools(this.server, getProps, this.odooQueue);
    registerBookkeepingPreviewTools(this.server, getProps, this.odooQueue, this.cache);
    attachMutationErrorMetadata(this.server);
  }
}

/** Projects-only surface at /projects/mcp — same purity rule as accounting. */
export class ProjectsAgent extends OdooAgentBase {
  server = new McpServer({ name: "odoo-mcp-projects", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  async init() {
    const getProps = () => this.props;
    registerAgentGuidance(this.server);
    registerProjectsTools(this.server, getProps, this.odooQueue, this.cache);
    registerProjectWriteTools(this.server, getProps, this.odooQueue);
    registerFeedbackTools(this.server, getProps, this.odooQueue, this.cache);
    attachMutationErrorMetadata(this.server);
  }
}

/** Documents-only surface at /documents/mcp — explicit read-only facade methods only. */
export class DocumentsAgent extends OdooAgentBase {
  server = new McpServer({ name: "odoo-mcp-documents", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  async init() {
    const getProps = () => this.props;
    registerAgentGuidance(this.server);
    registerDocumentsTools(this.server, getProps, this.odooQueue, this.cache);
    attachMutationErrorMetadata(this.server);
  }
}
