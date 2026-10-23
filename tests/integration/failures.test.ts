import { expect, it } from "vitest";
import { sql } from "kysely";
import { id, errorResponse } from "@bug-manager/core";
import { fixture, mutation } from "../helpers.js";

it.skipIf(!process.env.BUG_MANAGER_TEST_DATABASE_URL)(
  "DB-003/006 rolls back knowledge and idempotency on an actual PostgreSQL connection termination and retries cleanly",
  async () => {
    const f = await fixture("postgres"),
      meta = mutation(),
      type_id = id(),
      request = { operation: "synthetic.connection.failure" };
    const row = {
      id: type_id,
      name: "Synthetic disconnect",
      normalized_name: "synthetic disconnect",
      definition: "Failure injection fixture",
      parent_id: null,
      revision: 1,
      disposition: "active",
      created_at: new Date().toISOString(),
    };
    try {
      await expect(
        f.store.write(meta, request, async (tx) => {
          await tx.insertInto("types").values(row).execute();
          await sql`SELECT pg_terminate_backend(pg_backend_pid())`.execute(tx);
          return { saved: true };
        }),
      ).rejects.toBeTruthy();
      expect(
        await f.store.db
          .selectFrom("types")
          .select("id")
          .where("id", "=", type_id)
          .execute(),
      ).toHaveLength(0);
      expect(
        await f.store.db
          .selectFrom("mutation_records")
          .select("idempotency_key")
          .where("idempotency_key", "=", meta.idempotency_key)
          .execute(),
      ).toHaveLength(0);
      expect(
        await f.store.write(meta, request, async (tx) => {
          await tx.insertInto("types").values(row).execute();
          return { saved: true };
        }),
      ).toEqual({ saved: true });
      expect((await f.store.health()).available).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);
it("DB-006 returns safe actionable resource/connection diagnostics without exposing supplied driver text", () => {
  for (const [code, expected] of [
    ["ECONNREFUSED", "connection_unavailable"],
    ["57P01", "connection_unavailable"],
    ["ENOSPC", "storage_full"],
    ["SQLITE_FULL", "storage_full"],
    ["EACCES", "access_denied"],
  ]) {
    const response = errorResponse(
      Object.assign(
        new Error(
          "postgresql://synthetic:do-not-leak@127.0.0.1/db private historical text",
        ),
        { code },
      ),
    );
    expect(response.code).toBe(expected);
    expect(JSON.stringify(response)).not.toContain("do-not-leak");
    expect(JSON.stringify(response)).not.toContain("historical text");
  }
});
it.skipIf(!process.env.BUG_MANAGER_TEST_DATABASE_URL)(
  "DB-002 isolates concurrent PostgreSQL initialization and introspection by the configured schema",
  async () => {
    const fixtures = await Promise.all([
      fixture("postgres"),
      fixture("postgres"),
      fixture("postgres"),
    ]);
    try {
      const names = await Promise.all(
        fixtures.map(async (f) => {
          const tables = await f.store.db.introspection.getTables({
            withInternalKyselyTables: true,
          });
          expect(
            tables.filter((t) => t.name === "kysely_migration_lock"),
          ).toHaveLength(1);
          const schemas = [...new Set(tables.map((t) => t.schema))];
          expect(schemas).toHaveLength(1);
          expect((await f.store.health()).available).toBe(true);
          return schemas[0];
        }),
      );
      expect(new Set(names).size).toBe(3);
    } finally {
      await Promise.all(fixtures.map((f) => f.cleanup()));
    }
  },
);
