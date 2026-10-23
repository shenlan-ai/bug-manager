import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application, canonical, configSchema } from "@bug-manager/core";
import { runHistoryWorker } from "@bug-manager/worker";
import { fixture } from "../helpers.js";

const watchState = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    closed: false,
    clear() {
      listeners.clear();
      this.closed = false;
    },
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    listen(event: string, listener: (...args: unknown[]) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
  };
});

vi.mock("chokidar", () => ({
  default: {
    watch: () => ({
      on(event: string, listener: (...args: unknown[]) => void) {
        watchState.listen(event, listener);
        return this;
      },
      async close() {
        watchState.closed = true;
      },
    }),
  },
}));

afterEach(() => watchState.clear());

describe("history worker watcher recovery", () => {
  it("HIS-008 keeps periodic reconciliation alive after a watcher error", async () => {
    const f = await fixture("sqlite");
    const root = path.join(f.directory, "watch-error-history");
    await mkdir(root);
    const filename = path.join(root, "fixture.jsonl");
    await writeFile(
      filename,
      [
        { type: "session_meta", payload: { id: "synthetic-watch-error" } },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "initial observation" },
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
      ),
      controller = new AbortController();
    let scans = 0;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const worker = runHistoryWorker(app, controller.signal, {
        interval_ms: 50,
        on_scan: (result) => {
          scans++;
          if (scans === 1) {
            void appendFile(
              filename,
              canonical({
                type: "event_msg",
                payload: {
                  type: "user_message",
                  message: "appended while watcher failed",
                },
              }) + "\n",
            );
            watchState.emit("error", new Error("synthetic watcher failure"));
          } else if (
            (
              result as {
                collection?: { new_segments?: number };
              }
            ).collection?.new_segments
          ) {
            controller.abort();
          }
        },
      });
      await expect(worker).resolves.toBeUndefined();
      expect(scans).toBeGreaterThanOrEqual(2);
      expect(
        await f.store.db.selectFrom("source_segments").select("id").execute(),
      ).toHaveLength(2);
      expect(watchState.closed).toBe(true);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await f.cleanup();
    }
  });
});
