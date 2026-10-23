import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Application, canonical, configSchema } from "@bug-manager/core";
import { runHistoryWorker } from "@bug-manager/worker";
import { fixture, mutation } from "../helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} history worker`, () => {
    it("HIS-005/HIS-008 recovers unfinished collection after a real worker kill and restart", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const root = path.join(f.directory, "restart-history");
      await mkdir(root);
      for (let i = 0; i < 101; i++)
        await writeFile(
          path.join(root, `${String(i).padStart(3, "0")}.jsonl`),
          [
            { type: "session_meta", payload: { id: `restart-${i}` } },
            {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: `Synthetic initial content ${i}`,
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
      });
      const children: ChildProcessWithoutNullStreams[] = [];
      function launch(
        interval: number,
        predicate: (value: {
          status?: string;
          analysis?: { pending_segments: number };
        }) => boolean,
      ) {
        const child = spawn(
          process.execPath,
          [
            path.resolve("scripts/fixtures/history-worker.mjs"),
            String(interval),
          ],
          {
            env: {
              ...process.env,
              BUG_MANAGER_CHILD_CONFIG: JSON.stringify(config),
            },
            windowsHide: true,
          },
        );
        children.push(child);
        const exited = new Promise<void>((resolve, reject) => {
          child.once("exit", () => resolve());
          child.once("error", reject);
        });
        const observed = new Promise<void>((resolve, reject) => {
          let buffer = "",
            errors = "";
          const timer = setTimeout(
            () => reject(new Error(`Worker observation timed out: ${errors}`)),
            25000,
          );
          child.stderr.on("data", (chunk) => {
            errors += String(chunk);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`Worker exited before expected scan: ${errors}`));
          });
          child.stdout.on("data", (chunk) => {
            buffer += String(chunk);
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (predicate(JSON.parse(line))) {
                clearTimeout(timer);
                resolve();
              }
            }
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        return { child, exited, observed };
      }
      try {
        const first = launch(60000, (value) => value.status === "pending");
        await first.observed;
        first.child.kill("SIGKILL");
        await first.exited;
        const interrupted = await f.store.db
          .selectFrom("jobs")
          .selectAll()
          .where("kind", "=", "history_sync")
          .where("status", "=", "pending")
          .execute();
        expect(interrupted).toHaveLength(1);
        await appendFile(
          path.join(root, "000.jsonl"),
          canonical({
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Appended while worker was stopped",
            },
          }) + "\n",
        );
        const second = launch(
          500,
          (value) => value.analysis?.pending_segments === 102,
        );
        await second.observed;
        second.child.stdin.write("stop\n");
        await second.exited;
        expect(
          await f.store.db.selectFrom("source_segments").select("id").execute(),
        ).toHaveLength(102);
        const recovered = await f.store.db
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", interrupted[0]!.id)
          .executeTakeFirstOrThrow();
        expect(recovered.attempts).toBeGreaterThan(interrupted[0]!.attempts);
        expect(recovered.owner_token).toBeNull();
        expect(["completed", "pending"]).toContain(recovered.status);
        expect(
          await f.store.db
            .selectFrom("jobs")
            .select("id")
            .where("kind", "=", "history_sync")
            .execute(),
        ).toHaveLength(1);
      } finally {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await new Promise<void>((resolve) =>
              child.once("exit", () => resolve()),
            );
          }
      }
    }, 60000);
    it("HIS-008 observes real filesystem notifications without waiting for the periodic scan", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const root = path.join(f.directory, "watch-history");
      await mkdir(root);
      const filename = path.join(root, "fixture.jsonl");
      await writeFile(
        filename,
        canonical({
          type: "session_meta",
          payload: { id: "real-watch-synthetic" },
        }) + "\n",
      );
      const app = new Application(
          f.store,
          configSchema.parse({
            database: f.database,
            evidence_dir: f.directory,
            history: [{ adapter: "codex", path: root }],
          }),
        ),
        controller = new AbortController();
      let scheduled = false,
        observed = false;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        await runHistoryWorker(app, controller.signal, {
          interval_ms: 60000,
          on_scan: (result) => {
            const scan = result as { collection?: { new_segments: number } };
            if (scan.collection?.new_segments) {
              observed = true;
              controller.abort();
            }
            if (!scheduled) {
              scheduled = true;
              setTimeout(() => {
                void appendFile(
                  filename,
                  canonical({
                    type: "event_msg",
                    payload: {
                      type: "user_message",
                      message: "watched append",
                    },
                  }) + "\n",
                );
              }, 150);
            }
          },
        });
        expect(observed).toBe(true);
        expect(
          await f.store.db.selectFrom("source_segments").selectAll().execute(),
        ).toHaveLength(1);
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
    it("HIS-008 periodic reconciliation discovers missed watch events; manual/lazy replay is idempotent and shutdown releases liveness", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const root = path.join(f.directory, "history");
      await mkdir(root);
      const filename = path.join(root, "fixture.jsonl");
      await writeFile(
        filename,
        [
          { type: "session_meta", payload: { id: "synthetic-worker" } },
          {
            type: "event_msg",
            payload: { type: "user_message", message: "first" },
          },
        ]
          .map(canonical)
          .join("\n") + "\n",
      );
      const app = new Application(
        f.store,
        configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          history: [{ adapter: "codex", path: root }],
        }),
      );
      for (const trigger of ["manual", "lazy"] as const) {
        const job = await app.history.start({ trigger }, mutation());
        await app.history.resume({ job_id: job.job_id }, mutation());
      }
      const controller = new AbortController();
      let scans = 0,
        background: Promise<void> | undefined;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        background = runHistoryWorker(app, controller.signal, {
          watch: false,
          interval_ms: 50,
          on_scan: () => {
            scans++;
            if (scans === 1)
              void appendFile(
                filename,
                canonical({
                  type: "event_msg",
                  payload: {
                    type: "user_message",
                    message: "second via missed notification",
                  },
                }) + "\n",
              );
            if (scans >= 3) controller.abort();
          },
        });
        await background;
        expect(scans).toBeGreaterThanOrEqual(3);
        expect(
          await f.store.db.selectFrom("source_segments").selectAll().execute(),
        ).toHaveLength(2);
        expect(await app.history.freshness()).toMatchObject({
          pending_segments: 2,
        });
        const workers = await f.store.db
          .selectFrom("jobs")
          .selectAll()
          .where("kind", "=", "history_worker")
          .execute();
        const syncJobs = await f.store.db
          .selectFrom("jobs")
          .select(["id", "payload"])
          .where("kind", "=", "history_sync")
          .execute();
        expect(workers).toHaveLength(1);
        expect(workers[0]).toMatchObject({
          status: "completed",
          owner_token: null,
          lease_until: 0,
        });
        expect(
          syncJobs.filter(
            (job) =>
              (
                JSON.parse(job.payload) as {
                  trigger?: string;
                }
              ).trigger === "background",
          ),
        ).toHaveLength(1);
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await background;
      }
    });
  });
