import { Migrator, sql } from "kysely";
import type { Kysely, Migration } from "kysely";
import type { Schema } from "./schema.js";
import { DomainError } from "../errors.js";

const entityColumns =
  "id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, disposition TEXT NOT NULL, title TEXT NOT NULL, mechanism TEXT NOT NULL, rating TEXT NOT NULL, search_text TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";
const revisionColumns = (entity: string) =>
  `entity_id TEXT NOT NULL REFERENCES ${entity}(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity_id,revision)`;

const ddl = [
  "CREATE TABLE library_lock (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)",
  "INSERT INTO library_lock(id,revision) VALUES(1,0)",
  "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE project_locations (location TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), repository_hint TEXT, reason TEXT NOT NULL, actor TEXT NOT NULL)",
  "CREATE TABLE types (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, definition TEXT NOT NULL, parent_id TEXT REFERENCES types(id), revision INTEGER NOT NULL, disposition TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE type_aliases (alias TEXT PRIMARY KEY, type_id TEXT NOT NULL REFERENCES types(id))",
  `CREATE TABLE type_revisions (${revisionColumns("types")})`,
  "CREATE TABLE project_type_revisions (project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, type_ids TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,revision))",
  "CREATE TABLE project_type_selections (project_id TEXT NOT NULL REFERENCES projects(id), type_id TEXT NOT NULL REFERENCES types(id), selection_revision INTEGER NOT NULL, PRIMARY KEY(project_id,type_id))",
  "CREATE INDEX project_types_by_type ON project_type_selections(type_id,project_id)",
  "CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE)",
  `CREATE TABLE bugs (${entityColumns})`,
  `CREATE TABLE standards (${entityColumns})`,
  `CREATE TABLE bug_revisions (${revisionColumns("bugs")})`,
  `CREATE TABLE standard_revisions (${revisionColumns("standards")})`,
  "CREATE TABLE bug_types (entity_id TEXT NOT NULL REFERENCES bugs(id), type_id TEXT NOT NULL REFERENCES types(id), PRIMARY KEY(entity_id,type_id))",
  "CREATE TABLE standard_types (entity_id TEXT NOT NULL REFERENCES standards(id), type_id TEXT NOT NULL REFERENCES types(id), PRIMARY KEY(entity_id,type_id))",
  "CREATE INDEX bug_types_by_type ON bug_types(type_id,entity_id)",
  "CREATE INDEX standard_types_by_type ON standard_types(type_id,entity_id)",
  "CREATE INDEX bugs_by_fingerprint ON bugs(fingerprint)",
  "CREATE INDEX standards_by_fingerprint ON standards(fingerprint)",
  "CREATE TABLE entity_tag_links (entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY(entity_kind,entity_id,tag_id))",
  "CREATE TABLE bug_contexts (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bugs(id), project_id TEXT REFERENCES projects(id), payload TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE)",
  "CREATE TABLE bug_standard_links (bug_id TEXT NOT NULL REFERENCES bugs(id), standard_id TEXT NOT NULL REFERENCES standards(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(bug_id,standard_id))",
  "CREATE TABLE bug_standard_link_revisions (bug_id TEXT NOT NULL REFERENCES bugs(id), standard_id TEXT NOT NULL REFERENCES standards(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(bug_id,standard_id,revision))",
  "CREATE TABLE knowledge_candidates (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, disposition TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX candidates_by_kind ON knowledge_candidates(kind,disposition,id)",
  "CREATE TABLE entity_redirects (entity_kind TEXT NOT NULL, old_id TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity_kind,old_id))",
  "CREATE TABLE mutation_records (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE source_roots (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, path TEXT NOT NULL, exclusions TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(adapter,path))",
  "CREATE TABLE source_sessions (id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES source_roots(id), external_id TEXT NOT NULL, generation TEXT NOT NULL, source_path TEXT NOT NULL, metadata TEXT NOT NULL, coverage TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(root_id,external_id,generation))",
  "CREATE TABLE source_segments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES source_sessions(id), logical_key TEXT NOT NULL, content_hash TEXT NOT NULL, excerpt TEXT NOT NULL, context TEXT NOT NULL, analysis_version TEXT NOT NULL, privacy_version TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id,logical_key,content_hash,analysis_version,privacy_version))",
  "CREATE TABLE provenance_links (id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, segment_id TEXT NOT NULL REFERENCES source_segments(id), payload TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE)",
  "CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, owner_token TEXT, lease_until BIGINT NOT NULL, attempts INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE segment_tasks (id TEXT PRIMARY KEY, segment_id TEXT NOT NULL REFERENCES source_segments(id), analysis_version TEXT NOT NULL, status TEXT NOT NULL, owner_token TEXT, lease_until BIGINT NOT NULL, attempts INTEGER NOT NULL, result TEXT, updated_at TEXT NOT NULL, UNIQUE(segment_id,analysis_version))",
  "CREATE INDEX segment_tasks_claim ON segment_tasks(status,lease_until,id)",
  "CREATE TABLE checkpoints (source_id TEXT PRIMARY KEY, generation TEXT NOT NULL, read_offset BIGINT NOT NULL, metadata TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE acceptance_plans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), snapshot TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE plan_items (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES acceptance_plans(id), standard_id TEXT NOT NULL REFERENCES standards(id), standard_revision INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(plan_id,standard_id), FOREIGN KEY(standard_id,standard_revision) REFERENCES standard_revisions(entity_id,revision))",
  "CREATE TABLE plan_selection_decisions (plan_id TEXT NOT NULL REFERENCES acceptance_plans(id), standard_id TEXT NOT NULL REFERENCES standards(id), payload TEXT NOT NULL, PRIMARY KEY(plan_id,standard_id))",
  "CREATE TABLE acceptance_results (id TEXT PRIMARY KEY, plan_item_id TEXT NOT NULL REFERENCES plan_items(id), attempt_id TEXT NOT NULL, outcome TEXT NOT NULL, environment_hash TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_item_id,attempt_id))",
  "CREATE TABLE evidence (id TEXT PRIMARY KEY, result_id TEXT NOT NULL REFERENCES acceptance_results(id), kind TEXT NOT NULL, object_key TEXT, content_hash TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE report_exports (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES acceptance_plans(id), payload TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE embeddings (entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, model_id TEXT NOT NULL, dimensions INTEGER NOT NULL, normalization_version TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(entity_kind,entity_id,revision,model_id,normalization_version))",
];

export async function migrationNames(
  db: Kysely<Schema>,
  dialect: "sqlite" | "postgres",
): Promise<string[]> {
  const tables = await db.introspection.getTables({
    withInternalKyselyTables: true,
  });
  const schema =
    dialect === "postgres"
      ? (
          await sql<{
            schema: string;
          }>`SELECT current_schema() AS schema`.execute(db)
        ).rows[0]?.schema
      : undefined;
  if (
    !tables.some(
      (t) =>
        t.name === "kysely_migration" &&
        (dialect === "sqlite" || t.schema === schema),
    )
  )
    return [];
  return (
    await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(db)
  ).rows.map((r) => r.name);
}

export async function migrate(
  db: Kysely<Schema>,
  dialect: "sqlite" | "postgres",
  extra: Record<string, Migration> = {},
) {
  const migrations: Record<string, Migration> = {
    "001_initial": {
      async up(tx) {
        for (const statement of ddl) await sql.raw(statement).execute(tx);
        if (dialect === "sqlite") {
          await sql`CREATE VIRTUAL TABLE bugs_fts USING fts5(entity_id UNINDEXED, tokens)`.execute(
            tx,
          );
          await sql`CREATE VIRTUAL TABLE standards_fts USING fts5(entity_id UNINDEXED, tokens)`.execute(
            tx,
          );
        } else {
          await sql`CREATE INDEX bugs_search_idx ON bugs USING GIN(to_tsvector('simple',search_text))`.execute(
            tx,
          );
          await sql`CREATE INDEX standards_search_idx ON standards USING GIN(to_tsvector('simple',search_text))`.execute(
            tx,
          );
        }
      },
    },
    "002_history_runtime": {
      async up(tx) {
        await sql`CREATE TABLE history_event_receipts (replay_key TEXT PRIMARY KEY, segment_id TEXT NOT NULL REFERENCES source_segments(id))`.execute(
          tx,
        );
        await sql`CREATE INDEX source_sessions_path ON source_sessions(root_id,source_path)`.execute(
          tx,
        );
        await sql`CREATE INDEX source_sessions_identity ON source_sessions(external_id,created_at)`.execute(
          tx,
        );
        await sql`CREATE INDEX source_segments_session ON source_segments(session_id,created_at,id)`.execute(
          tx,
        );
      },
    },
    "003_history_coverage": {
      async up(tx) {
        await sql`CREATE TABLE history_source_issues (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_sessions(id), byte_start BIGINT NOT NULL, byte_end BIGINT NOT NULL, line_number INTEGER NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_id,byte_start,byte_end,code))`.execute(
          tx,
        );
        await sql`CREATE INDEX history_issues_source ON history_source_issues(source_id,id)`.execute(
          tx,
        );
      },
    },
    "004_resumable_requests": {
      async up(tx) {
        await sql`CREATE TABLE request_reservations (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, created_at TEXT NOT NULL)`.execute(
          tx,
        );
        await sql`CREATE TABLE history_discovery_issues (root_id TEXT NOT NULL REFERENCES source_roots(id), path_hash TEXT NOT NULL, code TEXT NOT NULL, scan_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(root_id,path_hash))`.execute(
          tx,
        );
      },
    },
    "005_change_snapshots": {
      async up(tx) {
        await sql`CREATE TABLE change_snapshots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), snapshot TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL)`.execute(
          tx,
        );
      },
    },
    "006_acceptance_execution": {
      async up(tx) {
        await sql`ALTER TABLE acceptance_results ADD COLUMN execution_id TEXT NOT NULL DEFAULT ''`.execute(
          tx,
        );
        await sql`CREATE INDEX acceptance_results_execution ON acceptance_results(execution_id,plan_item_id,created_at)`.execute(
          tx,
        );
        await sql`CREATE TABLE report_result_links (report_id TEXT NOT NULL REFERENCES report_exports(id), plan_item_id TEXT NOT NULL REFERENCES plan_items(id), result_id TEXT REFERENCES acceptance_results(id), PRIMARY KEY(report_id,plan_item_id))`.execute(
          tx,
        );
      },
    },
    ...extra,
  };
  const applied = await migrationNames(db, dialect);
  if (applied.some((name) => !Object.hasOwn(migrations, name)))
    throw new DomainError(
      "schema_too_new",
      "Database schema requires a newer bug-manager version",
    );
  const migrator = new Migrator({
    db,
    ...(dialect === "postgres"
      ? {
          migrationTableSchema: (
            await sql<{
              schema: string;
            }>`SELECT current_schema() AS schema`.execute(db)
          ).rows[0]!.schema,
        }
      : {}),
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const result = await migrator.migrateToLatest();
  if (result.error)
    throw new DomainError(
      "migration_failed",
      "Migration failed; changes were rolled back. Check storage and schema compatibility.",
    );
  return (
    result.results?.map((r) => ({ name: r.migrationName, status: r.status })) ??
    []
  );
}
