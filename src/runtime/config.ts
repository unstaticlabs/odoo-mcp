import { z } from "zod";
import { readFileSync } from "node:fs";
import { normalizeOdooOrigin, validateOdooDatabase } from "../odoo-target.js";
import type { OdooPrincipal } from "./context.js";

const TargetInputSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  publicOrigin: z.string().url(),
  internalOrigin: z.string().url(),
  databases: z.array(z.string().min(1).max(128)).min(1)
}).strict();

export interface OdooTarget {
  id: string;
  publicOrigin: string;
  internalOrigin: string;
  databases: string[];
}

export interface RuntimeConfig {
  host: string;
  port: number;
  publicOrigin: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  targets: OdooTarget[];
  requestBytes: number;
  responseBytes: number;
  targetConcurrency: number;
  allowLocalHttpOdoo: boolean;
  oauth: OAuthRuntimeConfig | null;
  analytics: AnalyticsRuntimeConfig;
}

export type AnalyticsStatus = "disabled" | "ready" | "degraded";

export interface AnalyticsRuntimeConfig {
  status: AnalyticsStatus;
  environment: string;
  apiKey?: string;
  host?: string;
  pseudonymizationKey?: Buffer;
  deploymentId?: string;
  buildId?: string;
  missingConfiguration?: string[];
}

export interface OAuthRuntimeConfig {
  databasePath: string;
  authSecret: string;
  encryptionKey: string;
  trustedOrigins: string[];
  accessTokenSeconds: number;
  refreshTokenSeconds: number;
  grantCeilingSeconds: number;
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function booleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function secretValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) throw new Error(`Set either ${name} or ${name}_FILE, not both`);
  if (!file) return direct || undefined;
  if (!file.startsWith("/")) throw new Error(`${name}_FILE must be an absolute path`);
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error(`${name}_FILE is empty`);
  return value;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeInternalOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("An internal Odoo origin must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("An internal Odoo origin must not contain credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function safeLabel(value: string | undefined, fallback: string, name: string): string {
  const label = value?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)) {
    throw new Error(`${name} must be a 1-128 character operational label`);
  }
  return label;
}

function parseAnalytics(env: NodeJS.ProcessEnv): AnalyticsRuntimeConfig {
  const enabled = booleanEnv(env.MCP_ANALYTICS_ENABLED);
  if (!enabled) {
    try {
      return {
        status: "disabled",
        environment: safeLabel(env.MCP_ENVIRONMENT, "development", "MCP_ENVIRONMENT")
      };
    } catch {
      return { status: "disabled", environment: "development" };
    }
  }
  let environment = "development";
  try {
    environment = safeLabel(env.MCP_ENVIRONMENT, "development", "MCP_ENVIRONMENT");
  } catch {
    return {
      status: "degraded",
      environment: "development",
      missingConfiguration: ["MCP_ENVIRONMENT"]
    };
  }
  const missing = new Set<string>();
  let apiKey: string | undefined;
  let pseudonymizationKey: Buffer | undefined;
  try {
    apiKey = secretValue(env, "POSTHOG_API_KEY");
  } catch {
    missing.add("POSTHOG_API_KEY");
  }
  if (!apiKey) missing.add("POSTHOG_API_KEY");

  const rawHost = env.POSTHOG_HOST?.trim();
  let host: string | undefined;
  try {
    if (!rawHost) throw new Error("missing");
    const parsed = new URL(rawHost);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("invalid");
    }
    host = parsed.origin;
  } catch {
    missing.add("POSTHOG_HOST");
  }

  try {
    const encodedKey = secretValue(env, "MCP_ANALYTICS_PSEUDONYMIZATION_KEY");
    if (!encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw new Error("invalid");
    const decoded = Buffer.from(encodedKey, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== encodedKey) throw new Error("invalid");
    pseudonymizationKey = decoded;
  } catch {
    missing.add("MCP_ANALYTICS_PSEUDONYMIZATION_KEY");
  }

  let deploymentId: string | undefined;
  let buildId: string | undefined;
  try {
    deploymentId = safeLabel(env.MCP_DEPLOYMENT_ID, "", "MCP_DEPLOYMENT_ID");
  } catch {
    missing.add("MCP_DEPLOYMENT_ID");
  }
  try {
    buildId = safeLabel(env.MCP_BUILD_ID, "", "MCP_BUILD_ID");
  } catch {
    missing.add("MCP_BUILD_ID");
  }

  if (missing.size > 0) {
    return {
      status: "degraded",
      environment,
      missingConfiguration: [...missing].sort()
    };
  }
  return {
    status: "ready",
    environment,
    apiKey: apiKey!,
    host: host!,
    pseudonymizationKey: pseudonymizationKey!,
    deploymentId: deploymentId!,
    buildId: buildId!
  };
}

function parseTargets(env: NodeJS.ProcessEnv): unknown[] {
  if (env.ODOO_TARGETS_JSON) {
    const parsed = JSON.parse(env.ODOO_TARGETS_JSON) as unknown;
    if (!Array.isArray(parsed)) throw new Error("ODOO_TARGETS_JSON must contain a JSON array");
    return parsed;
  }
  const publicOrigin = env.ODOO_PUBLIC_ORIGIN ?? env.ODOO_URL;
  const database = env.ODOO_DATABASE ?? env.ODOO_DB;
  if (!publicOrigin || !database) {
    throw new Error("ODOO_TARGETS_JSON or ODOO_PUBLIC_ORIGIN and ODOO_DATABASE are required");
  }
  return [{
    id: "default",
    publicOrigin,
    internalOrigin: env.ODOO_INTERNAL_ORIGIN ?? publicOrigin,
    databases: [database]
  }];
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const allowLocalHttp = booleanEnv(env.MCP_ALLOW_LOCAL_HTTP_ODOO);
  const targets = z.array(TargetInputSchema).min(1).parse(parseTargets(env)).map((target): OdooTarget => ({
    id: target.id,
    publicOrigin: normalizeOdooOrigin(target.publicOrigin, { allowLocalHttp }),
    internalOrigin: normalizeInternalOrigin(target.internalOrigin),
    databases: [...new Set(target.databases.map(validateOdooDatabase))]
  }));
  const duplicate = targets.find((target, index) => targets.findIndex((candidate) => candidate.id === target.id) !== index);
  if (duplicate) throw new Error(`Duplicate Odoo target id: ${duplicate.id}`);

  const host = env.MCP_HOST ?? "127.0.0.1";
  const port = boundedInteger(env.MCP_PORT, 3000, 1, 65535, "MCP_PORT");
  const publicOrigin = new URL(env.MCP_PUBLIC_ORIGIN ?? `http://localhost:${port}`).origin;
  const allowedHosts = csv(env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = csv(env.MCP_ALLOWED_ORIGINS);
  const oauthEnabled = booleanEnv(env.MCP_OAUTH_ENABLED);
  const authSecret = secretValue(env, "BETTER_AUTH_SECRET");
  const encryptionKey = secretValue(env, "MCP_CREDENTIAL_ENCRYPTION_KEY");
  const oauthValues = [env.MCP_OAUTH_DATABASE, authSecret, encryptionKey];
  if (!oauthEnabled && oauthValues.some(Boolean)) {
    throw new Error("Set MCP_OAUTH_ENABLED=true when configuring OAuth storage or secrets");
  }
  if (oauthEnabled && oauthValues.some((value) => !value)) {
    throw new Error("OAuth requires MCP_OAUTH_DATABASE, BETTER_AUTH_SECRET, and MCP_CREDENTIAL_ENCRYPTION_KEY");
  }
  return {
    host,
    port,
    publicOrigin,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : [new URL(publicOrigin).hostname],
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : [new URL(publicOrigin).hostname],
    targets,
    requestBytes: boundedInteger(env.MCP_MAX_REQUEST_BYTES, 1024 * 1024, 1024, 16 * 1024 * 1024, "MCP_MAX_REQUEST_BYTES"),
    responseBytes: boundedInteger(env.MCP_MAX_RESPONSE_BYTES, 1024 * 1024, 1024, 16 * 1024 * 1024, "MCP_MAX_RESPONSE_BYTES"),
    targetConcurrency: boundedInteger(env.MCP_TARGET_CONCURRENCY, 8, 1, 64, "MCP_TARGET_CONCURRENCY"),
    allowLocalHttpOdoo: allowLocalHttp,
    analytics: parseAnalytics(env),
    oauth: oauthEnabled
      ? {
          databasePath: env.MCP_OAUTH_DATABASE!,
          authSecret: authSecret!,
          encryptionKey: encryptionKey!,
          trustedOrigins: csv(env.MCP_OAUTH_TRUSTED_ORIGINS).length > 0
            ? csv(env.MCP_OAUTH_TRUSTED_ORIGINS)
            : [publicOrigin],
          accessTokenSeconds: boundedInteger(env.MCP_OAUTH_ACCESS_TOKEN_SECONDS, 3600, 300, 86_400, "MCP_OAUTH_ACCESS_TOKEN_SECONDS"),
          refreshTokenSeconds: boundedInteger(env.MCP_OAUTH_REFRESH_TOKEN_SECONDS, 180 * 24 * 3600, 3600, 365 * 24 * 3600, "MCP_OAUTH_REFRESH_TOKEN_SECONDS"),
          grantCeilingSeconds: boundedInteger(env.MCP_OAUTH_GRANT_CEILING_SECONDS, 365 * 24 * 3600, 24 * 3600, 2 * 365 * 24 * 3600, "MCP_OAUTH_GRANT_CEILING_SECONDS")
        }
      : null
  };
}

export function resolveDirectConnection(config: RuntimeConfig, headers: Headers): OdooPrincipal | null {
  const submittedOrigin = headers.get("x-odoo-url")?.trim();
  const database = headers.get("x-odoo-database")?.trim();
  const apiKey = headers.get("x-odoo-api-key")?.trim();
  if (!submittedOrigin && !database && !apiKey) return null;
  if (!submittedOrigin || !database || !apiKey) {
    throw new Error("X-Odoo-Url, X-Odoo-Database, and X-Odoo-Api-Key must be supplied together");
  }
  if (apiKey.length > 8192) throw new Error("X-Odoo-Api-Key is too long");
  const publicOrigin = normalizeOdooOrigin(submittedOrigin, {
    allowLocalHttp: config.allowLocalHttpOdoo
  });
  const normalizedDatabase = validateOdooDatabase(database);
  const target = config.targets.find(
    (candidate) => candidate.publicOrigin === publicOrigin && candidate.databases.includes(normalizedDatabase)
  );
  if (!target) throw new Error("The supplied Odoo origin/database is not configured for this MCP deployment");
  return {
    targetId: target.id,
    publicOrigin: target.publicOrigin,
    internalOrigin: target.internalOrigin,
    database: normalizedDatabase,
    apiKey,
    authMode: "direct"
  };
}

export function resolveEnvironmentConnection(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env
): OdooPrincipal {
  const publicOrigin = env.ODOO_URL ?? config.targets[0]?.publicOrigin;
  const database = env.ODOO_DATABASE ?? env.ODOO_DB ?? config.targets[0]?.databases[0];
  const apiKey = env.ODOO_API_KEY;
  if (!publicOrigin || !database || !apiKey) {
    throw new Error("stdio requires ODOO_URL, ODOO_DATABASE, and ODOO_API_KEY");
  }
  const resolved = resolveDirectConnection(config, new Headers({
    "X-Odoo-Url": publicOrigin,
    "X-Odoo-Database": database,
    "X-Odoo-Api-Key": apiKey
  }));
  if (!resolved) throw new Error("Unable to resolve stdio Odoo credentials");
  return { ...resolved, authMode: "stdio" };
}
