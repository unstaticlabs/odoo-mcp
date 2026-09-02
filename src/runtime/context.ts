import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

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
export type OdooAuthMode = "direct" | "oauth" | "stdio";

export interface OdooPrincipal {
  targetId: string;
  publicOrigin: string;
  internalOrigin: string;
  database: string;
  apiKey: string;
  authMode: OdooAuthMode;
}

export interface RequestContext {
  requestId: string;
  correlationId: string;
  profile: ProfileName;
  principal: OdooPrincipal;
  availableModules?: ReadonlySet<string> | null;
  authInfo?: AuthInfo;
}

export function createRequestContext(
  profile: ProfileName,
  principal: OdooPrincipal,
  authInfo?: AuthInfo
): RequestContext {
  const requestId = typeof authInfo?.extra?.requestId === "string"
    ? authInfo.extra.requestId
    : crypto.randomUUID();
  const correlationId = typeof authInfo?.extra?.correlationId === "string"
    ? authInfo.extra.correlationId
    : crypto.randomUUID();
  return {
    requestId,
    correlationId,
    profile,
    principal,
    ...(authInfo ? { authInfo } : {})
  };
}

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): OdooPrincipal {
  const value = authInfo?.extra?.odoo;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("An authenticated Odoo connection is required");
  }
  return z.object({
    targetId: z.string().min(1),
    publicOrigin: z.string().url(),
    internalOrigin: z.string().url(),
    database: z.string().min(1).max(128),
    apiKey: z.string().min(1).max(8192),
    authMode: z.enum(["direct", "oauth", "stdio"])
  }).strict().parse(value);
}
