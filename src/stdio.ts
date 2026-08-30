import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadRuntimeConfig, resolveEnvironmentConnection } from "./runtime/config.js";
import { emitEvent } from "./runtime/logging.js";
import { createRuntimeServices, createStdioServerFactory } from "./runtime/server.js";

const config = loadRuntimeConfig();
const principal = resolveEnvironmentConnection(config);
const services = createRuntimeServices(config);

serveStdio(createStdioServerFactory(services.registry, "default", principal), {
  legacy: "serve",
  onerror: (error) => emitEvent("mcp.request.completed", {
    profile: "default",
    target_id: principal.targetId,
    status: "stdio_error",
    error_name: error.name
  })
});
