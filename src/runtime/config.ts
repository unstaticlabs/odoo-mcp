import { z } from "zod";
import { normalizeOdooOrigin, validateOdooDatabase } from "../odoo-target.js";
import type { ResolvedOdooConnection } from "./context.js";

const TargetSchema = z.object({
  id: z.string().min(1).max(64),
  publicOrigin: z.string().url(),
  internalOrigin: z.string().url(),
  databases: z.array(z.string().min(1).max(128)).min(1)
}).strict();

const RuntimeConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  publicOrigin: z.string().url(),
  allowedHosts: z.array(z.string().min(1)),
  allowedOrigins: z.array(z.string().min(1)),
  targets: z.array(TargetSchema).min(1),
  requestBytes: z.number().int().min(1024),
  responseBytes: z.number().int().min(1024)
}).strict();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function parseTargets(value: string | undefined): unknown[] {
  if (value) return JSON.parse(value) as unknown[];
  const publicOrigin = process.env.ODOO_PUBLIC_ORIGIN;
  const database = process.env.ODOO_DATABASE;
  if (!publicOrigin || !database) {
    throw new Error("ODOO_TARGETS_JSON or both ODOO_PUBLIC_ORIGIN and ODOO_DATABASE are required");
  }
  return [{
    id: "default",
    publicOrigin,
    internalOrigin: process.env.ODOO_INTERNAL_ORIGIN ?? "http://odoo:8069",
    databases: [database]
  }];
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = env.MCP_HOST ?? "127.0.0.1";
  const publicOrigin = env.MCP_PUBLIC_ORIGIN ?? `http://localhost:${env.MCP_PORT ?? "3000"}`;
  const parsedTargets = parseTargets(env.ODOO_TARGETS_JSON);
  const targets = z.array(TargetSchema).parse(parsedTargets).map((target) => ({
    ...target,
    publicOrigin: normalizeOdooOrigin(target.publicOrigin, { allowLocalHttp: true }),
    internalOrigin: new URL(target.internalOrigin).origin,
    databases: target.databases.map(validateOdooDatabase)
  }));
  return RuntimeConfigSchema.parse({
    host,
    port: Number(env.MCP_PORT ?? 3000),
    publicOrigin,
    allowedHosts: csv(env.MCP_ALLOWED_HOSTS).length > 0 ? csv(env.MCP_ALLOWED_HOSTS) : [new URL(publicOrigin).hostname],
    allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS).length > 0 ? csv(env.MCP_ALLOWED_ORIGINS) : [new URL(publicOrigin).hostname],
    targets,
    requestBytes: Number(env.MCP_MAX_REQUEST_BYTES ?? 1024 * 1024),
    responseBytes: Number(env.MCP_MAX_RESPONSE_BYTES ?? 1024 * 1024)
  });
}

export function resolveDirectConnection(
  config: RuntimeConfig,
  headers: Headers
): ResolvedOdooConnection | null {
  const submittedOrigin = headers.get("x-odoo-url")?.trim();
  const database = headers.get("x-odoo-database")?.trim();
  const apiKey = headers.get("x-odoo-api-key")?.trim();
  if (!submittedOrigin && !database && !apiKey) return null;
  if (!submittedOrigin || !database || !apiKey) {
    throw new Error("X-Odoo-Url, X-Odoo-Database, and X-Odoo-Api-Key must be supplied together");
  }
  const publicOrigin = normalizeOdooOrigin(submittedOrigin, { allowLocalHttp: true });
  const db = validateOdooDatabase(database);
  const target = config.targets.find(
    (candidate) => candidate.publicOrigin === publicOrigin && candidate.databases.includes(db)
  );
  if (!target) throw new Error("The supplied Odoo origin/database is not configured for this MCP deployment");
  return {
    targetId: target.id,
    publicOrigin: target.publicOrigin,
    connection: { url: target.internalOrigin, db, apiKey, authMode: "header" }
  };
}

export function resolveEnvironmentConnection(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): ResolvedOdooConnection {
  const publicOrigin = env.ODOO_URL ?? config.targets[0]?.publicOrigin;
  const database = env.ODOO_DB ?? config.targets[0]?.databases[0];
  const apiKey = env.ODOO_API_KEY;
  if (!publicOrigin || !database || !apiKey) {
    throw new Error("stdio requires ODOO_URL, ODOO_DB, and ODOO_API_KEY");
  }
  const headers = new Headers({
    "X-Odoo-Url": publicOrigin,
    "X-Odoo-Database": database,
    "X-Odoo-Api-Key": apiKey
  });
  const resolved = resolveDirectConnection(config, headers);
  if (!resolved) throw new Error("Unable to resolve stdio Odoo credentials");
  return resolved;
}
