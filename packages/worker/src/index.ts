import { setTimeout as delay } from "node:timers/promises";
import type { Application } from "@bug-manager/core";
import { id, decodeJson } from "@bug-manager/core";
import chokidar from "chokidar";

export interface JobHandler {
  (payload: unknown, signal: AbortSignal): Promise<unknown>;
}

export async function runHistoryWorker(
  app: Application,
  signal: AbortSignal,
  options: {
    interval_ms?: number;
    watch?: boolean;
    on_scan?: (result: unknown) => void;
  } = {},
) {
  const interval = options.interval_ms ?? 30000,
    meta = (reason: string) => ({
      idempotency_key: id(),
      actor: "history-worker",
      reason,
    });
  if (!app.config.history.length)
    throw new Error(
      "Configure explicit history sources before starting the worker",
    );
  const registered = await app.jobs.enqueue(
    { kind: "history_worker", payload: { interval_ms: interval } },
    meta("Register foreground history worker"),
  );
  const lease = await app.jobs.claim(
    { kind: "history_worker", job_id: registered.id, lease_ms: 60000 },
    meta("Claim foreground worker liveness"),
  );
  if (!lease) throw new Error("Unable to register foreground worker");
  let wake: (() => void) | undefined;
  const watcher =
    options.watch === false
      ? undefined
      : chokidar.watch(
          app.config.history.map((s) => s.path),
          { ignoreInitial: true, followSymlinks: false, persistent: false },
        );
  watcher?.on("all", () => wake?.());
  watcher?.on("error", () => wake?.());
  const stop = () => wake?.();
  signal.addEventListener("abort", stop);
  const heartbeat = setInterval(() => {
    void app.jobs
      .heartbeat(
        { job_id: lease.id, owner_token: lease.owner_token },
        meta("Renew foreground worker liveness"),
      )
      .catch(() => undefined);
  }, 20000);
  let backgroundJobId: string | undefined;
  try {
    while (!signal.aborted) {
      const queued = await app.store.db
        .selectFrom("jobs")
        .select(["id", "payload"])
        .where("kind", "=", "history_sync")
        .where((eb) =>
          eb.or([
            eb("status", "=", "pending"),
            eb.and([
              eb("status", "=", "running"),
              eb("lease_until", "<=", Date.now()),
            ]),
          ]),
        )
        .orderBy("created_at")
        .orderBy("id")
        .limit(1)
        .executeTakeFirst();
      let job_id = queued?.id;
      if (
        queued &&
        decodeJson<{ trigger?: string }>(queued.payload).trigger ===
          "background"
      )
        backgroundJobId = queued.id;
      if (!job_id) {
        if (backgroundJobId) {
          await app.history.rearmBackground(
            { job_id: backgroundJobId },
            meta("Rearm the bounded periodic reconciliation job"),
          );
          job_id = backgroundJobId;
        } else {
          const started = await app.history.start(
            {
              trigger: "background",
              analysis: app.config.model ? "builtin" : "external",
            },
            meta("Discover history through watch or periodic reconciliation"),
          );
          backgroundJobId = started.job_id;
          job_id = started.job_id;
        }
      }
      try {
        const result = await app.history.resume(
          { job_id },
          meta("Collect one bounded history batch"),
          signal,
        );
        options.on_scan?.(result);
        if (
          app.config.model &&
          process.env[app.config.model.api_key_env] &&
          !signal.aborted
        ) {
          const runs = await app.store.db
            .selectFrom("jobs")
            .selectAll()
            .where("kind", "=", "builtin_analysis")
            .orderBy("created_at", "desc")
            .limit(20)
            .execute();
          const existing = runs.find((run) => {
            const p = decodeJson<{
              trigger?: string;
              strategy_version?: string;
            }>(run.payload);
            return (
              p.trigger === "background" &&
              p.strategy_version === app.config.model?.strategy_version
            );
          });
          let modelJobId = existing?.id,
            status = existing?.status;
          if (!existing) {
            const started = await app.models.start(
              { max_segments: 1000, trigger: "background" },
              meta("Start one persisted background model budget"),
            );
            modelJobId = started.job_id;
            status = started.status;
          }
          if (existing?.status === "completed") {
            const p = decodeJson<{ max_segments: number }>(existing.payload),
              r = existing.result
                ? decodeJson<{ processed: number }>(existing.result)
                : { processed: 0 };
            if (
              r.processed < p.max_segments &&
              (await app.history.freshness()).pending_segments > 0
            ) {
              await app.models.control(
                { job_id: existing.id, action: "resume" },
                meta("Resume background analysis with the existing budget"),
              );
              status = "pending";
            }
          }
          if (modelJobId && status === "pending")
            await app.models.resume(
              { job_id: modelJobId },
              meta("Analyze one bounded background segment"),
              signal,
            );
        }
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          ["job_busy", "checkpoint_changed", "source_changed"].includes(
            String(error.code),
          )
        ))
          throw error;
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, interval);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        if (signal.aborted) wake();
      });
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", stop);
    wake?.();
    await watcher?.close();
    await app.jobs
      .complete(
        {
          job_id: lease.id,
          owner_token: lease.owner_token,
          status: "completed",
          result: { shutdown: "graceful", registration_id: registered.id },
        },
        meta("Release worker liveness on graceful exit"),
      )
      .catch(() => undefined);
  }
}
export async function runWorker(
  app: Application,
  handlers: Record<string, JobHandler>,
  signal: AbortSignal,
  intervalMs = 1000,
) {
  while (!signal.aborted) {
    for (const [kind, handler] of Object.entries(handlers)) {
      const meta = () => ({
        idempotency_key: id(),
        actor: "worker",
        reason: "Process a queued job",
      });
      const job = await app.jobs.claim({ kind, lease_ms: 60_000 }, meta());
      if (!job) continue;
      const heartbeat = setInterval(() => {
        void app.jobs
          .heartbeat({ job_id: job.id, owner_token: job.owner_token }, meta())
          .catch(() => undefined);
      }, 20_000);
      try {
        const result = await handler(job.payload, signal);
        await app.jobs.complete(
          {
            job_id: job.id,
            owner_token: job.owner_token,
            result,
            status: signal.aborted ? "pending" : "completed",
          },
          meta(),
        );
      } catch {
        await app.jobs
          .complete(
            {
              job_id: job.id,
              owner_token: job.owner_token,
              result: { code: "job_failed" },
              status: "failed",
            },
            meta(),
          )
          .catch(() => undefined);
      } finally {
        clearInterval(heartbeat);
      }
    }
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error("Worker timer failed");
    }
  }
}
