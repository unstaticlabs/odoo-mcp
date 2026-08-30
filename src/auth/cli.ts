import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createOAuthService } from "./oauth.js";
import { loadRuntimeConfig } from "../runtime/config.js";
import { createRuntimeServices } from "../runtime/server.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadRuntimeConfig();
  const oauth = createOAuthService(config, createRuntimeServices(config));
  if (!oauth) throw new Error("Set MCP_OAUTH_ENABLED=true and configure the OAuth vault first");
  try {
    await oauth.ready;
    if (command === "migrate") {
      process.stdout.write("OAuth schema is current.\n");
      return;
    }
    if (command === "backup") {
      const submitted = process.argv[3];
      if (!submitted) throw new Error("Usage: npm run oauth:backup -- /absolute/path/to/backup.sqlite");
      const destination = resolve(submitted);
      if (!isAbsolute(submitted)) throw new Error("The OAuth backup destination must be an absolute path");
      if (destination === config.oauth!.databasePath) throw new Error("The backup destination must differ from the live database");
      if (existsSync(destination)) throw new Error("The OAuth backup destination already exists");
      await oauth.vault.database.backup(destination);
      process.stdout.write(`OAuth vault backed up to ${destination}\n`);
      return;
    }
    throw new Error("Usage: npm run oauth:migrate or npm run oauth:backup -- /absolute/path/to/backup.sqlite");
  } finally {
    oauth.close();
  }
}

await main();
