import { pathToFileURL } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { NextFunction, Request, Response } from "express";
import { ProfileNameSchema, type ProfileName } from "./runtime/context.js";
import { loadRuntimeConfig, resolveDirectConnection, type RuntimeConfig } from "./runtime/config.js";
import { emitEvent } from "./runtime/logging.js";
import {
  createHttpServerFactory,
  createRuntimeServices,
  directAuthInfo,
  type RuntimeServices
} from "./runtime/server.js";

type AuthenticatedRequest = Request & { auth?: AuthInfo };

function requestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

function profileFromRequest(request: Request): ProfileName {
  const raw = request.params.profile;
  return ProfileNameSchema.parse(raw ?? "default");
}

function correlationIdFromRequest(request: Request): string {
  const submitted = request.header("X-Correlation-Id")?.trim();
  return submitted && /^[A-Za-z0-9._-]{1,128}$/.test(submitted) ? submitted : crypto.randomUUID();
}

export function createHttpApp(
  config: RuntimeConfig = loadRuntimeConfig(),
  services: RuntimeServices = createRuntimeServices(config)
) {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    jsonLimit: `${config.requestBytes}b`
  });
  const handlers = new Map<ProfileName, ReturnType<typeof toNodeHandler>>();

  function handler(profile: ProfileName) {
    let current = handlers.get(profile);
    if (!current) {
      const mcp = createMcpHandler(createHttpServerFactory(services.registry, profile), {
        legacy: "stateless",
        responseMode: "json",
        onerror: (error) => emitEvent("mcp.request.completed", {
          profile,
          status: "protocol_error",
          error_name: error.name
        })
      });
      current = toNodeHandler(mcp, {
        onerror: (error) => emitEvent("mcp.request.completed", {
          profile,
          status: "adapter_error",
          error_name: error.name
        })
      });
      handlers.set(profile, current);
    }
    return current;
  }

  function authenticate(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
    const started = Date.now();
    try {
      if (request.headers.authorization) {
        response.status(401).json({
          error: "oauth_not_configured",
          message: "OAuth bearer authentication is not configured for this deployment"
        });
        return;
      }
      const principal = resolveDirectConnection(config, requestHeaders(request));
      if (!principal) {
        response.status(401).json({
          error: "odoo_credentials_required",
          message: "Supply X-Odoo-Url, X-Odoo-Database, and X-Odoo-Api-Key"
        });
        return;
      }
      const requestId = crypto.randomUUID();
      const correlationId = correlationIdFromRequest(request);
      request.auth = directAuthInfo(principal, requestId, correlationId);
      emitEvent("auth.resolved", {
        request_id: requestId,
        correlation_id: correlationId,
        target_id: principal.targetId,
        auth_mode: principal.authMode,
        status: "ok",
        duration_ms: Date.now() - started
      });
      next();
    } catch (error) {
      emitEvent("auth.resolved", {
        auth_mode: "direct",
        status: "rejected",
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Error"
      });
      response.status(401).json({
        error: "invalid_odoo_credentials",
        message: error instanceof Error ? error.message : "Invalid Odoo connection"
      });
    }
  }

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.get("/readyz", (_request, response) => {
    const budget = services.registry.profileBudget("default");
    response.json({
      status: budget.tools <= 20 && budget.schemaTokens <= 15_000 ? "ready" : "not_ready",
      targets: config.targets.length,
      default_profile: budget
    });
  });

  app.all(["/mcp", "/mcp/:profile"], authenticate, async (request: AuthenticatedRequest, response, next) => {
    let profile: ProfileName;
    try {
      profile = profileFromRequest(request);
    } catch {
      response.status(404).json({ error: "unknown_profile" });
      return;
    }
    const requestId = request.auth?.extra?.requestId;
    const correlationId = request.auth?.extra?.correlationId;
    const started = Date.now();
    emitEvent("mcp.request.started", {
      request_id: typeof requestId === "string" ? requestId : undefined,
      correlation_id: typeof correlationId === "string" ? correlationId : undefined,
      profile,
      method: request.method
    });
    response.once("finish", () => emitEvent("mcp.request.completed", {
      request_id: typeof requestId === "string" ? requestId : undefined,
      correlation_id: typeof correlationId === "string" ? correlationId : undefined,
      profile,
      method: request.method,
      status: response.statusCode,
      duration_ms: Date.now() - started
    }));
    try {
      await handler(profile)(request, response, request.body);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    response.status(500).json({
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unexpected server error"
    });
  });
  return app;
}

export function startHttpServer(config: RuntimeConfig = loadRuntimeConfig()): void {
  const app = createHttpApp(config);
  app.listen(config.port, config.host, () => {
    process.stderr.write(`USL Odoo MCP listening on ${config.host}:${config.port}\n`);
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) startHttpServer();
