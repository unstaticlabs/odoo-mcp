import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createOAuthService } from "./oauth.js";
import { loadRuntimeConfig } from "../runtime/config.js";
import { createRuntimeServices } from "../runtime/server.js";
import { createRequestContext } from "../runtime/context.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadRuntimeConfig();
  const services = createRuntimeServices(config);
  const oauth = createOAuthService(config, services);
  if (!oauth) throw new Error("Set MCP_OAUTH_ENABLED=true and configure the OAuth vault first");
  try {
    await oauth.ready;
    if (command === "migrate") {
      process.stdout.write("OAuth schema is current.\n");
      return;
    }
    if (command === "prepare") {
      const active = oauth.vault.activePrincipals();
      let refreshed = 0;
      let cached = 0;
      let unavailable = active.unavailable;
      for (const principal of active.principals) {
        const context = createRequestContext("default", principal);
        context.eventObserver = services.observability;
        context.analyticsPrincipalId = services.observability.principalId(principal);
        try {
          const result = await services.accessCache.warm(context);
          if (result.refreshed) refreshed += 1;
          else cached += 1;
        } catch {
          try {
            if (services.accessCache.get(principal).surface) cached += 1;
            else unavailable += 1;
          } catch {
            unavailable += 1;
          }
        }
      }
      process.stdout.write(`OAuth schema is current; access snapshots: ${refreshed} refreshed, ${cached} cached, ${unavailable} unavailable.\n`);
      if (unavailable > 0) process.exitCode = 1;
      return;
    }
    if (command === "backup") {
      const submitted = process.argv[3];
      if (!submitted) throw new Error("Usage: npm run oauth:backup -- /absolute/path/to/backup.sqlite");
      const destination = resolve(submitted);
      if (!isAbsolute(submitted)) throw new Error("The OAuth backup destination must be an absolute path");
      if (destination === config.oauth!.databasePath) throw new Error("The backup destination must differ from the live database");
      if (existsSync(destination)) throw new Error("The OAuth backup destination already exists");
      const priorUmask = process.umask(0o077);
      try {
        await oauth.vault.database.backup(destination);
        chmodSync(destination, 0o600);
      } finally {
        process.umask(priorUmask);
      }
      process.stdout.write(`OAuth vault backed up to ${destination}\n`);
      return;
    }
    throw new Error("Usage: npm run oauth:migrate, node dist/auth/cli.js prepare, or npm run oauth:backup -- /absolute/path/to/backup.sqlite");
  } finally {
    await services.accessCache.close();
    oauth.close();
    await services.observability.close();
  }
}

await main();
