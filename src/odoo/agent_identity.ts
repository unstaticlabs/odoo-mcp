import { z } from "zod";
import type { RequestContext } from "../runtime/context.js";
import type { OdooClient } from "./client.js";

export const AgentIdentitySchema = z.object({
  schema_version: z.literal(1),
  principal_kind: z.literal("agent"),
  user_id: z.number().int().positive(),
  agent: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(10_000),
    state: z.literal("active")
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
  company_ids: z.array(z.number().int().positive()).min(1).max(100)
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
