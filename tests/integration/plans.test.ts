import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import {
  AcceptancePlans,
  PlanSelections,
  Changes,
  canonical,
  configSchema,
  bundleSchema,
  openStore,
  Catalog,
} from "@bug-manager/core";
import type { Config, Standard } from "@bug-manager/core";
import { fixture, mutation, standard } from "../helpers.js";
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} frozen acceptance plans`, () => {
    let f: Awaited<ReturnType<typeof fixture>>,
      config: Config,
      plans: AcceptancePlans,
      project_id: string,
      change_id: string,
      t1: string,
      t2: string,
      outside: string,
      ids: string[];
    beforeEach(async () => {
      f = await fixture(backend);
      const root = path.join(f.directory, "history");
      await mkdir(root);
      config = configSchema.parse({
        database: f.database,
        evidence_dir: f.directory,
        history: [{ adapter: "codex", path: root }],
      });
      plans = new AcceptancePlans(f.store, config);
      t1 = (await f.type("并发")).id;
      t2 = (await f.type("数据一致性")).id;
      outside = (await f.type("未选择的界面类型", t1)).id;
      project_id = (
        await f.projects.register(
          {
            name: "Synthetic plan project",
            directory: path.join(f.directory, "project"),
          },
          mutation(),
        )
      ).id;
      await f.projects.setTypes(
        { project_id, type_ids: [t1, t2], expected_revision: 0 },
        mutation("Selected only concurrency and consistency"),
      );
      const result = await f.catalog.apply(
        {
          standards: [
            {
              ref: "i0",
              record: standard([t1, t2], {
                parameters: [
                  {
                    name: "endpoint",
                    type: "string",
                    description: "Testing environment address",
                    required: true,
                  },
                ],
              }),
            },
            ...(["I1", "I2", "I3"] as const).map((importance, i) => ({
              ref: importance,
              record: standard([t1], {
                importance,
                mechanism: `Independent mechanism ${i}`,
              }),
            })),
            { ref: "outside", record: standard([outside]) },
            {
              ref: "candidate",
              record: standard([t1], {
                confidence: {
                  assessment: "uncertain",
                  reason: "Synthetic speculation",
                  evidence: [],
                },
              }),
            },
          ],
        },
        mutation(),
      );
      ids = result.entities.map((e) => e.id);
      change_id = (
        await new Changes(f.store, config).capture(
          {
            project_id,
            mode: "explicit",
            description: "Changed order retry boundary",
            files: [{ path: "orders.ts", change: "Updated retry recovery" }],
          },
          mutation(),
        )
      ).change_id;
    });
    afterEach(async () => {
      await f?.cleanup();
    });
    it("PLN-002/003 includes each in-scope I0 once despite a skip proposal or unresolved parameters", async () => {
      const meta = mutation(),
        input = {
          project_id,
          change_id,
          no_sync: true,
          decisions: [
            {
              standard_id: ids[0],
              standard_revision: 1,
              decision: "skipped",
              reason: "Requested skip cannot remove I0",
            },
            {
              standard_id: ids[1],
              standard_revision: 1,
              decision: "skipped",
              reason: "Unrelated code path",
            },
            {
              standard_id: ids[2],
              standard_revision: 1,
              decision: "selected",
              reason: "Relevant retry change",
            },
          ],
        };
      const plan = await plans.create(input, meta);
      expect(await plans.create(input, meta)).toEqual(plan);
      expect(plan.totals).toEqual({
        eligible: 4,
        included: 3,
        selected: 2,
        skipped: 1,
        unresolved: 1,
      });
      const page = await plans.items({ plan_id: plan.plan_id });
      expect(page.items).toHaveLength(3);
      const required = page.items.find(
        (i) => i.standard_id === ids[0],
      )!.payload;
      expect(required).toMatchObject({
        record: {
          importance: "I0",
          type_ids: expect.arrayContaining([t1, t2]),
        },
        unresolved_parameters: ["endpoint"],
        selection: { included: true, decision: "selected" },
      });
      const snapshot = (await plans.get(plan.plan_id)).snapshot;
      expect(snapshot.selected_type_ids.sort()).toEqual([t1, t2].sort());
      expect(snapshot.history_freshness.synchronization).toMatchObject({
        mode: "no-sync",
        status: "explicitly_skipped",
      });
      const decisions = await plans.decisions({ plan_id: plan.plan_id });
      expect(decisions.items).toHaveLength(4);
      expect(canonical(decisions)).toContain("Unrelated code path");
      expect(canonical(decisions)).toContain("conservatively included");
      expect(canonical(page)).not.toContain(ids[4]);
      expect(canonical(page)).not.toContain(ids[5]);
    });
    it("PLN-005/006 freezes versions, type settings and parameters while later plans use explicit updates", async () => {
      const plan = await plans.create(
          {
            project_id,
            change_id,
            no_sync: true,
            mode: "full",
            parameters: { endpoint: "https://synthetic.invalid" },
          },
          mutation(),
        ),
        snapshot = await plans.get(plan.plan_id),
        items = await plans.items({ plan_id: plan.plan_id });
      expect(plan.totals.included).toBe(4);
      expect(
        items.items.find((i) => i.standard_id === ids[0])!.payload
          .resolved_parameters,
      ).toEqual({ endpoint: "https://synthetic.invalid" });
      const original = (await f.catalog.get("standard", ids[0]!))
        .record as Standard;
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "updated",
              id: ids[0],
              expected_revision: 1,
              record: {
                ...original,
                importance: "I3",
                scenarios: [
                  {
                    ...original.scenarios[0]!,
                    expected_results: ["Changed after the plan"],
                  },
                ],
              },
            },
          ],
        },
        mutation(),
      );
      await f.projects.setTypes(
        { project_id, type_ids: [outside], expected_revision: 1 },
        mutation(),
      );
      expect(await plans.get(plan.plan_id)).toEqual(snapshot);
      expect(await plans.items({ plan_id: plan.plan_id })).toEqual(items);
      const newer = await plans.create(
        { project_id, change_id, no_sync: true, mode: "full" },
        mutation(),
      );
      expect(newer.totals.included).toBe(1);
      expect(
        (await plans.items({ plan_id: newer.plan_id })).items[0]!.standard_id,
      ).toBe(ids[4]);
    });
    it("PLN-004 refines explicit relevance judgements into a new plan without changing the frozen basis", async () => {
      const basis = await plans.create(
          { project_id, change_id, no_sync: true },
          mutation(),
        ),
        before = await plans.get(basis.plan_id),
        selector = new PlanSelections(f.store, config);
      const input = {
          plan_id: basis.plan_id,
          parameters: { endpoint: "https://synthetic.invalid" },
          decisions: [
            {
              standard_id: ids[0],
              standard_revision: 1,
              decision: "skipped",
              reason: "I0 skip proposal",
            },
            {
              standard_id: ids[1],
              standard_revision: 1,
              decision: "skipped",
              reason: "Unrelated module",
            },
          ],
        },
        meta = mutation();
      const refined = await selector.refine(input, meta);
      expect(await selector.refine(input, meta)).toEqual(refined);
      expect(refined).toMatchObject({
        basis_plan_id: basis.plan_id,
        totals: { eligible: 4, included: 3, skipped: 1 },
      });
      expect(await plans.get(basis.plan_id)).toEqual(before);
      expect(
        (await plans.items({ plan_id: refined.plan_id })).items.find(
          (i) => i.standard_id === ids[0],
        )!.payload,
      ).toMatchObject({
        selection: { included: true },
        resolved_parameters: { endpoint: "https://synthetic.invalid" },
        unresolved_parameters: [],
      });
      await expect(
        selector.refine(
          {
            ...input,
            decisions: [
              {
                standard_id: ids[4],
                standard_revision: 1,
                decision: "selected",
                reason: "Cannot widen scope",
              },
            ],
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "selection_out_of_scope" });
    });
    it("PLN-002/006 rejects stale/out-of-scope decisions, wrong parameter types and empty project type configuration atomically", async () => {
      for (const addition of [
        {
          decisions: [
            {
              standard_id: ids[4],
              standard_revision: 1,
              decision: "selected",
              reason: "Outside selected scope",
            },
          ],
        },
        {
          decisions: [
            {
              standard_id: ids[1],
              standard_revision: 2,
              decision: "selected",
              reason: "Wrong frozen revision",
            },
          ],
        },
        { parameters: { endpoint: 42 } },
        { expected_project_revision: 0 },
      ])
        await expect(
          plans.create(
            { project_id, change_id, no_sync: true, ...addition },
            mutation(),
          ),
        ).rejects.toHaveProperty("code");
      expect(
        await f.store.db.selectFrom("acceptance_plans").select("id").execute(),
      ).toHaveLength(0);
      const other = (
        await f.projects.register(
          { name: "Unconfigured", directory: path.join(f.directory, "other") },
          mutation(),
        )
      ).id;
      await expect(
        plans.create(
          { project_id: other, change_id, no_sync: true },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "type_configuration_required" });
    });
    it("HIS-007/PLN-002 shows collected but unanalyzed history and budget-limited lazy sync without requiring a Key", async () => {
      await writeFile(
        path.join(config.history[0]!.path, "synthetic.jsonl"),
        [
          { type: "session_meta", payload: { id: "synthetic-plan-source" } },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Concrete synthetic development knowledge",
            },
          },
        ]
          .map(canonical)
          .join("\n") + "\n",
      );
      const plan = await plans.create(
        { project_id, change_id, analysis: "builtin", sync_budget_ms: 3000 },
        mutation(),
      );
      expect(
        (await plans.get(plan.plan_id)).snapshot.history_freshness,
      ).toMatchObject({
        complete: false,
        pending_segments: 1,
        fresh_through: expect.any(String),
        synchronization: {
          mode: "incremental",
          status: "collected",
          analysis_status: "external_pending_no_model_key",
        },
      });
      const limited = await plans.create(
        { project_id, change_id, sync_budget_ms: 1 },
        mutation(),
      );
      expect(
        (await plans.get(limited.plan_id)).snapshot.history_freshness
          .synchronization,
      ).toMatchObject({ mode: "incremental", status: "partial" });
    });
    it("PLN-006 paginates more than 200 standards inside one consistent database snapshot under concurrent updates", async () => {
      const records = Array.from({ length: 205 }, (_, i) => ({
        ref: `bulk-${i}`,
        record: standard([t1, t2], {
          title: `Bulk standard ${i}`,
          mechanism: `Synthetic mechanism ${i}`,
        }),
      }));
      const created: string[] = [];
      for (let offset = 0; offset < records.length; offset += 200) {
        const result = await f.catalog.apply(
          { standards: records.slice(offset, offset + 200) },
          mutation(),
        );
        created.push(...result.entities.map((e) => e.id));
      }
      const other = await openStore(f.database);
      try {
        const concurrent = other.write(
          mutation(),
          { operation: "synthetic.bulk-update" },
          async (tx) => {
            for (let offset = 0; offset < created.length; offset += 200)
              await new Catalog(other).applyTransaction(
                tx,
                bundleSchema.parse({
                  standards: created
                    .slice(offset, offset + 200)
                    .map((entityId, index) => ({
                      ref: entityId,
                      id: entityId,
                      expected_revision: 1,
                      record: {
                        ...records[offset + index]!.record,
                        title: "Updated concurrently",
                      },
                    })),
                }),
                mutation(),
              );
            return { updated: true };
          },
        );
        const [plan] = await Promise.all([
          plans.create(
            { project_id, change_id, no_sync: true, mode: "full" },
            mutation(),
          ),
          concurrent,
        ]);
        expect(plan.totals.eligible).toBe(209);
        let cursor: string | undefined;
        const seen = new Set<string>(),
          revisions = new Set<number>();
        do {
          const page = await plans.items({
            plan_id: plan.plan_id,
            limit: 50,
            cursor,
          });
          for (const item of page.items) {
            expect(seen.has(item.standard_id)).toBe(false);
            seen.add(item.standard_id);
            if (created.includes(item.standard_id))
              revisions.add(item.standard_revision);
          }
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
        expect(seen.size).toBe(209);
        expect(revisions.size).toBe(1);
      } finally {
        await other.close();
      }
    }, 60000);
  });
