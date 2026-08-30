import { describe, expect, it } from "vitest";
import {
  loadRuntimeConfig,
  resolveDirectConnection,
  resolveEnvironmentConnection
} from "../../src/runtime/config.js";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ODOO_PUBLIC_ORIGIN: "https://odoo.example",
    ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
    ODOO_DATABASE: "usl",
    MCP_PUBLIC_ORIGIN: "https://mcp.example",
    ...overrides
  };
}

describe("runtime target mapping", () => {
  it("maps an approved public target to its internal VPS origin", () => {
    const config = loadRuntimeConfig(environment());
    const principal = resolveDirectConnection(config, new Headers({
      "X-Odoo-Url": "https://odoo.example/",
      "X-Odoo-Database": "usl",
      "X-Odoo-Api-Key": "secret"
    }));
    expect(principal).toMatchObject({
      targetId: "default",
      publicOrigin: "https://odoo.example",
      internalOrigin: "http://odoo:8069",
      database: "usl",
      authMode: "direct"
    });
  });

  it("requires the direct credential tuple as a unit", () => {
    const config = loadRuntimeConfig(environment());
    expect(() => resolveDirectConnection(config, new Headers({
      "X-Odoo-Url": "https://odoo.example"
    }))).toThrow("must be supplied together");
  });

  it("rejects targets that the operator did not configure", () => {
    const config = loadRuntimeConfig(environment());
    expect(() => resolveDirectConnection(config, new Headers({
      "X-Odoo-Url": "https://other.example",
      "X-Odoo-Database": "usl",
      "X-Odoo-Api-Key": "secret"
    }))).toThrow("not configured");
  });

  it("resolves stdio credentials through the same target map", () => {
    const config = loadRuntimeConfig(environment());
    expect(resolveEnvironmentConnection(config, environment({ ODOO_API_KEY: "secret" }))).toMatchObject({
      targetId: "default",
      authMode: "stdio"
    });
  });

  it("requires a complete opt-in OAuth configuration", () => {
    expect(() => loadRuntimeConfig(environment({
      MCP_OAUTH_DATABASE: "/tmp/odoo-mcp.sqlite"
    }))).toThrow("MCP_OAUTH_ENABLED=true");
    expect(() => loadRuntimeConfig(environment({
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_DATABASE: "/tmp/odoo-mcp.sqlite"
    }))).toThrow("OAuth requires");
  });

  it("keeps analytics opt-in and degrades safely when its configuration is incomplete", () => {
    expect(loadRuntimeConfig(environment()).analytics).toEqual({
      status: "disabled",
      environment: "development"
    });
    expect(loadRuntimeConfig(environment({ MCP_ANALYTICS_ENABLED: "true" })).analytics).toEqual({
      status: "degraded",
      environment: "development",
      missingConfiguration: [
        "MCP_ANALYTICS_PSEUDONYMIZATION_KEY",
        "MCP_BUILD_ID",
        "MCP_DEPLOYMENT_ID",
        "POSTHOG_API_KEY",
        "POSTHOG_HOST"
      ]
    });
  });

  it("accepts a complete privacy-safe analytics configuration", () => {
    const config = loadRuntimeConfig(environment({
      MCP_ANALYTICS_ENABLED: "true",
      POSTHOG_API_KEY: "phc_project",
      POSTHOG_HOST: "https://eu.i.posthog.com",
      MCP_ANALYTICS_PSEUDONYMIZATION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MCP_DEPLOYMENT_ID: "vps-production",
      MCP_BUILD_ID: "9a0e681",
      MCP_ENVIRONMENT: "production"
    }));
    expect(config.analytics).toMatchObject({
      status: "ready",
      host: "https://eu.i.posthog.com",
      deploymentId: "vps-production",
      buildId: "9a0e681",
      environment: "production"
    });
    expect(config.analytics.pseudonymizationKey).toEqual(Buffer.alloc(32, 7));
  });
});
