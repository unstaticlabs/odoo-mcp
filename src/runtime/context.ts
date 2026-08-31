import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OdooConnection } from "../odoo.js";

export const ProfileNameSchema = z.enum([
  "default",
  "all",
  "read-only",
  "accounting",
  "projects",
  "documents",
  "b2c",
  "advanced"
]);

export type ProfileName = z.infer<typeof ProfileNameSchema>;

export interface ResolvedOdooConnection {
  connection: OdooConnection;
  publicOrigin: string;
  targetId: string;
}

export interface RequestContext {
  requestId: string;
  correlationId: string;
  profile: ProfileName;
  principal: ResolvedOdooConnection;
  authInfo?: AuthInfo;
}

export interface LegacyProps extends Record<string, unknown> {
  odooBaseUrl: string;
  odooDb: string;
  odooApiKey: string;
  publicOrigin?: string;
  clientName?: string;
  authMode?: "header" | "oauth";
}
