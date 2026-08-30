import type { RequestContext } from "../../src/runtime/context.js";

export function requestContext(): RequestContext {
  return {
    requestId: "request-test",
    correlationId: "correlation-test",
    profile: "default",
    principal: {
      targetId: "test",
      publicOrigin: "https://odoo.example",
      internalOrigin: "http://odoo:8069",
      database: "test",
      apiKey: "test-key",
      authMode: "direct"
    }
  };
}
