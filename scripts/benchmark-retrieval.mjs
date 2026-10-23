// Synthetic performance fixture only. The PostgreSQL path requires the dedicated
// test URL, creates a random schema and drops only that schema in finally.
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import pg from "pg";
import { sql } from "kysely";
import {
  Catalog,
  Taxonomy,
  openStore,
  id,
  now,
  canonical,
  hash,
  searchTokens,
} from "../packages/core/dist/index.js";

const backend = process.argv[2] ?? "sqlite",
  count = Number(process.argv[3] ?? 100000);
if (
  !["sqlite", "postgres"].includes(backend) ||
  !Number.isSafeInteger(count) ||
  count < 1000 ||
  count > 1000000
)
  throw new Error(
    "Usage: npm run benchmark:retrieval -- sqlite|postgres [count-per-kind:1000..1000000]",
  );
const directory = await mkdtemp(
  path.join(os.tmpdir(), "bug-manager-benchmark-"),
);
let store, admin, schema, envKey;
const timestamp = now(),
  started = performance.now();
let peakRss = process.memoryUsage().rss;
const memory = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
const meta = () => ({
  idempotency_key: id(),
  actor: "synthetic-benchmark",
  reason: "Reproducible synthetic benchmark",
});
const entityId = (kind, index) =>
  `${kind === "bug" ? "b" : "c"}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
try {
  let database;
  if (backend === "postgres") {
    if (!process.env.BUG_MANAGER_TEST_DATABASE_URL)
      throw new Error("Dedicated BUG_MANAGER_TEST_DATABASE_URL required");
    admin = new pg.Pool({
      connectionString: process.env.BUG_MANAGER_TEST_DATABASE_URL,
    });
    schema = `bm_benchmark_${id().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.BUG_MANAGER_TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    envKey = `BUG_MANAGER_BENCHMARK_${id().replaceAll("-", "")}`;
    process.env[envKey] = url.toString();
    database = { kind: "postgres", url_env: envKey };
  } else
    database = {
      kind: "sqlite",
      filename: path.join(directory, "benchmark.sqlite"),
    };
  store = await openStore(database);
  await store.initialize();
  const taxonomy = new Taxonomy(store),
    catalog = new Catalog(store),
    types = [];
  for (let i = 0; i < 100; i++) {
    const proposed = await taxonomy.propose(
      {
        name: `Synthetic type ${i}`,
        definition: `Synthetic controlled category ${i}`,
      },
      meta(),
    );
    types.push(
      (
        await taxonomy.resolve(
          { type_id: proposed.id, expected_revision: 1, decision: "confirm" },
          meta(),
        )
      ).id,
    );
  }
  const seedStart = performance.now();
  for (const kind of ["bug", "standard"]) {
    const table = kind === "bug" ? "bugs" : "standards",
      revisions = kind === "bug" ? "bug_revisions" : "standard_revisions",
      memberships = kind === "bug" ? "bug_types" : "standard_types";
    for (let start = 0; start < count; start += 250) {
      const entities = [],
        versions = [],
        typeRows = [];
      for (let i = start; i < Math.min(start + 250, count); i++) {
        const entity_id = entityId(kind, i),
          type_ids = [types[i % 100], types[(i + 17) % 100]],
          mechanism =
            i % 5 === 0
              ? `并发重试缺少幂等保护 retry concurrency ${i}`
              : `缓存边界 cache boundary ${i}`,
          title = `Synthetic ${kind} ${i}`,
          search_text = searchTokens(`${title} ${mechanism}`).join(" "),
          common = {
            title,
            mechanism,
            type_ids,
            tags: [],
            confidence: {
              assessment: "supported",
              reason: "Synthetic fixture",
              evidence: [
                { kind: "observation", excerpt: "Synthetic duplicate effects" },
              ],
            },
          },
          record =
            kind === "bug"
              ? {
                  ...common,
                  severity: "S1",
                  severity_reason: "Synthetic impact",
                  symptoms: ["Duplicate effects"],
                  trigger_conditions: ["Retry"],
                  impact: "Synthetic business effects",
                  mechanism_confirmed: true,
                }
              : {
                  ...common,
                  importance: "I1",
                  importance_reason: "Synthetic prevention",
                  objective: "One business effect",
                  parameters: [],
                  scenarios: [
                    {
                      scenario_id: "repeat",
                      title: "Repeat request",
                      preconditions: ["Synthetic repeatable operation"],
                      steps: ["Repeat request"],
                      expected_results: ["One effect"],
                      evidence_requirements: [
                        {
                          key: "effect",
                          kind: "log",
                          description: "Synthetic effects",
                          required: true,
                        },
                      ],
                    },
                  ],
                };
        entities.push({
          id: entity_id,
          current_revision: 1,
          disposition: "active",
          title,
          mechanism,
          rating: kind === "bug" ? "S1" : "I1",
          search_text,
          fingerprint: hash(canonical({ kind, mechanism, type_ids })),
          created_at: timestamp,
          updated_at: timestamp,
        });
        versions.push({
          entity_id,
          revision: 1,
          payload: canonical({ record, disposition: "active" }),
          actor: "synthetic-benchmark",
          reason: "Synthetic seed",
          created_at: timestamp,
        });
        for (const type_id of type_ids) typeRows.push({ entity_id, type_id });
      }
      await store.db.transaction().execute(async (tx) => {
        await tx.insertInto(table).values(entities).execute();
        await tx.insertInto(revisions).values(versions).execute();
        await tx.insertInto(memberships).values(typeRows).execute();
        if (backend === "sqlite") {
          const values = entities.map((e) => sql`(${e.id},${e.search_text})`);
          await sql`INSERT INTO ${sql.table(`${table}_fts`)} (entity_id,tokens) VALUES ${sql.join(values)}`.execute(
            tx,
          );
        }
      });
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    process.stdout.write(
      `${backend}: seeded ${count} ${kind} records with two types each\n`,
    );
  }
  const seedMs = performance.now() - seedStart;
  if (backend === "postgres") await sql`ANALYZE`.execute(store.db);
  const selected = [types[0], types[1]],
    measurements = [];
  for (const kind of ["bug", "standard"]) {
    const table = kind === "bug" ? "bugs" : "standards",
      memberships = kind === "bug" ? "bug_types" : "standard_types",
      membership = store.db
        .selectFrom(memberships)
        .select("entity_id")
        .where("type_id", "in", selected)
        .groupBy("entity_id"),
      filtered = await store.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as("count"))
        .where("id", "in", membership)
        .executeTakeFirstOrThrow();
    for (const query of [
      undefined,
      "并发 重试",
      "retry concurrency",
      "缓存 cache",
    ]) {
      const timings = [];
      let returned = 0,
        pages = 0;
      for (let repeat = 0; repeat < 5; repeat++) {
        let cursor;
        returned = 0;
        pages = 0;
        const begin = performance.now();
        do {
          const page = await catalog.search(kind, {
            type_ids: selected,
            query,
            limit: 200,
            cursor,
          });
          returned += page.items.length;
          pages++;
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
        timings.push(performance.now() - begin);
      }
      measurements.push({
        kind,
        query: query ?? "(type-only)",
        total_before_type_filter: count,
        filtered_distinct_candidates: Number(filtered.count),
        returned_matches: returned,
        page_size: 200,
        pages,
        repetitions: timings.length,
        total_pagination_ms: timings,
        mean_total_pagination_ms:
          timings.reduce((a, b) => a + b, 0) / timings.length,
      });
    }
  }
  const output = {
    schema_version: 1,
    generated_at: now(),
    fixture_version: "multi-type-100-v1",
    backend,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    os_release: os.release(),
    cpu: os.cpus()[0]?.model,
    logical_cores: os.cpus().length,
    host_memory_bytes: os.totalmem(),
    bugs: count,
    standards: count,
    types: 100,
    types_per_entity: 2,
    selected_types: 2,
    seed_ms: seedMs,
    total_ms: performance.now() - started,
    peak_node_rss_bytes: Math.max(
      peakRss,
      process.resourceUsage().maxRSS * 1024,
    ),
    memory_scope:
      "Node client only; PostgreSQL server/Docker memory not included",
    methodology:
      "Direct batched synthetic seed with revision/type/FTS tables; real Catalog.search pages all matches, 5 repetitions without a forced warmup or OS cache reset, no embedding or remote model; not an ingestion/semantic-quality benchmark",
    measurements,
  };
  const artifacts = path.resolve("artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(artifacts, `retrieval-${backend}.json`),
    JSON.stringify(output, null, 2),
  );
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} finally {
  clearInterval(memory);
  if (store) await store.close();
  if (admin) {
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
  if (envKey) delete process.env[envKey];
  await rm(directory, { recursive: true, force: true });
}
