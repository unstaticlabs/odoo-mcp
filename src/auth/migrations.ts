import type { Database } from "better-sqlite3";

/** Apply Better Auth's SQLite upgrade from its 1.7.0–1.7.2 account schema.
 * https://www.better-auth.com/docs/guides/1-7-upgrade-guide
 * Native account identity is (providerId, accountId); new inserts omit issuer.
 * The pre-upgrade vault backup is required for an old-image rollback.
 */
export function migrateLegacyAccountIssuer(database: Database): void {
  const columns = database.pragma("table_info('account')") as Array<{
    name: string; notnull: number; dflt_value: string | null;
  }>;
  const issuer = columns.find((column) => column.name === "issuer");
  // Fresh/current schemas and already-relaxed legacy columns need no rewrite.
  if (!issuer?.notnull || issuer.dflt_value !== null) return;
  database.transaction(() => {
    if (database.prepare(`SELECT 1 FROM account GROUP BY providerId, accountId
      HAVING count(*) > 1 LIMIT 1`).get()) {
      throw new Error("Resolve duplicate OAuth provider/account keys before upgrading; the vault is unchanged. See the Better Auth 1.7 upgrade guide.");
    }
    const index = (database.pragma("index_list('account')") as Array<{
      name: string; unique: number; partial: number;
    }>).find((item) => item.name === "account_issuer_accountId_uidx");
    if (index) {
      const fields = (database.pragma("index_info('account_issuer_accountId_uidx')") as Array<{ name: string }>)
        .map((field) => field.name).sort();
      if (!index.unique || index.partial || fields.join(",") !== "accountId,issuer") {
        throw new Error("The legacy OAuth issuer index has an unexpected definition; the vault is unchanged. Review its migration before upgrading.");
      }
      database.exec("DROP INDEX account_issuer_accountId_uidx");
    }
    // SQLite performs this atomically with the index removal. Other schema
    // dependencies cause the transaction to roll back rather than lose them.
    database.exec("ALTER TABLE account DROP COLUMN issuer");
  })();
}
