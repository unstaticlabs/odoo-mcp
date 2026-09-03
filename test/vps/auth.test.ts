import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthService,
  credentialEndpointHeaders,
  redirectFromAuthPayload
} from "../../src/auth/oauth.js";
import { CredentialVault } from "../../src/auth/vault.js";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { AgentAccessSnapshotCache, type AgentAccessSnapshot } from "../../src/runtime/agent_access_cache.js";
import { loadRuntimeConfig } from "../../src/runtime/config.js";
import { createObservability } from "../../src/runtime/observability.js";
import { createRuntimeServices } from "../../src/runtime/server.js";
import { requestContext } from "./fixtures.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function oauthConfiguration(databasePath?: string) {
  let resolvedDatabasePath = databasePath;
  if (!resolvedDatabasePath) {
    const directory = mkdtempSync(join(tmpdir(), "odoo-mcp-auth-"));
    directories.push(directory);
    resolvedDatabasePath = join(directory, "oauth.sqlite");
  }
  return loadRuntimeConfig({
    ODOO_PUBLIC_ORIGIN: "https://odoo.example",
    ODOO_INTERNAL_ORIGIN: "http://odoo:8069",
    ODOO_DATABASE: "usl",
    MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    MCP_OAUTH_ENABLED: "true",
    MCP_OAUTH_DATABASE: resolvedDatabasePath,
    BETTER_AUTH_SECRET: "a-development-secret-that-is-long-enough-for-tests",
    MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
  });
}

function accessSnapshot(refreshedAt = Date.now()): AgentAccessSnapshot {
  return {
    identity: requestContext().agentIdentity!,
    refreshedAt,
    surface: {
      etag: '"access-v1"',
      modules: new Set(["base", "hr_expense"]),
      publicMethods: new Map([["hr.expense", new Set(["action_approve_expenses"])]]),
      modelAccess: new Map([["hr.expense", {
        read: true,
        create: true,
        write: true,
        unlink: false
      }]])
    }
  };
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

  it("creates a missing private directory and secures SQLite files", () => {
    const root = mkdtempSync(join(tmpdir(), "odoo-mcp-auth-parent-"));
    directories.push(root);
    const databaseDirectory = join(root, "vault");
    const config = oauthConfiguration(join(databaseDirectory, "oauth.sqlite"));
    const vault = new CredentialVault(config.oauth!, config);
    vault.database.exec("INSERT INTO odoo_enrollment (enrollment_id, internal_email, target_id, public_origin, database_name, encrypted_api_key, odoo_user_id, display_name, created_at, updated_at, grant_expires_at) VALUES ('test', 'test@mcp.invalid', 'default', 'https://odoo.example', 'usl', 'encrypted', 1, 'Test', 1, 1, 2)");

    expect(statSync(databaseDirectory).mode & 0o777).toBe(0o700);
    for (const path of [config.oauth!.databasePath, `${config.oauth!.databasePath}-wal`, `${config.oauth!.databasePath}-shm`]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    vault.close();
  });

  it("rejects permissive vault directories without changing them", () => {
    const config = oauthConfiguration();
    chmodSync(join(config.oauth!.databasePath, ".."), 0o755);
    writeFileSync(config.oauth!.databasePath, "", { mode: 0o644 });
    expect(() => new CredentialVault(config.oauth!, config)).toThrow(/must use mode 700/);
    expect(statSync(join(config.oauth!.databasePath, "..")).mode & 0o777).toBe(0o755);
    expect(statSync(config.oauth!.databasePath).mode & 0o777).toBe(0o644);
  });

  it("secures an existing SQLite file without modifying its private parent", () => {
    const config = oauthConfiguration();
    const databaseDirectory = join(config.oauth!.databasePath, "..");
    writeFileSync(config.oauth!.databasePath, "", { mode: 0o644 });
    const vault = new CredentialVault(config.oauth!, config);
    expect(statSync(databaseDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(config.oauth!.databasePath).mode & 0o777).toBe(0o600);
    vault.close();
  });

  it("rejects the shared temporary directory without modifying it", () => {
    const databasePath = join(tmpdir(), `odoo-mcp-shared-parent-${randomUUID()}.sqlite`);
    const before = statSync(tmpdir()).mode & 0o777;
    const config = oauthConfiguration(databasePath);
    expect(() => new CredentialVault(config.oauth!, config)).toThrow(/temporary directory/);
    expect(statSync(tmpdir()).mode & 0o777).toBe(before);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("rejects symlinked and differently owned vault directories", () => {
    const root = mkdtempSync(join(tmpdir(), "odoo-mcp-auth-links-"));
    directories.push(root);
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);
    const linked = oauthConfiguration(join(link, "oauth.sqlite"));
    expect(() => new CredentialVault(linked.oauth!, linked)).toThrow(/regular directory/);

    const owned = oauthConfiguration(join(target, "oauth.sqlite"));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
    try {
      expect(() => new CredentialVault(owned.oauth!, owned)).toThrow(/owned by the MCP process user/);
    } finally {
      getuid.mockRestore();
    }
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

  it("encrypts, validates, and round-trips a complete Agent access snapshot", () => {
    const config = oauthConfiguration();
    const vault = new CredentialVault(config.oauth!, config);
    const enrollmentId = vault.stableEnrollmentId("default", "usl", 9);
    vault.upsert({
      enrollmentId,
      targetId: "default",
      publicOrigin: "https://odoo.example",
      database: "usl",
      apiKey: "snapshot-secret",
      odooUserId: 9,
      displayName: "Snapshot Agent"
    });
    const principal = vault.resolve(enrollmentId);
    const snapshot = accessSnapshot();
    vault.save(principal, snapshot);

    expect(vault.load(principal)).toEqual(snapshot);
    const stored = vault.database.prepare(
      "SELECT encrypted_snapshot FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
    ).get(enrollmentId) as { encrypted_snapshot: string };
    expect(stored.encrypted_snapshot).toMatch(/^v1\./);
    expect(stored.encrypted_snapshot).not.toContain("hr_expense");
    expect(stored.encrypted_snapshot).not.toContain("Test Agent");
    vault.close();
  });

  it("deletes snapshots after credential rotation, corruption, and enrollment revocation", () => {
    const config = oauthConfiguration();
    const vault = new CredentialVault(config.oauth!, config);
    const enrollmentId = vault.stableEnrollmentId("default", "usl", 10);
    const enrollment = {
      enrollmentId,
      targetId: "default",
      publicOrigin: "https://odoo.example",
      database: "usl",
      apiKey: "first-secret",
      odooUserId: 10,
      displayName: "Snapshot Agent"
    };
    vault.upsert(enrollment);
    const firstPrincipal = vault.resolve(enrollmentId);
    vault.save(firstPrincipal, accessSnapshot());

    vault.upsert({ ...enrollment, apiKey: "rotated-secret" });
    const rotatedPrincipal = vault.resolve(enrollmentId);
    expect(vault.load(rotatedPrincipal)).toBeNull();
    expect(vault.database.prepare(
      "SELECT COUNT(*) AS count FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
    ).get(enrollmentId)).toEqual({ count: 0 });

    vault.save(rotatedPrincipal, accessSnapshot());
    vault.database.prepare(
      "UPDATE odoo_agent_access_snapshot SET encrypted_snapshot = ? WHERE enrollment_id = ?"
    ).run("v1.corrupt.payload.tag", enrollmentId);
    expect(vault.load(rotatedPrincipal)).toBeNull();

    vault.save(rotatedPrincipal, accessSnapshot());
    vault.attachUser(enrollmentId, "better-user-10");
    expect(vault.revokeUser("better-user-10")).toBe(true);
    expect(vault.database.prepare(
      "SELECT COUNT(*) AS count FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
    ).get(enrollmentId)).toEqual({ count: 0 });
    vault.close();
  });
});

describe("OAuth continuation", () => {
  it.each([
    [{ url: "https://client.example/callback" }, "https://client.example/callback"],
    [{ redirect_uri: "https://client.example/callback" }, "https://client.example/callback"],
    [{ redirectUri: "https://client.example/callback" }, "https://client.example/callback"]
  ])("accepts every supported continuation field", (payload, expected) => {
    expect(redirectFromAuthPayload(payload)).toBe(expected);
  });

  it("rejects a missing or invalid continuation", () => {
    expect(redirectFromAuthPayload({})).toBeNull();
    expect(redirectFromAuthPayload({ url: 42 })).toBeNull();
    expect(redirectFromAuthPayload({ url: "javascript:alert(1)" })).toBeNull();
    expect(redirectFromAuthPayload({ url: "//untrusted.example" })).toBeNull();
  });
});

describe("OAuth enrollment credentials", () => {
  it("uses the configured trusted origin for internal Better Auth requests", () => {
    const source = new Request("https://mcp.example/oauth/enroll", {
      headers: {
        Cookie: "session=opaque",
        Origin: "https://untrusted.example"
      }
    });
    const headers = credentialEndpointHeaders("https://mcp.example", source);

    expect(headers.get("Origin")).toBe("https://mcp.example");
    expect(headers.get("Cookie")).toBe("session=opaque");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("returns retryable warming when a complete discovery surface cannot be loaded", async () => {
    const config = oauthConfiguration();
    const identity = requestContext().agentIdentity!;
    const client = new OdooClient(8, 1024 * 1024, vi.fn<typeof fetch>(async (input) =>
      String(input).includes("current_identity")
        ? Response.json(identity)
        : Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 })
    ));
    const services = {
      client,
      registry: createCapabilityRegistry(client),
      enabledFeatures: new Set<string>(),
      observability: createObservability(config.analytics),
      accessCache: new AgentAccessSnapshotCache(client, { refreshTimeoutMs: 30_000 })
    };
    const service = createOAuthService(config, services)!;
    await service.ready;
    const response = await service.enrollmentFetch(new Request("http://127.0.0.1:3000/oauth/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        odooUrl: "https://odoo.example",
        database: "usl",
        apiKey: "agent-key",
        oauthQuery: "client_id=test"
      })
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ error: "surface_warming" });
    await services.accessCache.close();
    service.close();
    await services.observability.close();
  });
});

describe("Better Auth MCP provider", () => {
  it("migrates its SQLite schema and publishes authorization metadata", async () => {
    const config = oauthConfiguration();
    const services = createRuntimeServices(config);
    const service = createOAuthService(config, services);
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
    await services.accessCache.close();
    service!.close();
    await services.observability.close();
  });

  it("uses normalized continuation fields on the consent page", async () => {
    const config = oauthConfiguration();
    const services = createRuntimeServices(config);
    const service = createOAuthService(config, services);
    await service!.ready;
    const response = await service!.consentFetch(new Request("http://127.0.0.1:3000/oauth/consent"));
    const body = await response.text();
    expect(body).toContain("data.url || data.redirect_uri || data.redirectUri");
    expect(body).toContain("new URL(candidate, location.origin)");
    expect(body).not.toContain("location.assign(data.redirect_uri)");
    await services.accessCache.close();
    service!.close();
    await services.observability.close();
  });
});
