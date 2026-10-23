import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EvidenceStore,
  backupSqlite,
  exportArchive,
  importArchive,
  id,
  hash,
  now,
  openStore,
} from "@bug-manager/core";
import { bug, fixture, mutation, standard } from "../helpers.js";

async function populated(f: Awaited<ReturnType<typeof fixture>>) {
  const root = await f.type("预防"),
    child = await f.type("幂等", root.id),
    p = await f.projects.register(
      { name: "synthetic", directory: path.join(f.directory, "project") },
      mutation(),
    );
  await f.projects.setTypes(
    { project_id: p.id, type_ids: [child.id], expected_revision: 0 },
    mutation(),
  );
  const result = await f.catalog.apply(
    {
      standards: [{ ref: "s", record: standard([child.id]) }],
      bugs: [{ ref: "b", record: bug([child.id]) }],
      links: [
        {
          bug_ref: "b",
          standard_ref: "s",
          coverage_reason: "Prevent the repeated business effect",
        },
      ],
      contexts: [
        {
          bug_ref: "b",
          project_id: p.id,
          description: "Synthetic project scenario",
        },
      ],
    },
    mutation(),
  );
  const s = result.entities.find((e) => e.kind === "standard")!;
  const sourceRoot = id(),
    session = id(),
    segment = id(),
    bugId = result.entities.find((e) => e.kind === "bug")!.id;
  await f.store.db
    .insertInto("source_roots")
    .values({
      id: sourceRoot,
      adapter: "codex",
      path: "/synthetic-history-only",
      exclusions: "[]",
      created_at: now(),
    })
    .execute();
  await f.store.db
    .insertInto("source_sessions")
    .values({
      id: session,
      root_id: sourceRoot,
      external_id: "synthetic-session",
      generation: "1",
      source_path: "/synthetic-history-only/session.jsonl",
      metadata: "{}",
      coverage: "{}",
      created_at: now(),
    })
    .execute();
  await f.store.db
    .insertInto("source_segments")
    .values({
      id: segment,
      session_id: session,
      logical_key: "event:1",
      content_hash: hash("synthetic observation"),
      excerpt: "synthetic observation",
      context: "[]",
      analysis_version: "1",
      privacy_version: "1",
      created_at: now(),
    })
    .execute();
  await f.store.db
    .insertInto("provenance_links")
    .values({
      id: id(),
      entity_kind: "bug",
      entity_id: bugId,
      segment_id: segment,
      payload: '{"revision":1}',
      fingerprint: hash(bugId + segment),
    })
    .execute();
  await f.catalog.apply(
    {
      standards: [
        {
          ref: "s",
          id: s.id,
          expected_revision: 1,
          record: standard([child.id], { title: "重复提交幂等验收第二版" }),
        },
      ],
    },
    mutation(),
  );
  const evidence = new EvidenceStore(path.join(f.directory, "evidence"));
  await evidence.initialize();
  await writeFile(
    path.join(evidence.root, "inbox", "proof.log"),
    "synthetic business effect count=1",
  );
  const object = await evidence.importFromInbox("proof.log", "log");
  const plan = id(),
    item = id(),
    execution = id();
  await f.store.db
    .insertInto("acceptance_plans")
    .values({ id: plan, project_id: p.id, snapshot: "{}", created_at: now() })
    .execute();
  await f.store.db
    .insertInto("plan_items")
    .values({
      id: item,
      plan_id: plan,
      standard_id: s.id,
      standard_revision: 1,
      payload: "{}",
    })
    .execute();
  await f.store.db
    .insertInto("acceptance_results")
    .values({
      id: execution,
      plan_item_id: item,
      attempt_id: id(),
      outcome: "passed",
      environment_hash: "synthetic",
      payload: "{}",
      actor: "synthetic-agent",
      created_at: now(),
    })
    .execute();
  await f.store.db
    .insertInto("evidence")
    .values({
      id: id(),
      result_id: execution,
      kind: object.kind,
      object_key: object.object_key,
      content_hash: object.content_hash,
      payload: JSON.stringify(object),
      created_at: now(),
    })
    .execute();
  return {
    standardId: s.id,
    projectId: p.id,
    typeId: child.id,
    parentId: root.id,
    evidence,
    object,
  };
}

it("DB-004 creates a consistent native SQLite backup without overwriting a destination", async () => {
  const f = await fixture("sqlite");
  try {
    const data = await populated(f),
      filename = path.join(f.directory, "snapshot.sqlite");
    await backupSqlite(f.store, filename);
    await expect(backupSqlite(f.store, filename)).rejects.toMatchObject({
      code: "EEXIST",
    });
    const copy = await openStore({ kind: "sqlite", filename });
    try {
      expect(
        await copy.db
          .selectFrom("standard_revisions")
          .selectAll()
          .where("entity_id", "=", data.standardId)
          .execute(),
      ).toHaveLength(2);
    } finally {
      await copy.close();
    }
  } finally {
    await f.cleanup();
  }
});

for (const backend of ["sqlite", "postgres"] as const) {
  it.skipIf(!process.env.BUG_MANAGER_TEST_DATABASE_URL)(
    `DB-004 exports ${backend} and restores into ${backend === "sqlite" ? "postgres" : "sqlite"} with identities, hierarchy, versions, links and evidence`,
    async () => {
      const source = await fixture(backend),
        target = await fixture(backend === "sqlite" ? "postgres" : "sqlite");
      try {
        const data = await populated(source),
          archive = path.join(source.directory, "export");
        const manifest = await exportArchive(
          source.store,
          data.evidence,
          archive,
        );
        expect(manifest.evidence).toHaveLength(1);
        expect(manifest.evidence[0]!.availability).toBe("available");
        const targetEvidence = new EvidenceStore(
          path.join(target.directory, "evidence"),
        );
        await importArchive(target.store, targetEvidence, archive);
        expect((await target.projects.types(data.projectId)).type_ids).toEqual([
          data.typeId,
        ]);
        expect(
          (await target.catalog.get("standard", data.standardId, 1)).revision,
        ).toBe(1);
        expect(
          (await target.catalog.get("standard", data.standardId)).revision,
        ).toBe(2);
        expect(
          (
            await target.catalog.search("standard", {
              type_ids: [data.typeId],
              query: "幂等",
            })
          ).items,
        ).toHaveLength(1);
        expect(await targetEvidence.read(data.object.object_key)).toEqual(
          await data.evidence.read(data.object.object_key),
        );
        const child = await target.store.db
          .selectFrom("types")
          .selectAll()
          .where("id", "=", data.typeId)
          .executeTakeFirstOrThrow();
        expect(child.parent_id).toBe(data.parentId);
        expect(
          await target.store.db
            .selectFrom("bug_standard_links")
            .selectAll()
            .execute(),
        ).toHaveLength(1);
        expect(
          await target.store.db
            .selectFrom("bug_contexts")
            .selectAll()
            .execute(),
        ).toHaveLength(1);
        expect(
          await target.store.db
            .selectFrom("provenance_links")
            .selectAll()
            .execute(),
        ).toHaveLength(1);
        expect(
          await source.catalog.get("standard", data.standardId),
        ).toBeDefined();
        await expect(
          importArchive(target.store, targetEvidence, archive),
        ).rejects.toMatchObject({ code: "destination_not_empty" });
      } finally {
        await target.cleanup();
        await source.cleanup();
      }
    },
    60_000,
  );
}

it("DB-004 rejects a tampered archive and rolls back partially inserted rows", async () => {
  const source = await fixture("sqlite"),
    target = await fixture("sqlite");
  try {
    const data = await populated(source),
      archive = path.join(source.directory, "export");
    await exportArchive(source.store, data.evidence, archive);
    const filename = path.join(archive, "rows.ndjson");
    const rows = await readFile(filename, "utf8");
    await writeFile(filename, rows.replace("synthetic", "tampered"));
    await expect(
      importArchive(
        target.store,
        new EvidenceStore(path.join(target.directory, "evidence")),
        archive,
      ),
    ).rejects.toMatchObject({ code: "archive_checksum_mismatch" });
    expect(
      await target.store.db.selectFrom("projects").selectAll().execute(),
    ).toHaveLength(0);
  } finally {
    await target.cleanup();
    await source.cleanup();
  }
});
