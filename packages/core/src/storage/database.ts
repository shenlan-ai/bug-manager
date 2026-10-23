import { mkdir } from "node:fs/promises";
import path from "node:path";
import Sqlite from "better-sqlite3";
import pg from "pg";
import { Kysely, sql } from "kysely";
import type { Transaction } from "kysely";
import { z } from "zod";
import type { Config } from "../config.js";
import { DomainError, invariant } from "../errors.js";
import { canonical, decodeJson, hash, now } from "../util.js";
import { migrate, migrationNames } from "./migrations.js";
import { AtomicSqliteDialect } from "./sqlite-dialect.js";
import { ScopedPostgresDialect } from "./postgres-dialect.js";
import type { Schema } from "./schema.js";

export const mutationSchema = z.object({
  idempotency_key: z.string().min(1).max(200),
  actor: z.string().min(1).max(200),
  reason: z.string().min(1).max(4000),
});
export type Mutation = z.infer<typeof mutationSchema>;
export type Db = Kysely<Schema> | Transaction<Schema>;
export class Store {
  constructor(
    readonly db: Kysely<Schema>,
    readonly dialect: "sqlite" | "postgres",
    readonly native?: Sqlite.Database,
  ) {}
  async initialize() {
    return migrate(this.db, this.dialect);
  }
  async close() {
    await this.db.destroy();
  }
  async write<T>(
    meta: Mutation,
    request: unknown,
    operation: (tx: Transaction<Schema>) => Promise<T>,
    options: { invalidateKnowledgeCursors?: boolean } = {},
  ): Promise<T> {
    mutationSchema.parse(meta);
    const digest = hash(
      canonical({ request, actor: meta.actor, reason: meta.reason }),
    );
    return this.db.transaction().execute(async (tx) => {
      // Acquire a database write lock before any reads (also avoids SQLite upgrade races).
      await tx
        .updateTable("library_lock")
        .set({
          revision:
            options.invalidateKnowledgeCursors === false
              ? sql`revision`
              : sql`revision+1`,
        })
        .where("id", "=", 1)
        .execute();
      const reserved = await tx
        .selectFrom("request_reservations")
        .select("request_hash")
        .where("idempotency_key", "=", meta.idempotency_key)
        .executeTakeFirst();
      invariant(
        !reserved || reserved.request_hash === digest,
        "idempotency_conflict",
        "Idempotency key was used for a different request",
      );
      const prior = await tx
        .selectFrom("mutation_records")
        .selectAll()
        .where("idempotency_key", "=", meta.idempotency_key)
        .executeTakeFirst();
      if (prior) {
        invariant(
          prior.request_hash === digest,
          "idempotency_conflict",
          "Idempotency key was used for a different request",
        );
        return decodeJson<T>(prior.response);
      }
      const result = await operation(tx);
      await tx
        .insertInto("mutation_records")
        .values({
          idempotency_key: meta.idempotency_key,
          request_hash: digest,
          response: canonical(result),
          actor: meta.actor,
          created_at: now(),
        })
        .execute();
      return result;
    });
  }
  async replay<T>(
    meta: Mutation,
    request: unknown,
  ): Promise<{ found: false } | { found: true; result: T }> {
    mutationSchema.parse(meta);
    const prior = await this.db
      .selectFrom("mutation_records")
      .selectAll()
      .where("idempotency_key", "=", meta.idempotency_key)
      .executeTakeFirst();
    if (!prior) return { found: false };
    invariant(
      prior.request_hash ===
        hash(canonical({ request, actor: meta.actor, reason: meta.reason })),
      "idempotency_conflict",
      "Idempotency key was used for a different request",
    );
    return { found: true, result: decodeJson<T>(prior.response) };
  }
  // Reserve the public request and claim work in one short transaction. Only the
  // final checkpoint records its response; retry never replays an expired owner.
  async begin<T, R>(
    meta: Mutation,
    request: unknown,
    claim: (tx: Transaction<Schema>) => Promise<T>,
  ): Promise<{ replayed: true; result: R } | { replayed: false; claim: T }> {
    mutationSchema.parse(meta);
    const digest = hash(
      canonical({ request, actor: meta.actor, reason: meta.reason }),
    );
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("library_lock")
        .set({ revision: sql`revision+1` })
        .where("id", "=", 1)
        .execute();
      const prior = await tx
        .selectFrom("mutation_records")
        .selectAll()
        .where("idempotency_key", "=", meta.idempotency_key)
        .executeTakeFirst();
      if (prior) {
        invariant(
          prior.request_hash === digest,
          "idempotency_conflict",
          "Idempotency key was used for a different request",
        );
        return { replayed: true, result: decodeJson<R>(prior.response) };
      }
      const reserved = await tx
        .selectFrom("request_reservations")
        .selectAll()
        .where("idempotency_key", "=", meta.idempotency_key)
        .executeTakeFirst();
      invariant(
        !reserved || reserved.request_hash === digest,
        "idempotency_conflict",
        "Idempotency key was used for a different request",
      );
      if (!reserved)
        await tx
          .insertInto("request_reservations")
          .values({
            idempotency_key: meta.idempotency_key,
            request_hash: digest,
            created_at: now(),
          })
          .execute();
      return { replayed: false, claim: await claim(tx) };
    });
  }
  async health() {
    await sql`SELECT 1`.execute(this.db);
    const applied = await migrationNames(this.db, this.dialect);
    invariant(
      applied.length > 0,
      "schema_not_initialized",
      "Run bug-manager init to create the database schema",
    );
    invariant(
      applied.every((name) =>
        [
          "001_initial",
          "002_history_runtime",
          "003_history_coverage",
          "004_resumable_requests",
          "005_change_snapshots",
          "006_acceptance_execution",
        ].includes(name),
      ),
      "schema_too_new",
      "Database schema requires a newer bug-manager version",
    );
    invariant(
      applied.includes("006_acceptance_execution"),
      "schema_upgrade_required",
      "Run bug-manager init to migrate the database",
    );
    return { database: this.dialect, available: true, schema_version: 6 };
  }
}

export async function openStore(database: Config["database"]): Promise<Store> {
  if (database.kind === "sqlite") {
    if (database.filename !== ":memory:")
      await mkdir(path.dirname(path.resolve(database.filename)), {
        recursive: true,
      });
    const native = new Sqlite(database.filename);
    native.pragma("foreign_keys=ON");
    native.pragma("busy_timeout=50");
    native.pragma("journal_mode=WAL");
    native.pragma("busy_timeout=0");
    return new Store(
      new Kysely<Schema>({
        dialect: new AtomicSqliteDialect({ database: native }),
      }),
      "sqlite",
      native,
    );
  }
  const url = process.env[database.url_env];
  if (!url)
    throw new DomainError(
      "missing_database_url",
      `Environment variable ${database.url_env} is required`,
    );
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 10_000,
    // Keep bigint timestamps within JS safe integers rather than driver's string default.
    types: {
      getTypeParser: (oid: number, format?: string) =>
        oid === 20
          ? (value: string) => Number(value)
          : pg.types.getTypeParser(oid, format as "text"),
    },
  });
  // pg removes failed idle clients itself. Handle the notification without
  // logging raw driver text or crashing the process; active queries still reject.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  return new Store(
    new Kysely<Schema>({ dialect: new ScopedPostgresDialect({ pool }) }),
    "postgres",
  );
}
