import { z } from "zod";
import { OdooClient } from "../odoo/client.js";
import { attributedContext } from "../odoo/schemas.js";
import { CapabilityRegistry, defineCapability } from "./registry.js";

const GuidePageSchema = z.object({
  path: z.string(), url: z.string(), title: z.string(), type: z.string(),
  description: z.string(), lang: z.string(), persona: z.string().nullable(),
  app: z.string().nullable(), score: z.number(), snippet: z.string()
}).strict();

export function registerDocsCapability(registry: CapabilityRegistry, client: OdooClient): void {
  registry.add(defineCapability({
    id: "docs.search", name: "docs_search", title: "Search the User Guide",
    description: "Find instructions in this Odoo release’s user guide. Returns ranked pages with descriptions, matching text and canonical links. For full steps and screenshot references, use odoo_call_method on usl.docs.guide.read_page with the returned path. Native guide access applies.",
    layer: "semantic", toolsets: ["core", "docs"], profiles: [], effect: "read",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    keywords: ["guide", "help", "instructions", "documentation", "how to", "steps"],
    requiredModules: ["usl_docs"], defaultVisible: true, alwaysLoad: false, sortOrder: 75,
    // The guide is an abstract model with native read access, not CRUD ACL rows.
    // Module discovery optimizes visibility; Odoo still authorizes each call.
    input: z.object({
      query: z.string().trim().min(1).max(1000).describe("Question or keywords to find in the user guide."),
      lang: z.string().min(2).max(16).optional().describe("Optional guide language, such as en or fr."),
      limit: z.number().int().min(1).max(50).default(10)
    }).strict(),
    output: z.object({ pages: z.array(GuidePageSchema) }).strict(),
    async handler(input, context, signal) {
      const pages = await client.call<unknown>(context, "usl.docs.guide", "search_pages", {
        ...input, context: attributedContext({}, context.correlationId)
      }, { signal });
      return { data: { pages: z.array(GuidePageSchema).parse(pages).map(page => ({
        ...page, url: new URL(page.url, context.principal.publicOrigin).href
      })) } };
    }
  }));
}
