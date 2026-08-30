import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadRuntimeConfig, resolveEnvironmentConnection } from "./runtime/config.js";
import { emitEvent } from "./runtime/logging.js";
import { createRuntimeServices, createStdioServerFactory } from "./runtime/server.js";

const config = loadRuntimeConfig();
const principal = resolveEnvironmentConnection(config);
const services = createRuntimeServices(config);

const handle = serveStdio(createStdioServerFactory(services, "default", principal), {
  legacy: "serve",
  onerror: (error) => emitEvent("mcp.request.completed", {
    profile: "default",
    target_id: principal.targetId,
    status: "stdio_error",
    error_name: error.name
  }, services.observability)
});

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await handle.close();
  await services.observability.close();
};
process.stdin.once("end", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
