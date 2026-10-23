import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { Jobs, id, migrate } from "@bug-manager/core";
import { bug, fixture, mutation, standard, supported } from "../helpers.js";

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} domain contract`, () => {
    let f: Awaited<ReturnType<typeof fixture>>, t1: string, t2: string;
    beforeEach(async () => {
      f = await fixture(backend);
      t1 = (await f.type("幂等")).id;
      t2 = (await f.type("权限")).id;
    });
    afterEach(async () => {
      await f?.cleanup();
    });
    it("DB-001 initializes a real backend with the same logical schema", async () => {
      expect(await f.store.health()).toMatchObject({
        database: backend,
        schema_version: 6,
      });
      const columns = (await f.store.db.introspection.getTables())
        .find((t) => t.name === "bugs")!
        .columns.map((c) => c.name);
      expect(columns).not.toContain("status");
      expect(columns).not.toContain("fixed");
    });
    it("DB-002 rolls back a failing migration and rejects newer schemas", async () => {
      await expect(
        migrate(f.store.db, backend, {
          "007_failure": {
            async up(tx) {
              await sql`CREATE TABLE should_rollback(id TEXT)`.execute(tx);
              throw new Error("injected migration failure");
            },
          },
        }),
      ).rejects.toMatchObject({ code: "migration_failed" });
      expect(
        (await f.store.db.introspection.getTables()).some(
          (t) => t.name === "should_rollback",
        ),
      ).toBe(false);
      await sql`INSERT INTO kysely_migration(name,timestamp) VALUES('999_future','2026-10-22T00:00:00Z')`.execute(
        f.store.db,
      );
      await expect(f.store.initialize()).rejects.toMatchObject({
        code: "schema_too_new",
      });
    });
    it("PRJ-001 preserves identity across moves and does not infer identity from remote", async () => {
      const p = await f.projects.register(
        {
          name: "one",
          directory: pathFor("first"),
          repository_hint: "same-remote",
        },
        mutation(),
      );
      await f.projects.register(
        { name: "one", directory: pathFor("moved"), project_id: p.id },
        mutation(),
      );
      expect(
        (await f.projects.resolve(pathFor("moved", "subdir"))).status,
      ).toBe("mapped");
      expect(
        (await f.projects.resolve(pathFor("unknown"), "same-remote")).status,
      ).toBe("uncertain");
      const other = await f.projects.register(
        {
          name: "fork",
          directory: pathFor("fork"),
          repository_hint: "same-remote",
        },
        mutation(),
      );
      expect(other.id).not.toBe(p.id);
    });
    it("PRJ-003 requires explicit revisions and active selected types", async () => {
      const p = await f.projects.register(
        { name: "project", directory: pathFor("project") },
        mutation(),
      );
      expect((await f.projects.types(p.id)).type_ids).toEqual([]);
      await f.projects.setTypes(
        { project_id: p.id, type_ids: [t1, t1, t2], expected_revision: 0 },
        mutation(),
      );
      expect((await f.projects.types(p.id)).type_ids).toEqual([t1, t2].sort());
      await expect(
        f.projects.setTypes(
          { project_id: p.id, type_ids: [t1], expected_revision: 0 },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      const pending = await f.taxonomy.propose(
        { name: "pending", definition: "pending type" },
        mutation(),
      );
      await expect(
        f.projects.setTypes(
          { project_id: p.id, type_ids: [pending.id], expected_revision: 1 },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "unknown_type" });
    });
    it("TAX-001 preserves aliases and stable IDs on rename", async () => {
      const row = await f.taxonomy.propose(
        { name: "cache", definition: "Cache failures", aliases: ["缓存"] },
        mutation(),
      );
      await f.taxonomy.resolve(
        {
          type_id: row.id,
          expected_revision: 1,
          decision: "confirm",
          name: "caching",
        },
        mutation(),
      );
      expect(
        (await f.taxonomy.resolveNames(["cache", "缓存", "caching"])).every(
          (t) => t.id === row.id,
        ),
      ).toBe(true);
      await expect(
        f.taxonomy.propose(
          { name: "缓存", definition: "duplicate" },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "type_name_conflict" });
    });
    it("CAT-001 links two Bug records to one independent standard without copying severity", async () => {
      const result = await f.catalog.apply(
        {
          standards: [
            { ref: "s", record: standard([t1], { importance: "I2" }) },
          ],
          bugs: [
            { ref: "b1", record: bug([t1]) },
            { ref: "b2", record: bug([t1, t2], { title: "回调重复发放权益" }) },
          ],
          links: [
            {
              bug_ref: "b1",
              standard_ref: "s",
              coverage_reason: "重复业务操作只一次效果",
            },
            {
              bug_ref: "b2",
              standard_ref: "s",
              coverage_reason: "回调也是重复操作",
            },
          ],
        },
        mutation(),
      );
      expect(result.entities.every((e) => e.disposition === "active")).toBe(
        true,
      );
      expect(
        await f.store.db.selectFrom("standards").selectAll().execute(),
      ).toHaveLength(1);
      expect(
        await f.store.db.selectFrom("bug_standard_links").selectAll().execute(),
      ).toHaveLength(2);
      const s = result.entities.find((e) => e.kind === "standard")!;
      expect((await f.catalog.get("standard", s.id)).record).toMatchObject({
        importance: "I2",
      });
    });
    it("CAT-002 preserves observed faults with unknown causes and rejects repair lifecycle fields", async () => {
      const result = await f.catalog.apply(
        {
          standards: [{ ref: "s", record: standard([t1]) }],
          bugs: [
            {
              ref: "b",
              record: bug([t1], {
                mechanism: "Unknown; no causal diagnosis confirmed",
                mechanism_confirmed: false,
                confidence: {
                  ...supported,
                  evidence: [
                    {
                      kind: "observation",
                      excerpt:
                        "Duplicate effects observed; history later says repaired but gives no confirmed cause",
                    },
                  ],
                },
              }),
            },
          ],
          links: [
            {
              bug_ref: "b",
              standard_ref: "s",
              coverage_reason: "Count repeated effects regardless of cause",
            },
          ],
        },
        mutation(),
      );
      const saved = result.entities.find((entity) => entity.kind === "bug")!;
      const original = await f.catalog.get("bug", saved.id);
      expect(original).toMatchObject({
        disposition: "active",
        record: {
          mechanism_confirmed: false,
          mechanism: "Unknown; no causal diagnosis confirmed",
        },
      });
      expect(original.record).not.toHaveProperty("status");
      await expect(
        f.catalog.apply(
          {
            bugs: [
              {
                ref: "b",
                id: saved.id,
                expected_revision: saved.revision,
                record: { ...original.record, status: "fixed" },
              },
            ],
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ name: "ZodError" });
      expect(await f.catalog.get("bug", saved.id)).toEqual(original);
    });
    it("TAX-003 filters ANY/ALL, deduplicates pagination and does not expand children", async () => {
      const child = (await f.type("子类", t1)).id;
      await f.catalog.apply(
        {
          standards: [
            { ref: "both", record: standard([t1, t2]) },
            { ref: "one", record: standard([t1]) },
            { ref: "child", record: standard([child]) },
          ],
        },
        mutation(),
      );
      const any = await f.catalog.search("standard", { type_ids: [t1, t2] });
      expect(any.items).toHaveLength(2);
      expect(
        (
          await f.catalog.search("standard", {
            type_ids: [t1, t2],
            type_match: "all",
          })
        ).items,
      ).toHaveLength(1);
      const first = await f.catalog.search("standard", {
        type_ids: [t1],
        limit: 1,
      });
      const second = await f.catalog.search("standard", {
        type_ids: [t1],
        limit: 1,
        cursor: first.next_cursor,
      });
      expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
      await expect(
        f.catalog.search("standard", {
          type_ids: [t2],
          cursor: first.next_cursor,
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    });
    it("TAX-004 rejects unbounded knowledge requests and searches Chinese/English tokens", async () => {
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "s",
              record: standard([t1], { title: "重复提交 identity 操作" }),
            },
          ],
        },
        mutation(),
      );
      await expect(f.catalog.search("standard", {})).rejects.toMatchObject({
        code: "type_scope_required",
      });
      expect(
        (
          await f.catalog.search("standard", {
            type_ids: [t1],
            query: "重复提交",
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (
          await f.catalog.search("standard", {
            type_ids: [t1],
            query: "IDENTITY",
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (
          await f.catalog.search("standard", {
            type_ids: [t2],
            query: "identity",
          })
        ).items,
      ).toHaveLength(0);
    });
    it("DED-007 retrieves Chinese paraphrases and mixed text within an explicit type scope", async () => {
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "s",
              record: standard([t1, t2], {
                mechanism: "并发请求重试缺少幂等 protection",
                title: "重复业务操作应只产生一次 effect",
              }),
            },
          ],
        },
        mutation(),
      );
      const query = "反复提交时防止重复操作和并发重试 protection";
      expect(
        (await f.catalog.search("standard", { type_ids: [t1, t2], query }))
          .items,
      ).toHaveLength(1);
      const other = (await f.type("无关排版")).id;
      expect(
        (await f.catalog.search("standard", { type_ids: [other], query }))
          .items,
      ).toHaveLength(0);
    });
    it("CAT-006 preserves immutable revisions and rejects lost updates", async () => {
      const result = await f.catalog.apply(
          { standards: [{ ref: "s", record: standard([t1]) }] },
          mutation(),
        ),
        s = result.entities[0]!;
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "s",
              id: s.id,
              expected_revision: 1,
              record: standard([t1], { title: "修改后的标准" }),
            },
          ],
        },
        mutation(),
      );
      expect((await f.catalog.get("standard", s.id, 1)).record.title).toBe(
        "重复提交只能产生一次效果",
      );
      expect((await f.catalog.get("standard", s.id)).revision).toBe(2);
      await expect(
        f.catalog.apply(
          {
            standards: [
              {
                ref: "s",
                id: s.id,
                expected_revision: 1,
                record: standard([t1]),
              },
            ],
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "revision_conflict" });
    });
    it("CAT-007 rolls back entity writes when a coverage reference is invalid", async () => {
      await expect(
        f.catalog.apply(
          {
            standards: [{ ref: "new", record: standard([t1]) }],
            links: [
              {
                bug_ref: id(),
                standard_ref: "new",
                coverage_reason: "invalid target",
              },
            ],
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        (await f.catalog.search("standard", { type_ids: [t1] })).items,
      ).toHaveLength(0);
    });
    it("DED-001 makes request retries idempotent and rejects key reuse for a different payload", async () => {
      const input = { standards: [{ ref: "s", record: standard([t1]) }] },
        meta = mutation();
      const a = await f.catalog.apply(input, meta),
        b = await f.catalog.apply(input, meta);
      expect(a).toEqual(b);
      await expect(
        f.catalog.apply({ standards: [] }, meta),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    });
    it("ANA-003 routes speculation and missing coverage to candidates and supports evidence confirmation", async () => {
      const result = await f.catalog.apply(
          {
            standards: [
              {
                ref: "s",
                record: standard([t1], {
                  confidence: {
                    assessment: "uncertain",
                    reason: "Only suspected",
                    evidence: [
                      { kind: "speculation", excerpt: "Maybe duplicated" },
                    ],
                  },
                }),
              },
            ],
          },
          mutation(),
        ),
        s = result.entities[0]!;
      expect(s.disposition).toBe("candidate");
      await f.catalog.resolveCandidate(
        {
          candidate_id: s.candidate_id,
          expected_revision: 1,
          decision: "confirm",
          confidence: supported,
        },
        mutation(),
      );
      expect((await f.catalog.get("standard", s.id)).disposition).toBe(
        "active",
      );
      const lone = await f.catalog.apply(
        { bugs: [{ ref: "b", record: bug([t1]) }] },
        mutation(),
      );
      expect(lone.entities[0]!.disposition).toBe("candidate");
    });
    it("CAT-003 retains independent project contexts for shared knowledge", async () => {
      const p1 = await f.projects.register(
          { name: "p1", directory: pathFor("p1") },
          mutation(),
        ),
        p2 = await f.projects.register(
          { name: "p2", directory: pathFor("p2") },
          mutation(),
        );
      await f.catalog.apply(
        {
          standards: [{ ref: "s", record: standard([t1]) }],
          bugs: [{ ref: "b", record: bug([t1]) }],
          links: [
            {
              bug_ref: "b",
              standard_ref: "s",
              coverage_reason: "detects duplicates",
            },
          ],
          contexts: [
            { bug_ref: "b", project_id: p1.id, description: "订单重试" },
            { bug_ref: "b", project_id: p2.id, description: "权益回调" },
          ],
        },
        mutation(),
      );
      expect(
        (await f.store.db.selectFrom("bug_contexts").selectAll().execute())
          .map((c) => c.project_id)
          .sort(),
      ).toEqual([p1.id, p2.id].sort());
    });
    it("HIS-005 fences expired owners and recovers job leases", async () => {
      const jobs = new Jobs(f.store);
      await jobs.enqueue(
        { kind: "test", payload: { synthetic: true } },
        mutation(),
      );
      const a = await jobs.claim(
        { kind: "test", lease_ms: 10_000 },
        mutation(),
      );
      expect(a).not.toBeNull();
      expect(await jobs.claim({ kind: "test" }, mutation())).toBeNull();
      await f.store.db
        .updateTable("jobs")
        .set({ lease_until: Date.now() - 1 })
        .where("id", "=", a!.id)
        .execute();
      const b = await jobs.claim({ kind: "test" }, mutation());
      expect(b!.owner_token).not.toBe(a!.owner_token);
      await expect(
        jobs.complete(
          { job_id: a!.id, owner_token: a!.owner_token, result: {} },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "lease_lost" });
      await jobs.complete(
        { job_id: b!.id, owner_token: b!.owner_token, result: { done: true } },
        mutation(),
      );
      expect((await jobs.get(b!.id)).status).toBe("completed");
    });
    it("TAX-004 detects changes between cursor pages rather than silently skipping reclassified items", async () => {
      await f.catalog.apply(
        {
          standards: [
            { ref: "a", record: standard([t1]) },
            { ref: "b", record: standard([t1]) },
          ],
        },
        mutation(),
      );
      const first = await f.catalog.search("standard", {
        type_ids: [t1],
        limit: 1,
      });
      await f.catalog.apply(
        { standards: [{ ref: "c", record: standard([t1]) }] },
        mutation(),
      );
      await expect(
        f.catalog.search("standard", {
          type_ids: [t1],
          limit: 1,
          cursor: first.next_cursor,
        }),
      ).rejects.toMatchObject({ code: "cursor_stale" });
    });
    it("CAT-004 rejects a standard without executable steps and leaves the transaction unchanged", async () => {
      const record = standard([t1]);
      record.scenarios[0]!.steps = [];
      await expect(
        f.catalog.apply({ standards: [{ ref: "s", record }] }, mutation()),
      ).rejects.toThrow();
      expect(
        (await f.catalog.search("standard", { type_ids: [t1] })).items,
      ).toHaveLength(0);
    });
    it("ANA-003 rejects candidates without deleting active knowledge or losing the rejection revision", async () => {
      const initial = await f.catalog.apply(
          { standards: [{ ref: "s", record: standard([t1]) }] },
          mutation(),
        ),
        s = initial.entities[0]!;
      const uncertain = {
        assessment: "uncertain",
        reason: "unproven edit",
        evidence: [],
      };
      const proposal = await f.catalog.apply(
        {
          standards: [
            {
              ref: "s",
              id: s.id,
              expected_revision: 1,
              record: standard([t1], {
                confidence: uncertain as typeof supported,
              }),
            },
          ],
        },
        mutation(),
      );
      const candidate = proposal.entities[0]!;
      expect(candidate.change_applied).toBe(false);
      await f.catalog.resolveCandidate(
        {
          candidate_id: candidate.candidate_id,
          expected_revision: 1,
          decision: "reject",
        },
        mutation(),
      );
      expect((await f.catalog.get("standard", s.id)).disposition).toBe(
        "active",
      );
      const created = await f.catalog.apply(
          {
            standards: [
              {
                ref: "new",
                record: standard([t1], {
                  confidence: uncertain as typeof supported,
                }),
              },
            ],
          },
          mutation(),
        ),
        pending = created.entities[0]!;
      await f.catalog.resolveCandidate(
        {
          candidate_id: pending.candidate_id,
          expected_revision: 1,
          decision: "reject",
        },
        mutation(),
      );
      expect((await f.catalog.get("standard", pending.id)).disposition).toBe(
        "rejected",
      );
      expect((await f.catalog.get("standard", pending.id, 1)).disposition).toBe(
        "candidate",
      );
    });
    it("CAT-001 supports several standards covering a single Bug and keeps tags separate", async () => {
      const result = await f.catalog.apply(
        {
          standards: [
            { ref: "one", record: standard([t1], { tags: ["回归"] }) },
            { ref: "two", record: standard([t2], { title: "权限复核" }) },
          ],
          bugs: [{ ref: "bug", record: bug([t1, t2]) }],
          links: [
            {
              bug_ref: "bug",
              standard_ref: "one",
              coverage_reason: "并发检查",
            },
            {
              bug_ref: "bug",
              standard_ref: "two",
              coverage_reason: "权限检查",
            },
          ],
        },
        mutation(),
      );
      const bugId = result.entities.find((e) => e.kind === "bug")!.id;
      expect(
        await f.store.db
          .selectFrom("bug_standard_links")
          .selectAll()
          .where("bug_id", "=", bugId)
          .execute(),
      ).toHaveLength(2);
      expect(
        await f.store.db.selectFrom("tags").selectAll().execute(),
      ).toHaveLength(1);
      await expect(
        f.catalog.search("standard", { type_ids: ["回归"] }),
      ).rejects.toThrow();
    });
    function pathFor(...parts: string[]) {
      return `${f.directory}/${parts.join("/")}`;
    }
  });
}
