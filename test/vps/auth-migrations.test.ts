import Database from "better-sqlite3";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { migrateLegacyAccountIssuer } from "../../src/auth/migrations.js";

function legacy() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY);
    INSERT INTO user VALUES ('synthetic-user');
    CREATE TABLE account (id TEXT PRIMARY KEY, userId TEXT REFERENCES user(id),
      providerId TEXT NOT NULL, accountId TEXT NOT NULL, password TEXT,
      issuer TEXT NOT NULL);
    CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account(issuer,accountId);
    INSERT INTO account VALUES ('synthetic-account','synthetic-user','credential',
      'synthetic-user','synthetic-password-hash','legacy-native-issuer');`);
  return db;
}

const rows = (db: Database.Database) => db.prepare(
  "SELECT id,userId,providerId,accountId,password FROM account ORDER BY id"
).all();
const columns = (db: Database.Database) => (db.pragma("table_info('account')") as Array<{name: string}>)
  .map(column => column.name);

describe("native Better Auth legacy issuer migration", () => {
  it("preserves account identity, password hashes and foreign keys across repeated upgrades", () => {
    const db = legacy();
    try {
      const before = rows(db);
      migrateLegacyAccountIssuer(db);
      expect(columns(db)).not.toContain("issuer");
      expect(rows(db)).toEqual(before);
      db.prepare("INSERT INTO account VALUES (?,?,?,?,?)").run(
        "new-account", "synthetic-user", "credential", "second-account", "new-hash"
      );
      const after = rows(db);
      migrateLegacyAccountIssuer(db);
      expect(rows(db)).toEqual(after);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", {simple: true})).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("preserves generated distinct native account keys and stored values without reinterpreting them", () => {
    const account = fc.record({
      provider: fc.string({minLength: 1, maxLength: 20}),
      account: fc.string({minLength: 1, maxLength: 20}),
      password: fc.option(fc.string({maxLength: 60}), {nil: null})
    });
    fc.assert(fc.property(fc.uniqueArray(account, {
      selector: value => JSON.stringify([value.provider, value.account]), maxLength: 12
    }), values => {
      const db = legacy();
      try {
        const insert = db.prepare("INSERT INTO account VALUES (?,?,?,?,?,?)");
        values.forEach((value, index) => insert.run(
          `generated-${index}`, "synthetic-user", `provider:${value.provider}`,
          value.account, value.password, `legacy-issuer-${index}`
        ));
        const before = rows(db);
        migrateLegacyAccountIssuer(db);
        expect(rows(db)).toEqual(before);
        migrateLegacyAccountIssuer(db);
        expect(rows(db)).toEqual(before);
        expect(db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        db.close();
      }
    }), {numRuns: 40});
  });

  it("leaves fresh and already-compatible nullable columns unchanged", () => {
    const db = new Database(":memory:");
    try {
      migrateLegacyAccountIssuer(db);
      db.exec("CREATE TABLE account (id TEXT PRIMARY KEY, issuer TEXT); INSERT INTO account VALUES ('synthetic','retained-history')");
      migrateLegacyAccountIssuer(db);
      expect(db.prepare("SELECT * FROM account").all()).toEqual([
        {id: "synthetic", issuer: "retained-history"}
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps distinct providers separate while refusing ambiguous duplicate native keys without writes", () => {
    const db = legacy();
    try {
      db.exec("INSERT INTO account VALUES ('second','synthetic-user','other-provider','synthetic-user','other-hash','other-issuer')");
      const before = rows(db);
      migrateLegacyAccountIssuer(db);
      expect(rows(db)).toEqual(before);
    } finally {
      db.close();
    }
    const ambiguous = legacy();
    try {
      ambiguous.exec("INSERT INTO account VALUES ('duplicate','synthetic-user','credential','synthetic-user','other-hash','other-issuer')");
      const before = ambiguous.prepare("SELECT * FROM account ORDER BY id").all();
      expect(() => migrateLegacyAccountIssuer(ambiguous)).toThrow(/duplicate OAuth/);
      expect(ambiguous.prepare("SELECT * FROM account ORDER BY id").all()).toEqual(before);
      expect(columns(ambiguous)).toContain("issuer");
    } finally {
      ambiguous.close();
    }
  });

  it("rolls the index removal back when SQLite cannot remove a column with another dependency", () => {
    const db = legacy();
    try {
      db.exec("CREATE TRIGGER retained_dependency BEFORE INSERT ON account BEGIN SELECT NEW.issuer; END");
      const before = db.prepare("SELECT * FROM account").all();
      expect(() => migrateLegacyAccountIssuer(db)).toThrow();
      expect(db.prepare("SELECT * FROM account").all()).toEqual(before);
      expect(columns(db)).toContain("issuer");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='account_issuer_accountId_uidx'").get()).toBeTruthy();
      expect(db.pragma("integrity_check", {simple: true})).toBe("ok");
    } finally {
      db.close();
    }
  });
});
