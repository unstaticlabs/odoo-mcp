import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOAuthService } from "../../src/auth/oauth.js";
import { CredentialVault } from "../../src/auth/vault.js";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function oauthConfiguration() {
  const directory = mkdtempSync(join(tmpdir(), "odoo-mcp-auth-"));
  directories.push(directory);
  return loadRuntimeConfig({
    ODOO_PUBLIC_ORIGIN: "https://odoo.example",
    ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
    ODOO_DATABASE: "usl",
    MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    MCP_OAUTH_ENABLED: "true",
    MCP_OAUTH_DATABASE: join(directory, "oauth.sqlite"),
    BETTER_AUTH_SECRET: "a-development-secret-that-is-long-enough-for-tests",
    MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
  });
}

describe("OAuth credential vault", () => {
  it("loads deployment secrets from mounted absolute files", () => {
    const directory = mkdtempSync(join(tmpdir(), "odoo-mcp-secrets-"));
    directories.push(directory);
    const authSecretFile = join(directory, "auth-secret");
    const encryptionKeyFile = join(directory, "encryption-key");
    writeFileSync(authSecretFile, "file-backed-auth-secret\n", { mode: 0o600 });
    writeFileSync(encryptionKeyFile, `${Buffer.alloc(32, 9).toString("base64")}\n`, { mode: 0o600 });
    const config = loadRuntimeConfig({
      ODOO_PUBLIC_ORIGIN: "https://odoo.example",
      ODOO_DATABASE: "usl",
      MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_DATABASE: join(directory, "oauth.sqlite"),
      BETTER_AUTH_SECRET_FILE: authSecretFile,
      MCP_CREDENTIAL_ENCRYPTION_KEY_FILE: encryptionKeyFile
    });
    expect(config.oauth).toMatchObject({
      authSecret: "file-backed-auth-secret",
      encryptionKey: Buffer.alloc(32, 9).toString("base64")
    });
  });

  it("encrypts Odoo credentials and resolves them through the current target map", () => {
    const config = oauthConfiguration();
    const vault = new CredentialVault(config.oauth!, config);
    const enrollmentId = vault.stableEnrollmentId("default", "usl", 7);
    const apiKey = "plain-api-key-that-must-not-be-stored";
    vault.upsert({
      enrollmentId,
      targetId: "default",
      publicOrigin: "https://odoo.example",
      database: "usl",
      apiKey,
      odooUserId: 7,
      displayName: "Agent User"
    });

    expect(vault.enrollmentIdForEmail(vault.internalEmail(enrollmentId))).toBe(enrollmentId);
    expect(vault.resolve(enrollmentId)).toMatchObject({
      internalOrigin: "http://odoo:8069",
      apiKey,
      authMode: "oauth"
    });
    vault.close();
    expect(readFileSync(config.oauth!.databasePath).includes(Buffer.from(apiKey))).toBe(false);
  });

  it("makes enrollment revocation authoritative for existing bearer claims", () => {
    const config = oauthConfiguration();
    const vault = new CredentialVault(config.oauth!, config);
    const enrollmentId = vault.stableEnrollmentId("default", "usl", 8);
    vault.upsert({
      enrollmentId,
      targetId: "default",
      publicOrigin: "https://odoo.example",
      database: "usl",
      apiKey: "secret",
      odooUserId: 8,
      displayName: "Agent User"
    });
    vault.attachUser(enrollmentId, "better-user-8");
    expect(vault.revokeUser("better-user-8")).toBe(true);
    expect(() => vault.resolve(enrollmentId)).toThrow("revoked");
    vault.close();
  });
});

describe("Better Auth MCP provider", () => {
  it("migrates its SQLite schema and publishes authorization metadata", async () => {
    const config = oauthConfiguration();
    const client = new OdooClient();
    const service = createOAuthService(config, {
      client,
      registry: createCapabilityRegistry(client)
    });
    expect(service).not.toBeNull();
    await service!.ready;

    const authorization = await service!.authFetch(
      new Request("http://127.0.0.1:3000/api/auth/.well-known/oauth-authorization-server")
    );
    expect(authorization.status).toBe(200);
    const metadata = await authorization.json() as Record<string, unknown>;
    expect(metadata.issuer).toBe("http://127.0.0.1:3000/api/auth");
    expect(metadata.token_endpoint).toBe("http://127.0.0.1:3000/api/auth/oauth2/token");

    const resource = await service!.authFetch(
      new Request("http://127.0.0.1:3000/.well-known/oauth-protected-resource")
    );
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ resource: "http://127.0.0.1:3000/mcp" });
    service!.close();
  });
});
