import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeMerges, canonical, id } from "@bug-manager/core";
import { fixture, mutation, standard, bug, supported } from "../helpers.js";

for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} conservative knowledge merges`, () => {
    let f: Awaited<ReturnType<typeof fixture>>,
      merges: KnowledgeMerges,
      t1: string,
      t2: string;
    beforeEach(async () => {
      f = await fixture(backend);
      merges = new KnowledgeMerges(f.store);
      t1 = (await f.type("幂等")).id;
      t2 = (await f.type("并发")).id;
    });
    afterEach(async () => {
      await f?.cleanup();
    });
    const compatibility = {
      mechanism: true,
      preconditions: true,
      expected_results: true,
      reason:
        "Same mechanism and observable expectation, distinct source contexts retained",
      confidence: supported,
    };
    async function source(segment_id: string) {
      const root = id(),
        session = id();
      await f.store.db
        .insertInto("source_roots")
        .values({
          id: root,
          adapter: "codex",
          path: `/synthetic/${root}`,
          exclusions: "[]",
          created_at: new Date().toISOString(),
        })
        .execute();
      await f.store.db
        .insertInto("source_sessions")
        .values({
          id: session,
          root_id: root,
          external_id: session,
          generation: id(),
          source_path: "/synthetic/missing.jsonl",
          metadata: "{}",
          coverage: "collected",
          created_at: new Date().toISOString(),
        })
        .execute();
      await f.store.db
        .insertInto("source_segments")
        .values({
          id: segment_id,
          session_id: session,
          logical_key: segment_id,
          content_hash: "synthetic",
          excerpt: "Repeated request produced two business effects",
          context: "{}",
          analysis_version: "1",
          privacy_version: "1",
          created_at: new Date().toISOString(),
        })
        .execute();
    }
    async function seed() {
      const p = await f.projects.register(
          { name: "first", directory: "/synthetic/first" },
          mutation(),
        ),
        q = await f.projects.register(
          { name: "second", directory: "/synthetic/second" },
          mutation(),
        );
      const segments = [id(), id()];
      for (const segment of segments) await source(segment);
      const first = await f.catalog.apply(
        {
          standards: [{ ref: "s", record: standard([t1]) }],
          bugs: [{ ref: "b", record: bug([t1]) }],
          links: [
            {
              bug_ref: "b",
              standard_ref: "s",
              coverage_reason: "First project prevention",
            },
          ],
          contexts: [
            { bug_ref: "b", project_id: p.id, description: "First context" },
          ],
          source_segment_id: segments[0],
        },
        mutation(),
      );
      const second = await f.catalog.apply(
        {
          standards: [{ ref: "s", record: standard([t2]) }],
          bugs: [{ ref: "b", record: bug([t2]) }],
          links: [
            {
              bug_ref: "b",
              standard_ref: "s",
              coverage_reason: "Second project prevention",
            },
          ],
          contexts: [
            { bug_ref: "b", project_id: q.id, description: "Second context" },
          ],
          source_segment_id: segments[1],
        },
        mutation(),
      );
      return {
        s1: first.entities.find((e) => e.kind === "standard")!.id,
        s2: second.entities.find((e) => e.kind === "standard")!.id,
        b1: first.entities.find((e) => e.kind === "bug")!.id,
        b2: second.entities.find((e) => e.kind === "bug")!.id,
        segments,
      };
    }
    it("DED-005 preserves independent types, sources, coverage, redirects and frozen old revisions", async () => {
      const { s1, s2, b1, b2, segments } = await seed(),
        meta = mutation();
      const input = {
        kind: "standard",
        source_id: s2,
        target_id: s1,
        expected_source_revision: 1,
        expected_target_revision: 1,
        compatibility,
      };
      const old = await f.catalog.get("standard", s2, 1);
      const result = await merges.merge(input, meta);
      expect(result).toMatchObject({ status: "merged", target_revision: 2 });
      expect(await merges.merge(input, meta)).toEqual(result);
      expect(await f.catalog.get("standard", s2)).toMatchObject({
        id: s1,
        requested_id: s2,
        revision: 2,
        record: { type_ids: expect.arrayContaining([t1, t2]) },
      });
      expect(await f.catalog.get("standard", s2, 1)).toEqual(old);
      const edges = await f.catalog.coverage({ kind: "standard", id: s1 });
      expect(edges.items.map((e) => e.bug_id).sort()).toEqual([b1, b2].sort());
      expect(
        (await f.catalog.provenance({ kind: "standard", id: s1 })).items
          .map((e) => e.segment_id)
          .sort(),
      ).toEqual(segments.sort());
      expect(
        (await f.catalog.search("standard", { type_ids: [t2] })).items,
      ).toHaveLength(1);
      await expect(
        merges.merge({ ...input, expected_target_revision: 2 }, mutation()),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect((await f.catalog.history("standard", s2)).items).toHaveLength(2);
    });
    it("DED-005 merging Bugs retains both project occurrences and independent covering standards", async () => {
      const { b1, b2, s1, s2 } = await seed();
      await merges.merge(
        {
          kind: "bug",
          source_id: b2,
          target_id: b1,
          expected_source_revision: 1,
          expected_target_revision: 1,
          compatibility,
        },
        mutation(),
      );
      const contexts = await f.store.db
        .selectFrom("bug_contexts")
        .selectAll()
        .where("bug_id", "=", b1)
        .execute();
      expect(contexts).toHaveLength(2);
      expect(new Set(contexts.map((c) => c.project_id)).size).toBe(2);
      expect(
        (await f.catalog.coverage({ kind: "bug", id: b1 })).items
          .map((e) => e.standard_id)
          .sort(),
      ).toEqual([s1, s2].sort());
      expect(
        (await f.catalog.provenance({ kind: "bug", id: b1 })).items,
      ).toHaveLength(2);
      expect((await f.catalog.get("bug", b2)).id).toBe(b1);
      expect((await f.catalog.get("bug", b2, 1)).record.type_ids).toEqual([t2]);
    });
    it("DED-005 keeps rating/expectation conflicts pending; corrected knowledge can explicitly confirm the candidate", async () => {
      const first = await f.catalog.apply(
        {
          standards: [
            { ref: "a", record: standard([t1]) },
            { ref: "b", record: standard([t2], { importance: "I3" }) },
          ],
        },
        mutation(),
      );
      const [a, b] = first.entities;
      const input = {
        kind: "standard",
        source_id: b!.id,
        target_id: a!.id,
        expected_source_revision: 1,
        expected_target_revision: 1,
        compatibility,
      };
      const pending = await merges.merge(input, mutation());
      expect(pending.status).toBe("candidate");
      expect(
        await f.store.db.selectFrom("entity_redirects").selectAll().execute(),
      ).toHaveLength(0);
      const candidate = await f.catalog.candidateGet(pending.candidate_id!);
      expect(candidate.reason).toContain("Ratings differ");
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "corrected",
              id: b!.id,
              expected_revision: 1,
              record: standard([t2]),
            },
          ],
        },
        mutation("Evidence corrects underestimated importance"),
      );
      expect(
        await merges.merge(
          { ...input, expected_source_revision: 2, candidate_id: candidate.id },
          mutation(),
        ),
      ).toMatchObject({ status: "merged" });
      expect((await f.catalog.candidateGet(candidate.id)).disposition).toBe(
        "confirmed",
      );
      const opposite = standard([t1]);
      opposite.scenarios[0]!.expected_results = [
        "Two business effects are required",
      ];
      const other = await f.catalog.apply(
        { standards: [{ ref: "other", record: opposite }] },
        mutation(),
      );
      const conflict = await merges.merge(
        {
          ...input,
          source_id: other.entities[0]!.id,
          expected_source_revision: 1,
          expected_target_revision: 2,
        },
        mutation(),
      );
      expect(conflict).toMatchObject({
        status: "candidate",
        conflicts: expect.arrayContaining([
          "Scenario definitions differ: repeat",
        ]),
      });
      expect((await f.catalog.get("standard", a!.id)).record).not.toMatchObject(
        { scenarios: opposite.scenarios },
      );
    });
    it("CAT-006 rejects lost coverage updates and retains every accepted relationship revision", async () => {
      const { b1, s1 } = await seed();
      const update = {
        bug_ref: b1,
        standard_ref: s1,
        coverage_reason: "Additional boundary coverage",
        scenario_ids: ["repeat"],
      };
      await expect(
        f.catalog.apply({ links: [update] }, mutation()),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      await f.catalog.apply(
        { links: [{ ...update, expected_revision: 1 }] },
        mutation(),
      );
      await expect(
        f.catalog.apply(
          {
            links: [
              {
                ...update,
                coverage_reason: "stale edit",
                expected_revision: 1,
              },
            ],
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      const old = await f.catalog.coverage({
        kind: "bug",
        id: b1,
        history: true,
        limit: 1,
      });
      expect(old.items[0]!.revision).toBe(1);
      const next = await f.catalog.coverage({
        kind: "bug",
        id: b1,
        history: true,
        limit: 1,
        cursor: old.next_cursor!,
      });
      expect(next.items[0]!.revision).toBe(2);
      expect(canonical(next)).toContain("Additional boundary coverage");
      // An old Bug may gain a separate standard without duplicating the Bug.
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "boundary",
              record: standard([t1], {
                mechanism: "Retry after timeout needs recovery",
              }),
            },
          ],
          links: [
            {
              bug_ref: b1,
              standard_ref: "boundary",
              coverage_reason: "Additional recovery variant",
            },
          ],
        },
        mutation(),
      );
      expect(
        (await f.catalog.coverage({ kind: "bug", id: b1 })).items,
      ).toHaveLength(2);
      expect((await f.catalog.get("bug", b1)).revision).toBe(1);
    });
  });
