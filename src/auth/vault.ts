import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { z } from "zod";
import { AgentIdentitySchema } from "../odoo/agent_identity.js";
import { agentCredentialFingerprint, type AgentAccessSnapshot, type AgentAccessSnapshotStore } from "../runtime/agent_access_cache.js";
import type { OdooPrincipal } from "../runtime/context.js";
import type { OAuthRuntimeConfig, RuntimeConfig } from "../runtime/config.js";

interface EnrollmentRow {
  enrollment_id: string;
  internal_email: string;
  user_id: string | null;
  target_id: string;
  public_origin: string;
  database_name: string;
  encrypted_api_key: string;
  odoo_user_id: number;
  display_name: string;
  created_at: number;
  updated_at: number;
  grant_expires_at: number;
}

interface AccessSnapshotRow {
  credential_fingerprint: string;
  schema_version: number;
  encrypted_snapshot: string;
}

const StoredAccessSnapshotSchema = z.object({
  schema_version: z.literal(1),
  refreshed_at: z.number().int().nonnegative(),
  identity: AgentIdentitySchema,
  surface: z.object({
    etag: z.string().max(512).optional(),
    modules: z.array(z.string().min(1).max(255)).max(10_000),
    public_methods: z.array(z.tuple([
      z.string().min(1).max(255),
      z.array(z.string().min(1).max(255)).max(10_000)
    ])).max(10_000),
    model_access: z.array(z.tuple([
      z.string().min(1).max(255),
      z.object({
        read: z.boolean(),
        create: z.boolean(),
        write: z.boolean(),
        unlink: z.boolean()
      }).strict()
    ])).max(10_000)
  }).strict()
}).strict();

const MAX_ENCRYPTED_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_AAD_PREFIX = "usl-odoo-mcp-agent-access-snapshot-v1\0";

export interface ValidatedEnrollment {
  enrollmentId: string;
  targetId: string;
  publicOrigin: string;
  database: string;
  apiKey: string;
  odooUserId: number;
  displayName: string;
}

function encryptionKey(value: string): Buffer {
  const raw = value.startsWith("base64:") ? value.slice(7) : value;
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error("MCP_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function tableExists(database: Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function userColumn(database: Database, table: string): string | null {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (columns.some((column) => column.name === "userId")) return "userId";
  if (columns.some((column) => column.name === "user_id")) return "user_id";
  return null;
}

function columnExists(database: Database, table: string, column: string): boolean {
  if (!tableExists(database, table)) return false;
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return columns.some((candidate) => candidate.name === column);
}

function requireProcessOwnership(path: string, label: string, uid: number): void {
  const entry = lstatSync(path);
  if (entry.uid !== uid) {
    throw new Error(`${label} must be owned by the MCP process user; found uid ${entry.uid}`);
  }
}

function secureFile(path: string, label: string, uid: number): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  requireProcessOwnership(path, label, uid);
  const mode = 0o600;
  chmodSync(path, mode);
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) {
    throw new Error(`${label} must use mode ${mode.toString(8)}; found ${actual.toString(8)}`);
  }
}

function secureDatabaseDirectory(path: string, uid: number): void {
  if (path === tmpdir().replace(/\/$/, "")) {
    throw new Error(
      "OAuth SQLite directory must not be the shared operating-system temporary directory. "
      + "Create a dedicated mode-700 subdirectory for MCP_OAUTH_DATABASE."
    );
  }
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("OAuth SQLite directory must be a regular directory");
  }
  requireProcessOwnership(path, "OAuth SQLite directory", uid);
  const actual = entry.mode & 0o777;
  if (actual !== 0o700) {
    throw new Error(
      `OAuth SQLite directory must use mode 700; found ${actual.toString(8)}. `
      + "Use a dedicated process-owned directory and set its mode to 700 before starting the MCP."
    );
  }
}

function secureSqliteFiles(databasePath: string, uid: number): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) secureFile(path, "OAuth SQLite file", uid);
  }
}

export class CredentialVault implements AgentAccessSnapshotStore {
  readonly database: Database;
  private readonly key: Buffer;

  constructor(
    private readonly oauth: OAuthRuntimeConfig,
    private readonly runtime: RuntimeConfig
  ) {
    if (!isAbsolute(oauth.databasePath)) throw new Error("MCP_OAUTH_DATABASE must be an absolute path");
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error("The OAuth SQLite vault requires a platform that exposes process file ownership");
    }
    const databaseDirectory = dirname(oauth.databasePath);
    secureDatabaseDirectory(databaseDirectory, uid);
    secureSqliteFiles(oauth.databasePath, uid);
    this.database = new BetterSqlite3(oauth.databasePath);
    secureSqliteFiles(oauth.databasePath, uid);
    this.database.pragma("journal_mode = WAL");
    secureSqliteFiles(oauth.databasePath, uid);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.key = encryptionKey(oauth.encryptionKey);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS odoo_enrollment (
        enrollment_id TEXT PRIMARY KEY,
        internal_email TEXT NOT NULL,
        user_id TEXT,
        target_id TEXT NOT NULL,
        public_origin TEXT NOT NULL,
        database_name TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        odoo_user_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        grant_expires_at INTEGER NOT NULL
      );
    `);
    secureSqliteFiles(oauth.databasePath, uid);
    if (!columnExists(this.database, "odoo_enrollment", "internal_email")) {
      this.database.exec("ALTER TABLE odoo_enrollment ADD COLUMN internal_email TEXT");
      const rows = this.database.prepare("SELECT enrollment_id FROM odoo_enrollment").all() as Array<{ enrollment_id: string }>;
      const update = this.database.prepare("UPDATE odoo_enrollment SET internal_email = ? WHERE enrollment_id = ?");
      this.database.transaction(() => {
        for (const row of rows) update.run(this.internalEmail(row.enrollment_id), row.enrollment_id);
      })();
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS odoo_enrollment_user_id
        ON odoo_enrollment(user_id) WHERE user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS odoo_enrollment_internal_email
        ON odoo_enrollment(internal_email);
      CREATE TABLE IF NOT EXISTS odoo_agent_access_snapshot (
        enrollment_id TEXT PRIMARY KEY REFERENCES odoo_enrollment(enrollment_id) ON DELETE CASCADE,
        credential_fingerprint TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        encrypted_snapshot TEXT NOT NULL,
        refreshed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.database.prepare(`
      DELETE FROM odoo_agent_access_snapshot
      WHERE enrollment_id IN (
        SELECT enrollment_id FROM odoo_enrollment WHERE grant_expires_at <= ?
      )
    `).run(Math.floor(Date.now() / 1000));
  }

  stableEnrollmentId(targetId: string, database: string, odooUserId: number): string {
    return createHmac("sha256", this.key)
      .update(`${targetId}\0${database}\0${odooUserId}`)
      .digest("base64url");
  }

  internalEmail(enrollmentId: string): string {
    return `odoo-${createHash("sha256").update(enrollmentId).digest("hex").slice(0, 40)}@mcp.invalid`;
  }

  internalPassword(enrollmentId: string): string {
    return createHmac("sha256", this.key).update(`better-auth\0${enrollmentId}`).digest("base64url");
  }

  upsert(enrollment: ValidatedEnrollment): void {
    const now = Math.floor(Date.now() / 1000);
    this.database.prepare(`
      INSERT INTO odoo_enrollment (
        enrollment_id, internal_email, user_id, target_id, public_origin, database_name,
        encrypted_api_key, odoo_user_id, display_name, created_at, updated_at,
        grant_expires_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enrollment_id) DO UPDATE SET
        internal_email = excluded.internal_email,
        target_id = excluded.target_id,
        public_origin = excluded.public_origin,
        database_name = excluded.database_name,
        encrypted_api_key = excluded.encrypted_api_key,
        odoo_user_id = excluded.odoo_user_id,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at,
        grant_expires_at = excluded.grant_expires_at
    `).run(
      enrollment.enrollmentId,
      this.internalEmail(enrollment.enrollmentId),
      enrollment.targetId,
      enrollment.publicOrigin,
      enrollment.database,
      this.encrypt(enrollment.apiKey),
      enrollment.odooUserId,
      enrollment.displayName,
      now,
      now,
      now + this.oauth.grantCeilingSeconds
    );
  }

  enrollmentIdForEmail(email: string): string | null {
    const row = this.database.prepare(
      "SELECT enrollment_id FROM odoo_enrollment WHERE internal_email = ?"
    ).get(email) as { enrollment_id?: unknown } | undefined;
    return typeof row?.enrollment_id === "string" ? row.enrollment_id : null;
  }

  attachUser(enrollmentId: string, userId: string): void {
    this.database.prepare(
      "UPDATE odoo_enrollment SET user_id = ?, updated_at = ? WHERE enrollment_id = ?"
    ).run(userId, Math.floor(Date.now() / 1000), enrollmentId);
  }

  userIdForEmail(email: string): string | null {
    if (!tableExists(this.database, "user")) return null;
    const row = this.database.prepare("SELECT id FROM user WHERE email = ? LIMIT 1").get(email) as { id?: unknown } | undefined;
    return typeof row?.id === "string" ? row.id : null;
  }

  resolve(enrollmentId: string): OdooPrincipal {
    const row = this.database.prepare(
      "SELECT * FROM odoo_enrollment WHERE enrollment_id = ?"
    ).get(enrollmentId) as EnrollmentRow | undefined;
    if (!row) throw new Error("The Odoo enrollment was revoked or no longer exists");
    if (row.grant_expires_at <= Math.floor(Date.now() / 1000)) {
      this.database.prepare(
        "DELETE FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
      ).run(enrollmentId);
      throw new Error("The Odoo enrollment reached its one-year grant ceiling; reconnect it");
    }
    const target = this.runtime.targets.find(
      (candidate) => candidate.id === row.target_id
        && candidate.publicOrigin === row.public_origin
        && candidate.databases.includes(row.database_name)
    );
    if (!target) {
      this.database.prepare(
        "DELETE FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
      ).run(enrollmentId);
      throw new Error("The enrolled Odoo target is no longer configured");
    }
    return {
      targetId: target.id,
      publicOrigin: target.publicOrigin,
      internalOrigin: target.internalOrigin,
      database: row.database_name,
      apiKey: this.decrypt(row.encrypted_api_key),
      authMode: "oauth",
      enrollmentId
    };
  }

  activePrincipals(): { principals: OdooPrincipal[]; unavailable: number } {
    const rows = this.database.prepare(
      "SELECT enrollment_id FROM odoo_enrollment WHERE grant_expires_at > ? ORDER BY enrollment_id"
    ).all(Math.floor(Date.now() / 1000)) as Array<{ enrollment_id: string }>;
    const principals: OdooPrincipal[] = [];
    let unavailable = 0;
    for (const row of rows) {
      try {
        principals.push(this.resolve(row.enrollment_id));
      } catch {
        this.database.prepare(
          "DELETE FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
        ).run(row.enrollment_id);
        unavailable += 1;
      }
    }
    return { principals, unavailable };
  }

  load(principal: OdooPrincipal): AgentAccessSnapshot | null {
    const enrollmentId = principal.enrollmentId;
    if (!enrollmentId || principal.authMode !== "oauth") return null;
    const row = this.database.prepare(
      "SELECT credential_fingerprint, schema_version, encrypted_snapshot FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
    ).get(enrollmentId) as AccessSnapshotRow | undefined;
    if (!row) return null;
    if (row.schema_version !== 1
      || row.credential_fingerprint !== agentCredentialFingerprint(principal)
      || Buffer.byteLength(row.encrypted_snapshot) > MAX_ENCRYPTED_SNAPSHOT_BYTES) {
      this.remove(principal);
      return null;
    }
    try {
      const parsed = StoredAccessSnapshotSchema.parse(JSON.parse(
        this.decryptSnapshot(enrollmentId, row.encrypted_snapshot)
      ));
      return {
        identity: parsed.identity,
        refreshedAt: parsed.refreshed_at,
        surface: {
          modules: new Set(parsed.surface.modules),
          publicMethods: new Map(parsed.surface.public_methods.map(([model, methods]) => [model, new Set(methods)])),
          modelAccess: new Map(parsed.surface.model_access),
          ...(parsed.surface.etag ? { etag: parsed.surface.etag } : {})
        }
      };
    } catch {
      this.remove(principal);
      return null;
    }
  }

  save(principal: OdooPrincipal, snapshot: AgentAccessSnapshot): void {
    const enrollmentId = principal.enrollmentId;
    if (!enrollmentId || principal.authMode !== "oauth" || !snapshot.surface) return;
    const payload = JSON.stringify(StoredAccessSnapshotSchema.parse({
      schema_version: 1,
      refreshed_at: snapshot.refreshedAt,
      identity: snapshot.identity,
      surface: {
        ...(snapshot.surface.etag ? { etag: snapshot.surface.etag } : {}),
        modules: [...snapshot.surface.modules].sort(),
        public_methods: [...snapshot.surface.publicMethods]
          .map(([model, methods]) => [model, [...methods].sort()] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
        model_access: [...snapshot.surface.modelAccess]
          .sort(([left], [right]) => left.localeCompare(right))
      }
    }));
    const encrypted = this.encryptSnapshot(enrollmentId, payload);
    if (Buffer.byteLength(encrypted) > MAX_ENCRYPTED_SNAPSHOT_BYTES) {
      throw new Error("The encrypted Agent access snapshot exceeds its storage limit");
    }
    const now = Math.floor(Date.now() / 1000);
    this.database.prepare(`
      INSERT INTO odoo_agent_access_snapshot (
        enrollment_id, credential_fingerprint, schema_version, encrypted_snapshot, refreshed_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(enrollment_id) DO UPDATE SET
        credential_fingerprint = excluded.credential_fingerprint,
        schema_version = excluded.schema_version,
        encrypted_snapshot = excluded.encrypted_snapshot,
        refreshed_at = excluded.refreshed_at,
        updated_at = excluded.updated_at
    `).run(
      enrollmentId,
      agentCredentialFingerprint(principal),
      encrypted,
      Math.floor(snapshot.refreshedAt / 1000),
      now
    );
  }

  remove(principal: OdooPrincipal): void {
    if (!principal.enrollmentId) return;
    this.database.prepare(
      "DELETE FROM odoo_agent_access_snapshot WHERE enrollment_id = ?"
    ).run(principal.enrollmentId);
  }

  revokeUser(userId: string): boolean {
    const transaction = this.database.transaction(() => {
      const removed = this.database.prepare("DELETE FROM odoo_enrollment WHERE user_id = ?").run(userId).changes > 0;
      for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
        if (!tableExists(this.database, table)) continue;
        const column = userColumn(this.database, table);
        if (column) this.database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(userId);
      }
      return removed;
    });
    return transaction();
  }

  close(): void {
    this.database.close();
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
  }

  private decrypt(value: string): string {
    const [version, ivRaw, ciphertextRaw, tagRaw] = value.split(".");
    if (version !== "v1" || !ivRaw || !ciphertextRaw || !tagRaw) {
      throw new Error("The stored Odoo credential has an unsupported encryption format");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }

  private encryptSnapshot(enrollmentId: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${SNAPSHOT_AAD_PREFIX}${enrollmentId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
  }

  private decryptSnapshot(enrollmentId: string, value: string): string {
    const [version, ivRaw, ciphertextRaw, tagRaw] = value.split(".");
    if (version !== "v1" || !ivRaw || !ciphertextRaw || !tagRaw) {
      throw new Error("The stored Agent access snapshot has an unsupported encryption format");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivRaw, "base64url"));
    decipher.setAAD(Buffer.from(`${SNAPSHOT_AAD_PREFIX}${enrollmentId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}
