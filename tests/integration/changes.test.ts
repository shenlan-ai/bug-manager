import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Changes, configSchema, hash } from "@bug-manager/core";
import { fixture, mutation } from "../helpers.js";
const exec = promisify(execFile);
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} immutable change capture`, () => {
    let f: Awaited<ReturnType<typeof fixture>>,
      directory: string,
      project_id: string,
      changes: Changes;
    const git = (args: string[]) =>
      exec("git", args, { cwd: directory, windowsHide: true });
    beforeEach(async () => {
      f = await fixture(backend);
      directory = path.join(f.directory, "repo");
      await mkdir(directory);
      project_id = (
        await f.projects.register(
          { name: "synthetic repo", directory },
          mutation(),
        )
      ).id;
      changes = new Changes(
        f.store,
        configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          privacy: { patterns: ["SYNTHETIC_SECRET_[A-Z]+"] },
        }),
      );
      await git(["init"]);
      await writeFile(path.join(directory, "old.txt"), "Original content\n");
      await writeFile(path.join(directory, "delete.txt"), "Deleted fixture\n");
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-m",
        "Synthetic baseline",
      ]);
    });
    afterEach(async () => {
      await f?.cleanup();
    });
    it("PLN-001 freezes staged renames, unstaged deletions, Unicode untracked metadata and bounded diff without modifying source", async () => {
      await git(["mv", "old.txt", "重命名.txt"]);
      await rm(path.join(directory, "delete.txt"));
      await writeFile(
        path.join(directory, "新文件.ts"),
        "export const synthetic = true;\n",
      );
      const beforeStatus = (await git(["status", "--porcelain=v1", "-z"]))
          .stdout,
        index = hash(await readFile(path.join(directory, ".git", "index")));
      const meta = mutation(),
        input = {
          project_id,
          mode: "working-tree",
          directory,
          description: "Synthetic rename and deletion",
        };
      const snapshot = await changes.capture(input, meta);
      expect(snapshot.snapshot.base_sha).toMatch(/^[a-f0-9]{40,64}$/);
      expect(snapshot.snapshot.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "重命名.txt",
            previous_path: "old.txt",
            area: "staged",
          }),
          expect.objectContaining({
            path: "delete.txt",
            status: "D",
            area: "unstaged",
          }),
          expect.objectContaining({
            path: "新文件.ts",
            status: "?",
            area: "untracked",
            content_hash: expect.any(String),
          }),
        ]),
      );
      expect(hash(await readFile(path.join(directory, ".git", "index")))).toBe(
        index,
      );
      expect((await git(["status", "--porcelain=v1", "-z"])).stdout).toBe(
        beforeStatus,
      );
      await writeFile(
        path.join(directory, "新文件.ts"),
        "changed after capture",
      );
      expect(await changes.capture(input, meta)).toEqual(snapshot);
      const newer = await changes.capture(input, mutation());
      expect(newer.snapshot.dirty_hash).not.toBe(snapshot.snapshot.dirty_hash);
      expect((await changes.get(snapshot.change_id)).snapshot).toEqual(
        snapshot.snapshot,
      );
    });
    it("PLN-001 captures commit ranges and merge bases with resolved SHAs; refuses invalid refs", async () => {
      const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(directory, "old.txt"), "Changed content\n");
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-m",
        "Synthetic change",
      ]);
      for (const mode of ["range", "base"]) {
        const snapshot = await changes.capture(
          {
            project_id,
            mode,
            directory,
            base_ref: base,
            description: "Read committed differences",
          },
          mutation(),
        );
        expect(snapshot.snapshot).toMatchObject({
          base_sha: base,
          files: expect.arrayContaining([
            expect.objectContaining({ path: "old.txt", area: "committed" }),
          ]),
        });
        if (mode === "base")
          expect(snapshot.snapshot.merge_base_sha).toBe(base);
      }
      await expect(
        changes.capture(
          {
            project_id,
            mode: "range",
            directory,
            base_ref: "--help",
            description: "Invalid reference",
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "git_capture_failed" });
    });
    it("PLN-001 exposes diff/file truncation, redacts snippets and supports explicit non-Git changes", async () => {
      await writeFile(
        path.join(directory, "old.txt"),
        "SYNTHETIC_SECRET_ABC\n" + "Changed line 中文\n".repeat(200),
      );
      await writeFile(path.join(directory, "one.ts"), "one");
      await writeFile(path.join(directory, "two.ts"), "two");
      const snapshot = await changes.capture(
        {
          project_id,
          mode: "working-tree",
          directory,
          description: "Bounded synthetic diff",
          max_diff_chars: 128,
          max_files: 1,
        },
        mutation(),
      );
      expect(snapshot.snapshot).toMatchObject({
        diff_truncated: true,
        files_truncated: true,
        dirty_hash_complete: false,
      });
      const full = await changes.capture(
        {
          project_id,
          mode: "working-tree",
          directory,
          description: "Redacted synthetic diff",
        },
        mutation(),
      );
      expect(full.snapshot.diff).not.toContain("SYNTHETIC_SECRET_ABC");
      const explicit = await changes.capture(
        {
          project_id,
          mode: "explicit",
          description: "Non-Git module change",
          files: [{ path: "模块.ts", change: "Updated retry recovery" }],
        },
        mutation(),
      );
      expect(explicit.snapshot).toMatchObject({
        mode: "explicit",
        files: [{ path: "模块.ts", change: "Updated retry recovery" }],
      });
      await expect(
        changes.capture(
          {
            project_id,
            mode: "working-tree",
            directory: f.directory,
            description: "Outside mapped project",
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "project_mismatch" });
    });
  });
