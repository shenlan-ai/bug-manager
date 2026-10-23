import {
  CompiledQuery,
  SqliteAdapter,
  SqliteDialect,
  SqliteDriver,
} from "kysely";
import type { DatabaseConnection, SqliteDialectConfig } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { DomainError } from "../errors.js";

// SQLite supports transactional CREATE/ALTER and FTS DDL. Kysely's generic
// SQLite migrator opts out; explicitly enable it for our controlled migrations.
class AtomicAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl() {
    return true;
  }
}
class ImmediateDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection) {
    // Reserve the writer before reading revisions; cross-process contenders wait
    // rather than failing a later deferred read->write lock upgrade.
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        await connection.executeQuery(CompiledQuery.raw("BEGIN IMMEDIATE"));
        return;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          String(error.code).startsWith("SQLITE_BUSY")
        ))
          throw error;
        if (Date.now() >= deadline)
          throw new DomainError(
            "database_busy",
            "SQLite writer wait budget exhausted; retry the request",
            true,
          );
        // Native busy waits block the event loop and can deadlock another Store
        // connection in this process. Yield so the owning transaction can finish.
        await delay(10 + Math.floor(Math.random() * 20));
      }
    }
  }
}
export class AtomicSqliteDialect extends SqliteDialect {
  constructor(private readonly configuration: SqliteDialectConfig) {
    super(configuration);
  }
  override createAdapter() {
    return new AtomicAdapter();
  }
  override createDriver() {
    return new ImmediateDriver(this.configuration);
  }
}
