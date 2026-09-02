import { z } from "zod";
import type { RequestContext } from "../runtime/context.js";
import type { OdooClient } from "./client.js";

export const AgentIdentitySchema = z.object({
  schema_version: z.literal(2),
  principal_kind: z.literal("agent"),
  user_id: z.number().int().positive(),
  agent: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(10_000),
    state: z.literal("active"),
    access_mode: z.enum(["read_only", "read_write"]),
    authority_reduced: z.boolean(),
    partner_id: z.number().int().positive()
  }).strict(),
  owner: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(200)
  }).strict(),
  credential: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(200),
    expires_at: z.string().min(1).max(64)
  }).strict(),
  company_id: z.number().int().positive(),
  company_ids: z.array(z.number().int().positive()).min(1).max(100),
  companies: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(200)
  }).strict()).min(1).max(100),
  effective_applications: z.array(z.object({
    id: z.union([z.number().int().positive(), z.literal("settings")]),
    name: z.string().min(1).max(200),
    access: z.enum(["read_only", "read_write"])
  }).strict()).max(500),
  effective_group_ids: z.array(z.number().int().positive()).max(2_000)
}).strict();

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export async function loadAgentIdentity(
  client: OdooClient,
  context: RequestContext,
  signal?: AbortSignal
): Promise<AgentIdentity> {
  const identity = await client.call<unknown>(context, "usl.agent", "current_identity", {}, { signal });
  const parsed = AgentIdentitySchema.safeParse(identity);
  if (!parsed.success) {
    throw new Error(
      "This Odoo key is not a governed Agent credential. Create an Agent in My Agents, then generate its API key."
    );
  }
  return parsed.data;
}
