import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Jobs } from "@bug-manager/core";
import { mkdir, writeFile } from "node:fs/promises";
import {
  HistoryIngestion,
  Analysis,
  configSchema,
  canonical,
} from "@bug-manager/core";
import { fixture, mutation, standard } from "../helpers.js";

const exec = promisify(execFile);
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} independent processes`, () => {
    it("DED-006 independently submits two proposals from stale retrievals and rechecks before activation", async () => {
      const f = await fixture(backend);
      try {
        const root = path.join(f.directory, "semantic-history");
        await mkdir(root);
        for (const session of ["one", "two"])
          await writeFile(
            path.join(root, `${session}.jsonl`),
            [
              { type: "session_meta", payload: { id: `synthetic-${session}` } },
              {
                type: "event_msg",
                payload: {
                  type: "user_message",
                  message: "Repeated request produced two business effects",
                },
              },
            ]
              .map(canonical)
              .join("\n") + "\n",
          );
        const type_id = (await f.type("并发重试")).id,
          config = configSchema.parse({
            database: f.database,
            evidence_dir: f.directory,
            history: [{ adapter: "codex", path: root }],
          }),
          history = new HistoryIngestion(f.store, config),
          analysis = new Analysis(f.store, config),
          job = await history.start({}, mutation());
        await history.resume({ job_id: job.job_id }, mutation());
        const proposals = [];
        for (let i = 0; i < 2; i++) {
          const claim = await analysis.claim({}, mutation());
          expect(claim).toBeTruthy();
          const lease = {
              task_id: claim!.task_id,
              owner_token: claim!.owner_token,
            },
            context = await analysis.context({ ...lease, type_ids: [type_id] });
          proposals.push({
            ...lease,
            outcome: "proposal",
            reason: "Synthetic same-mechanism source",
            retrieval_id: (context.retrieval as { retrieval_id: string })
              .retrieval_id,
            proposal: {
              standards: [{ ref: "s", record: standard([type_id]) }],
            },
          });
        }
        const responses = await Promise.all(
          proposals.map(async (input) => {
            const result = await exec(
              process.execPath,
              [
                path.resolve("scripts/fixtures/process-client.mjs"),
                "analysis_submit",
                JSON.stringify(input),
                JSON.stringify(mutation()),
              ],
              {
                env: {
                  ...process.env,
                  BUG_MANAGER_CHILD_DATABASE: JSON.stringify(f.database),
                  BUG_MANAGER_CHILD_CONFIG: JSON.stringify(config),
                },
                timeout: 20000,
              },
            );
            return JSON.parse(result.stdout);
          }),
        );
        expect(responses.map((r) => r.data.status).sort()).toEqual([
          "candidate",
          "committed",
        ]);
        expect(
          await f.store.db
            .selectFrom("standards")
            .select("id")
            .where("disposition", "=", "active")
            .execute(),
        ).toHaveLength(1);
        expect((await history.freshness()).pending_segments).toBe(0);
      } finally {
        await f.cleanup();
      }
    });
    it("HIS-002/HIS-005 concurrently collects manual/lazy/background work and fences analysis across processes", async () => {
      const f = await fixture(backend);
      try {
        const root = path.join(f.directory, "history");
        await mkdir(root);
        await writeFile(
          path.join(root, "fixture.jsonl"),
          [
            {
              type: "session_meta",
              payload: { id: "synthetic-process-session" },
            },
            {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "Synthetic content to collect exactly once",
              },
            },
          ]
            .map(canonical)
            .join("\n") + "\n",
        );
        const config = configSchema.parse({
            database: f.database,
            evidence_dir: f.directory,
            history: [{ adapter: "codex", path: root }],
          }),
          history = new HistoryIngestion(f.store, config);
        async function child(operation: string, input: unknown) {
          const result = await exec(
            process.execPath,
            [
              path.resolve("scripts/fixtures/process-client.mjs"),
              operation,
              JSON.stringify(input),
              JSON.stringify(mutation()),
            ],
            {
              env: {
                ...process.env,
                BUG_MANAGER_CHILD_DATABASE: JSON.stringify(f.database),
                BUG_MANAGER_CHILD_CONFIG: JSON.stringify(config),
              },
              timeout: 20000,
            },
          ).catch((error) => {
            if (error && typeof error === "object" && "stdout" in error)
              return { stdout: String(error.stdout) };
            throw error;
          });
          return JSON.parse(result.stdout);
        }
        const jobs = await Promise.all(
          (["manual", "lazy", "background"] as const).map((trigger) =>
            history.start({ trigger }, mutation()),
          ),
        );
        const results = await Promise.all(
          jobs.map((job) => child("sync", { job_id: job.job_id })),
        );
        for (let i = 0; i < results.length; i++)
          if (results[i].error) {
            expect([
              "checkpoint_changed",
              "job_busy",
              "source_changed",
            ]).toContain(results[i].error.code);
            await child("sync", { job_id: jobs[i]!.job_id });
          }
        expect(
          await f.store.db.selectFrom("source_segments").selectAll().execute(),
        ).toHaveLength(1);
        const claims = await Promise.all([
          child("analysis_claim", {}),
          child("analysis_claim", {}),
        ]);
        expect(claims.filter((c) => c.data !== null)).toHaveLength(1);
        const first = claims.find((c) => c.data !== null).data;
        await f.store.db
          .updateTable("segment_tasks")
          .set({ lease_until: Date.now() - 1 })
          .where("id", "=", first.task_id)
          .execute();
        const second = await child("analysis_claim", {});
        expect(second.data.owner_token).not.toBe(first.owner_token);
        const rejected = await child("analysis_submit", {
          task_id: first.task_id,
          owner_token: first.owner_token,
          outcome: "no_findings",
          reason: "stale owner",
        });
        expect(rejected.error.code).toBe("lease_lost");
        const completed = await new Analysis(f.store, config).submit(
          {
            task_id: second.data.task_id,
            owner_token: second.data.owner_token,
            outcome: "no_findings",
            reason: "accepted current owner",
          },
          mutation(),
        );
        expect(completed.status).toBe("no_findings");
        expect(await history.freshness()).toMatchObject({
          pending_segments: 0,
          committed_segments: 1,
        });
      } finally {
        await f.cleanup();
      }
    }, 60000);
    it("serializes idempotent replays and fences replaced job owners across process boundaries", async () => {
      const f = await fixture(backend);
      async function child(
        operation: string,
        input: unknown,
        meta = mutation(),
      ) {
        try {
          const result = await exec(
            process.execPath,
            [
              path.resolve("scripts/fixtures/process-client.mjs"),
              operation,
              JSON.stringify(input),
              JSON.stringify(meta),
            ],
            {
              env: {
                ...process.env,
                BUG_MANAGER_CHILD_DATABASE: JSON.stringify(f.database),
              },
            },
          );
          return JSON.parse(result.stdout);
        } catch (error) {
          if (error && typeof error === "object" && "stdout" in error)
            return JSON.parse(String(error.stdout));
          throw error;
        }
      }
      try {
        const meta = mutation(),
          input = {
            name: "跨进程类型",
            definition: "Synthetic concurrent replay",
          };
        const [a, b] = await Promise.all([
          child("propose", input, meta),
          child("propose", input, meta),
        ]);
        expect(a.error).toBeUndefined();
        expect(a.data.id).toBe(b.data.id);
        const jobs = new Jobs(f.store);
        await jobs.enqueue(
          { kind: "race", payload: { fixture: true } },
          mutation(),
        );
        const results = await Promise.all([
          child("claim", { kind: "race" }),
          child("claim", { kind: "race" }),
        ]);
        expect(results.filter((r) => r.data !== null)).toHaveLength(1);
        const first = results.find((r) => r.data !== null).data;
        await f.store.db
          .updateTable("jobs")
          .set({ lease_until: Date.now() - 1 })
          .where("id", "=", first.id)
          .execute();
        const second = await child("claim", { kind: "race" });
        expect(second.data.owner_token).not.toBe(first.owner_token);
        const rejected = await child("complete", {
          job_id: first.id,
          owner_token: first.owner_token,
          result: { late: true },
        });
        expect(rejected.error.code).toBe("lease_lost");
        const completed = await child("complete", {
          job_id: second.data.id,
          owner_token: second.data.owner_token,
          result: { verified: true },
        });
        expect(completed.data.status).toBe("completed");
      } finally {
        await f.cleanup();
      }
    }, 60_000);
  });
}
