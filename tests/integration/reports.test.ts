import { mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcceptancePlans,
  AcceptanceResults,
  AcceptanceReports,
  Changes,
  KnowledgeMerges,
  canonical,
  configSchema,
  id,
} from "@bug-manager/core";
import type { Config, PlanItem, Standard } from "@bug-manager/core";
import { fixture, mutation, standard, supported } from "../helpers.js";
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} executor declarations and human reports`, () => {
    let f: Awaited<ReturnType<typeof fixture>>,
      config: Config,
      plans: AcceptancePlans,
      results: AcceptanceResults,
      reports: AcceptanceReports,
      plan_id: string,
      project_id: string,
      change_id: string,
      change_hash: string,
      execution_id: string,
      items: Array<{ id: string; payload: PlanItem; standard_id: string }>,
      typeId: string;
    beforeEach(async () => {
      f = await fixture(backend);
      config = configSchema.parse({
        database: f.database,
        evidence_dir: path.join(f.directory, "evidence"),
        privacy: { patterns: ["SYNTHETIC_SECRET_[A-Z]+"] },
      });
      plans = new AcceptancePlans(f.store, config);
      results = new AcceptanceResults(f.store, config);
      reports = new AcceptanceReports(f.store, config);
      execution_id = id();
      typeId = (await f.type("幂等")).id;
      project_id = (
        await f.projects.register(
          {
            name: "Synthetic report project",
            directory: path.join(f.directory, "project"),
          },
          mutation(),
        )
      ).id;
      await f.projects.setTypes(
        { project_id, type_ids: [typeId], expected_revision: 0 },
        mutation(),
      );
      const required = standard([typeId], {
        title:
          "<script>alert('synthetic')</script> [untrusted](https://example.invalid)",
      });
      required.scenarios.push({
        ...required.scenarios[0]!,
        scenario_id: "recovery",
        title: "Recovery after interruption",
      });
      const saved = await f.catalog.apply(
        {
          standards: [
            { ref: "required", record: required },
            {
              ref: "optional",
              record: standard([typeId], {
                importance: "I2",
                title: "Second in-scope standard",
              }),
            },
            {
              ref: "skipped",
              record: standard([typeId], {
                importance: "I3",
                title: "Unrelated typography",
              }),
            },
          ],
        },
        mutation(),
      );
      const change = await new Changes(f.store, config).capture(
        { project_id, mode: "explicit", description: "Synthetic retry change" },
        mutation(),
      );
      change_id = change.change_id;
      change_hash = change.content_hash;
      plan_id = (
        await plans.create(
          {
            project_id,
            change_id,
            no_sync: true,
            decisions: [
              {
                standard_id: saved.entities[2]!.id,
                standard_revision: 1,
                decision: "skipped",
                reason: "Typography is unrelated to retry",
              },
            ],
          },
          mutation(),
        )
      ).plan_id;
      items = (await plans.items({ plan_id })).items;
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await f?.cleanup();
    });
    const scenario = (
      scenario_id = "repeat",
      outcome: "passed" | "failed" | "not_applicable" = "passed",
    ) => ({
      scenario_id,
      outcome,
      ...(outcome !== "passed"
        ? { reason: "Synthetic executor declaration" }
        : {}),
      observations: [
        {
          step_index: 0,
          expected: "One effect",
          actual:
            outcome === "failed" ? "Two effects" : "Executor claims one effect",
        },
      ],
      evidence: [
        {
          requirement_key: "effects",
          kind: "log",
          purpose: "Synthetic key evidence, human interpretation required",
          collected_at: new Date().toISOString(),
          media_type: "text/plain",
          step_indexes: [0],
          source: {
            storage: "inline",
            text: "This fixture intentionally does not prove the claimed conclusion. SYNTHETIC_SECRET_ABC",
          },
        },
      ],
    });
    const required = () =>
      items.find((i) => i.payload.record.importance === "I0")!;
    function submission(
      scenarios: unknown[],
      overrides: Record<string, unknown> = {},
    ) {
      const item = required();
      return {
        plan_id,
        plan_item_id: item.id,
        standard_id: item.standard_id,
        standard_revision: 1,
        execution_id,
        attempt_id: id(),
        change_id,
        environment: {
          project_version: "synthetic-v1",
          change_content_hash: change_hash,
          platform: "synthetic-platform",
        },
        scenarios,
        ...overrides,
      };
    }
    it("RPT-001/002 rejects missing evidence, wrong frozen ownership and malformed observations without replacing valid attempts", async () => {
      const missing = scenario();
      missing.evidence = [];
      await expect(
        results.submit(submission([missing]), mutation()),
      ).rejects.toMatchObject({ code: "missing_evidence" });
      await expect(
        results.submit(
          submission([scenario()], { standard_revision: 2 }),
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(
        results.submit(
          submission([scenario()], { plan_item_id: id() }),
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "plan_item_mismatch" });
      await expect(
        results.submit(
          submission([{ scenario_id: "repeat", outcome: "not_applicable" }]),
          mutation(),
        ),
      ).rejects.toHaveProperty("name", "ZodError");
      const invalid = {
        ...scenario(),
        observations: [
          { step_index: 99, expected: "Invalid", actual: "Invalid" },
        ],
      };
      await expect(
        results.submit(submission([invalid]), mutation()),
      ).rejects.toMatchObject({ code: "unknown_step" });
      expect(
        await f.store.db
          .selectFrom("acceptance_results")
          .select("id")
          .execute(),
      ).toHaveLength(0);
      const traversal = {
        ...scenario(),
        evidence: [
          {
            ...scenario().evidence[0]!,
            source: { storage: "inbox", path: "../private.log" },
          },
        ],
      };
      await expect(
        results.submit(submission([traversal]), mutation()),
      ).rejects.toMatchObject({ code: "unsafe_evidence_path" });
    });
    it("RPT-003 appends attempts, preserves logical retries and binds one execution to one project version", async () => {
      const input = submission([scenario()]),
        meta = mutation(),
        first = await results.submit(input, meta);
      expect(first.outcome).toBe("not_run");
      expect(await results.submit(input, meta)).toEqual(first);
      expect(await results.submit(input, mutation())).toEqual(first);
      await expect(
        results.submit(
          { ...input, scenarios: [scenario("repeat", "failed")] },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "attempt_conflict" });
      const second = await results.submit(
        submission([scenario(), scenario("recovery", "failed")]),
        mutation(),
      );
      expect(second.outcome).toBe("failed");
      const wrong = submission([scenario()], {
        environment: {
          project_version: "synthetic-v2",
          change_content_hash: change_hash,
          platform: "another-platform",
        },
      });
      await expect(results.submit(wrong, mutation())).rejects.toMatchObject({
        code: "execution_context_mismatch",
      });
      expect(
        (await results.attempts({ plan_item_id: required().id })).items,
      ).toHaveLength(2);
      expect(
        (await results.submit({ ...wrong, execution_id: id() }, mutation()))
          .outcome,
      ).toBe("not_run");
    });
    it("RPT-006 preserves all-inapplicable declarations and applies failure/blocking precedence without counting them as passes", async () => {
      for (const [outcomes, expected] of [
        [["not_applicable", "not_applicable"], "not_applicable"],
        [["passed", "not_applicable"], "passed"],
        [["blocked", "not_run"], "blocked"],
        [["failed", "blocked"], "failed"],
      ] as const) {
        const input = submission(
          outcomes.map((outcome, index) => ({
            scenario_id: index === 0 ? "repeat" : "recovery",
            outcome,
            reason: "Explicit synthetic executor declaration",
            ...(outcome === "passed"
              ? {
                  observations: scenario().observations,
                  evidence: scenario().evidence,
                }
              : {}),
          })),
          { execution_id: id() },
        );
        const result = await results.submit(input, mutation());
        expect(result.outcome).toBe(expected);
        const report = await reports.create(
          { plan_id, execution_id: input.execution_id },
          mutation(),
        );
        expect(report.summary[expected]).toBe(1);
        expect(report.summary.passed).toBe(expected === "passed" ? 1 : 0);
        const reported = (
          await reports.items({ report_id: report.report_id })
        ).items.find((item) => item.result_id === result.result_id)!;
        expect(reported.attempt!.scenarios.map((item) => item.outcome)).toEqual(
          outcomes,
        );
      }
    });
    it("DB-006 keeps rejected disk-full evidence writes out of result transactions and recovers on retry", async () => {
      const { EvidenceStore } = await import("@bug-manager/core");
      const disk = vi
        .spyOn(EvidenceStore.prototype, "putManaged")
        .mockRejectedValueOnce(
          Object.assign(new Error("Synthetic disk full"), { code: "ENOSPC" }),
        );
      const input = submission([scenario(), scenario("recovery")]),
        meta = mutation();
      await expect(results.submit(input, meta)).rejects.toHaveProperty(
        "code",
        "ENOSPC",
      );
      expect(
        await f.store.db
          .selectFrom("acceptance_results")
          .select("id")
          .execute(),
      ).toHaveLength(0);
      expect(
        await f.store.db.selectFrom("evidence").select("id").execute(),
      ).toHaveLength(0);
      disk.mockRestore();
      expect((await results.submit(input, meta)).outcome).toBe("passed");
    });
    it("RPT-003/005 freezes explicit/latest valid result sets and retains old report definitions after a knowledge merge", async () => {
      const first = await results.submit(
          submission([scenario(), scenario("recovery", "failed")]),
          mutation(),
        ),
        report = await reports.create({ plan_id, execution_id }, mutation());
      expect(report.summary).toMatchObject({
        planned: 2,
        failed: 1,
        not_run: 1,
      });
      const before = await reports.items({ report_id: report.report_id });
      await results.submit(
        submission([scenario(), scenario("recovery")]),
        mutation(),
      );
      expect(await reports.items({ report_id: report.report_id })).toEqual(
        before,
      );
      expect(
        (await reports.create({ plan_id, execution_id }, mutation())).summary,
      ).toMatchObject({ passed: 1, not_run: 1 });
      expect(
        (
          await reports.create(
            { plan_id, execution_id, result_ids: [first.result_id] },
            mutation(),
          )
        ).summary.failed,
      ).toBe(1);
      await expect(
        reports.create(
          { plan_id, execution_id, result_ids: [id()] },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "result_selection_mismatch" });
      const old = (await f.catalog.get("standard", required().standard_id))
        .record as Standard;
      const target = (
        await f.catalog.apply(
          {
            standards: [
              {
                ref: "equivalent",
                record: { ...old, title: "Equivalent canonical standard" },
              },
            ],
          },
          mutation(),
        )
      ).entities[0]!;
      await new KnowledgeMerges(f.store).merge(
        {
          kind: "standard",
          source_id: required().standard_id,
          target_id: target.id,
          expected_source_revision: 1,
          expected_target_revision: 1,
          compatibility: {
            mechanism: true,
            preconditions: true,
            expected_results: true,
            reason: "Equivalent frozen mechanism and scenarios",
            confidence: supported,
          },
        },
        mutation(),
      );
      expect((await f.catalog.get("standard", required().standard_id)).id).toBe(
        target.id,
      );
      expect(await reports.items({ report_id: report.report_id })).toEqual(
        before,
      );
    });
    it("RPT-002/004/007 keeps semantically dubious declarations for human review and exports the same Markdown/JSON snapshot", async () => {
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Reports must not call a model or URL"));
      const declared = await results.submit(
        submission([scenario(), scenario("recovery")]),
        mutation(),
      );
      expect(declared.outcome).toBe("passed");
      const report = await reports.create(
          { plan_id, execution_id },
          mutation(),
        ),
        destination = path.join(f.directory, "report-export");
      const exported = await reports.export({
        report_id: report.report_id,
        directory: destination,
      });
      const json = JSON.parse(await readFile(exported.json, "utf8")),
        markdown = await readFile(exported.markdown, "utf8"),
        manifest = JSON.parse(await readFile(exported.manifest, "utf8"));
      expect(json.summary).toEqual(report.summary);
      expect(json.items).toHaveLength(2);
      expect(json.omitted_decisions).toHaveLength(1);
      expect(json.review).toEqual({
        mode: "human",
        automatic_semantic_review: false,
      });
      expect(markdown).toContain("&lt;script&gt;");
      expect(markdown).not.toContain("<script>");
      expect(markdown).toContain("not\\_run");
      expect(markdown).toContain("Typography is unrelated");
      expect(manifest.evidence).toHaveLength(2);
      const object = manifest.evidence[0];
      const contents = await readFile(
        path.join(destination, "evidence", ...object.object_key.split("/")),
        "utf8",
      );
      expect(contents).not.toContain("SYNTHETIC_SECRET_ABC");
      expect(contents).toContain("does not prove");
      expect(canonical(json)).not.toContain("release_allowed");
      expect(canonical(json)).not.toContain("review_score");
      expect(network).not.toHaveBeenCalled();
      await expect(
        reports.export({ report_id: report.report_id, directory: destination }),
      ).rejects.toHaveProperty("code", "EEXIST");
      expect(JSON.parse(await readFile(exported.json, "utf8")).summary).toEqual(
        report.summary,
      );
    });
    it("RPT-004 separates submission availability from missing export objects and never fetches external references", async () => {
      await mkdir(path.join(config.evidence_dir, "inbox"), { recursive: true });
      await writeFile(
        path.join(config.evidence_dir, "inbox", "proof.log"),
        "SYNTHETIC_SECRET_ABC synthetic observation",
      );
      const inbox = {
          ...scenario(),
          evidence: [
            {
              ...scenario().evidence[0]!,
              source: { storage: "inbox", path: "proof.log" },
            },
          ],
        },
        external = {
          ...scenario("recovery"),
          evidence: [
            {
              ...scenario().evidence[0]!,
              source: {
                storage: "external",
                reference: "https://example.invalid/do-not-fetch",
              },
            },
          ],
        };
      await results.submit(submission([inbox, external]), mutation());
      const report = await reports.create(
        { plan_id, execution_id },
        mutation(),
      );
      const item = (
          await reports.items({ report_id: report.report_id })
        ).items.find((i) => i.result_id)!,
        evidence = item.attempt!.scenarios[0]!.evidence[0]!;
      expect(
        await readFile(
          path.join(config.evidence_dir, ...evidence.object_key!.split("/")),
          "utf8",
        ),
      ).not.toContain("SYNTHETIC_SECRET_ABC");
      await rm(
        path.join(config.evidence_dir, ...evidence.object_key!.split("/")),
      );
      const exported = await reports.export({
        report_id: report.report_id,
        directory: path.join(f.directory, "missing-evidence-export"),
      });
      expect(exported.unavailable_evidence).toBe(1);
      const json = JSON.parse(await readFile(exported.json, "utf8"));
      const submitted = json.items.find(
        (i: { result_id: string }) => i.result_id,
      ).attempt.scenarios[0].evidence[0];
      expect(submitted).toMatchObject({
        availability: "available",
        availability_at_export: "unavailable",
      });
      expect(
        (await reports.items({ report_id: report.report_id })).items.find(
          (i) => i.result_id,
        )!.attempt!.scenarios[0]!.evidence[0]!.availability,
      ).toBe("available");
      await expect(
        access(path.join(f.directory, "untrusted-source-marker")),
      ).rejects.toHaveProperty("code", "ENOENT");
    });
  });
