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
  it("accepts standards-defined localhost subdomains only with the local HTTP opt-in", () => {
    const local = environment({
      ODOO_PUBLIC_ORIGIN: "http://odoo.localhost:28669",
      MCP_ALLOW_LOCAL_HTTP_ODOO: "true"
    });
    expect(loadRuntimeConfig(local).targets[0]?.publicOrigin).toBe("http://odoo.localhost:28669");
    expect(() => loadRuntimeConfig({
      ...local,
      MCP_ALLOW_LOCAL_HTTP_ODOO: "false"
    })).toThrow("must use HTTPS");
    expect(() => loadRuntimeConfig({
      ...local,
      ODOO_PUBLIC_ORIGIN: "http://localhost.example:28669"
    })).toThrow("must use HTTPS");
  });

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

  it("always permits its own public origin and keeps materialization opt-in", () => {
    const disabled = loadRuntimeConfig(environment({
      MCP_ALLOWED_ORIGINS: "chatgpt.com,claude.ai"
    }));
    expect(disabled.allowedOrigins).toEqual(["mcp.example", "chatgpt.com", "claude.ai"]);
    expect(disabled.documentMaterializationEnabled).toBe(false);
    expect(loadRuntimeConfig(environment({
      MCP_DOCUMENT_MATERIALIZATION_ENABLED: "true"
    })).documentMaterializationEnabled).toBe(true);
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
});
