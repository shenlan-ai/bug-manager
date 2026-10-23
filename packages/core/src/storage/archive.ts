import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { sql } from "kysely";
import { z } from "zod";
import type { Store } from "./database.js";
import type { Schema } from "./schema.js";
import { EvidenceStore } from "./evidence.js";
import { canonical, now } from "../util.js";
import { invariant } from "../errors.js";

// Topological insertion order; FTS and migration internals are rebuilt, never copied.
const primaryKeys = {
  projects: ["id"],
  types: ["id"],
  type_aliases: ["alias"],
  type_revisions: ["entity_id", "revision"],
  project_locations: ["location"],
  project_type_revisions: ["project_id", "revision"],
  project_type_selections: ["project_id", "type_id"],
  tags: ["id"],
  bugs: ["id"],
  standards: ["id"],
  bug_revisions: ["entity_id", "revision"],
  standard_revisions: ["entity_id", "revision"],
  bug_types: ["entity_id", "type_id"],
  standard_types: ["entity_id", "type_id"],
  entity_tag_links: ["entity_kind", "entity_id", "tag_id"],
  bug_contexts: ["id"],
  bug_standard_links: ["bug_id", "standard_id"],
  bug_standard_link_revisions: ["bug_id", "standard_id", "revision"],
  knowledge_candidates: ["id"],
  entity_redirects: ["entity_kind", "old_id"],
  mutation_records: ["idempotency_key"],
  request_reservations: ["idempotency_key"],
  source_roots: ["id"],
  history_discovery_issues: ["root_id", "path_hash"],
  source_sessions: ["id"],
  source_segments: ["id"],
  history_event_receipts: ["replay_key"],
  history_source_issues: ["id"],
  provenance_links: ["id"],
  jobs: ["id"],
  segment_tasks: ["id"],
  checkpoints: ["source_id"],
  change_snapshots: ["id"],
  acceptance_plans: ["id"],
  plan_items: ["id"],
  plan_selection_decisions: ["plan_id", "standard_id"],
  acceptance_results: ["id"],
  evidence: ["id"],
  report_exports: ["id"],
  report_result_links: ["report_id", "plan_item_id"],
  embeddings: [
    "entity_kind",
    "entity_id",
    "revision",
    "model_id",
    "normalization_version",
  ],
} satisfies Partial<Record<keyof Schema, string[]>>;
type Table = keyof typeof primaryKeys;
const tables = Object.keys(primaryKeys) as Table[];
const manifestSchema = z
  .object({
    schema_version: z.literal(1),
    created_at: z.string(),
    rows_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    table_counts: z.record(z.string(), z.number().int().nonnegative()),
    evidence: z.array(
      z.object({
        object_key: z.string(),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/),
        availability: z.enum(["available", "unavailable"]),
      }),
    ),
  })
  .strict();

export async function exportArchive(
  store: Store,
  evidence: EvidenceStore,
  destination: string,
) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const file = await open(path.join(destination, "rows.ndjson"), "wx", 0o600),
    digest = createHash("sha256");
  const table_counts: Record<string, number> = {},
    objects: {
      object_key: string;
      content_hash: string;
      availability: "available" | "unavailable";
    }[] = [];
  try {
    let transaction = store.db.transaction();
    if (store.dialect === "postgres")
      transaction = transaction.setIsolationLevel("repeatable read");
    await transaction.execute(async (tx) => {
      for (const table of tables) {
        let last: unknown[] | undefined;
        table_counts[table] = 0;
        const keys = primaryKeys[table];
        for (;;) {
          const where = last
            ? sql`WHERE (${sql.join(keys.map((k) => sql.ref(k)))}) > (${sql.join(last)})`
            : sql``;
          const batch = await sql<
            Record<string, unknown>
          >`SELECT * FROM ${sql.table(table)} ${where} ORDER BY ${sql.join(keys.map((k) => sql.ref(k)))} LIMIT 500`.execute(
            tx,
          );
          for (const row of batch.rows) {
            const line = canonical({ table, row }) + "\n";
            await file.write(line);
            digest.update(line);
            table_counts[table]++;
            if (
              table === "evidence" &&
              typeof row.object_key === "string" &&
              typeof row.content_hash === "string"
            ) {
              if (!objects.some((o) => o.object_key === row.object_key))
                objects.push({
                  object_key: row.object_key,
                  content_hash: row.content_hash,
                  availability: "available",
                });
            }
          }
          if (batch.rows.length < 500) break;
          last = keys.map((key) => batch.rows.at(-1)![key]);
        }
      }
    });
  } finally {
    await file.close();
  }
  const archiveEvidence = new EvidenceStore(destination, evidence.maxBytes);
  for (const object of objects) {
    try {
      await archiveEvidence.putManaged(
        await evidence.read(object.object_key),
        object.content_hash,
      );
    } catch {
      object.availability = "unavailable";
    }
  }
  const manifest = manifestSchema.parse({
    schema_version: 1,
    created_at: now(),
    rows_sha256: digest.digest("hex"),
    table_counts,
    evidence: objects,
  });
  await writeFile(
    path.join(destination, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}

export async function importArchive(
  store: Store,
  evidence: EvidenceStore,
  directory: string,
) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
  );
  invariant(
    Object.keys(manifest.table_counts).length === tables.length &&
      tables.every((t) => Object.hasOwn(manifest.table_counts, t)),
    "invalid_archive",
    "Archive has unexpected or missing tables",
  );
  const archiveEvidence = new EvidenceStore(directory, evidence.maxBytes);
  for (const item of manifest.evidence)
    if (item.availability === "available")
      await evidence.putManaged(
        await archiveEvidence.read(item.object_key),
        item.content_hash,
      );
  return store.db.transaction().execute(async (tx) => {
    await tx
      .updateTable("library_lock")
      .set({ revision: sql`revision+1` })
      .where("id", "=", 1)
      .execute();
    for (const table of tables) {
      const count = await sql<{
        count: string | number;
      }>`SELECT count(*) AS count FROM ${sql.table(table)}`.execute(tx);
      invariant(
        Number(count.rows[0]!.count) === 0,
        "destination_not_empty",
        "Import requires an empty initialized destination; existing data is not overwritten",
      );
    }
    const allColumns = await tx.introspection.getTables();
    const digest = createHash("sha256"),
      counts: Record<string, number> = {};
    let previousTable = -1;
    const typeParents = new Map<string, string>();
    const stream = createReadStream(path.join(directory, "rows.ndjson"), {
      encoding: "utf8",
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        invariant(
          line.length <= 16 * 1024 * 1024,
          "invalid_archive",
          "Archive row exceeds size limit",
        );
        digest.update(line + "\n");
        const entry = z
          .object({
            table: z.string(),
            row: z.record(
              z.string(),
              z.union([z.string(), z.number().finite(), z.null()]),
            ),
          })
          .strict()
          .parse(JSON.parse(line));
        invariant(
          Object.hasOwn(primaryKeys, entry.table),
          "invalid_archive",
          "Archive references an unknown table",
        );
        const table = entry.table as Table,
          index = tables.indexOf(table);
        invariant(
          index >= previousTable,
          "invalid_archive",
          "Archive table order is invalid",
        );
        previousTable = index;
        const columns = Object.keys(entry.row),
          expected =
            allColumns
              .find((t) => t.name === table)
              ?.columns.map((c) => c.name) ?? [];
        invariant(
          columns.length === expected.length &&
            columns.every((c) => expected.includes(c)),
          "invalid_archive",
          "Archive column set does not match the current schema",
        );
        const values = { ...entry.row };
        if (table === "types" && typeof values.parent_id === "string") {
          typeParents.set(String(values.id), values.parent_id);
          values.parent_id = null;
        }
        await sql`INSERT INTO ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))}) VALUES (${sql.join(columns.map((c) => values[c]))})`.execute(
          tx,
        );
        counts[table] = (counts[table] ?? 0) + 1;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    invariant(
      digest.digest("hex") === manifest.rows_sha256,
      "archive_checksum_mismatch",
      "Archive changed or its checksum is invalid",
    );
    invariant(
      tables.every((t) => (counts[t] ?? 0) === manifest.table_counts[t]),
      "invalid_archive",
      "Archive row counts do not match its manifest",
    );
    for (const [typeId, parent] of typeParents) {
      const seen = new Set([typeId]);
      let current: string | undefined = parent;
      while (current) {
        invariant(
          !seen.has(current),
          "invalid_archive",
          "Type hierarchy contains a cycle",
        );
        seen.add(current);
        current = typeParents.get(current);
      }
      await tx
        .updateTable("types")
        .set({ parent_id: parent })
        .where("id", "=", typeId)
        .execute();
    }
    if (store.dialect === "sqlite")
      for (const kind of ["bugs", "standards"])
        await sql`INSERT INTO ${sql.table(`${kind}_fts`)}(entity_id,tokens) SELECT id,search_text FROM ${sql.table(kind)}`.execute(
          tx,
        );
    return {
      schema_version: 1,
      imported_counts: manifest.table_counts,
      unavailable_evidence: manifest.evidence.filter(
        (e) => e.availability === "unavailable",
      ).length,
    };
  });
}

export async function backupSqlite(store: Store, destination: string) {
  invariant(
    store.dialect === "sqlite" && store.native,
    "unsupported_backend",
    "Native snapshot is only available for SQLite; use portable export for PostgreSQL",
  );
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  const handle = await open(destination, "wx", 0o600);
  await handle.close();
  await store.native.backup(destination);
  return { filename: path.resolve(destination), consistent_snapshot: true };
}
