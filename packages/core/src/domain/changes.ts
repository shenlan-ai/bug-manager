import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Store, Mutation } from "../storage/database.js";
import { DomainError, invariant } from "../errors.js";
import { canonical, decodeJson, hash, id, now, boundedText } from "../util.js";
import { redactValue } from "../privacy.js";
import { text, uuid } from "./schemas.js";
import { Projects } from "./projects.js";

export const changeCaptureSchema = z
  .object({
    project_id: uuid,
    mode: z.enum(["explicit", "working-tree", "range", "base"]),
    directory: text.optional(),
    base_ref: text.max(500).optional(),
    head_ref: text.max(500).optional(),
    description: text,
    files: z
      .array(
        z
          .object({ path: text, change: text, module: text.optional() })
          .strict(),
      )
      .max(1000)
      .default([]),
    max_diff_chars: z.number().int().min(128).max(200000).default(24000),
    max_files: z.number().int().min(1).max(5000).default(1000),
  })
  .strict();
interface GitFile {
  path: string;
  previous_path?: string;
  status: string;
  area: string;
  size?: number;
  content_hash?: string;
  content_truncated?: boolean;
  symlink?: boolean;
}
export interface ChangeSnapshot {
  schema_version: 1;
  project_id: string;
  mode: string;
  description: string;
  captured_at: string;
  base_sha?: string;
  head_sha?: string;
  merge_base_sha?: string;
  dirty_hash?: string;
  dirty_hash_complete?: boolean;
  files: Array<GitFile | { path: string; change: string; module?: string }>;
  files_truncated: boolean;
  diff?: string;
  diff_truncated?: boolean;
  warnings: string[];
}
// No shell, pager, hooks, external diff, textconv or filesystem monitor invocation.
async function git(
  directory: string,
  args: string[],
  capture = 2 * 1024 * 1024,
  total = 32 * 1024 * 1024,
) {
  return new Promise<{
    text: string;
    digest: string;
    truncated: boolean;
    complete: boolean;
  }>((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.quotepath=false",
        ...args,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const digest = createHash("sha256"),
      chunks: Buffer[] = [];
    let bytes = 0,
      retained = 0,
      limited = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30000);
    child.stdout.on("data", (part: Buffer) => {
      const keep = part.subarray(0, Math.max(0, total - bytes));
      digest.update(keep);
      bytes += part.length;
      if (retained < capture) {
        const prefix = keep.subarray(0, capture - retained);
        chunks.push(prefix);
        retained += prefix.length;
      }
      if (bytes > total) {
        limited = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new DomainError("git_unavailable", "Git could not be started"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        return reject(
          new DomainError(
            "git_timeout",
            "Read-only Git capture exceeded its time budget",
            true,
          ),
        );
      if (code !== 0 && !limited)
        return reject(
          new DomainError(
            "git_capture_failed",
            "Git repository or ref could not be read; provide valid refs or explicit input",
          ),
        );
      resolve({
        text: Buffer.concat(chunks).toString("utf8"),
        digest: digest.digest("hex"),
        truncated: bytes > capture,
        complete: !limited,
      });
    });
  });
}
function names(raw: string, area: string): GitFile[] {
  const parts = raw.split("\0"),
    files: GitFile[] = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++]!,
      first = parts[i++];
    if (!first) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const next = parts[i++];
      if (!next) break;
      files.push({ path: next, previous_path: first, status, area });
    } else files.push({ path: first, status, area });
  }
  return files;
}
export class Changes {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  async capture(raw: unknown, meta: Mutation) {
    const input = changeCaptureSchema.parse(raw),
      request = { operation: "changes.capture", input };
    const replay = await this.store.replay<{
      change_id: string;
      content_hash: string;
      snapshot: ChangeSnapshot;
    }>(meta, request);
    if (replay.found) return replay.result;
    await new Projects(this.store).get(input.project_id);
    let snapshot: ChangeSnapshot = {
      schema_version: 1,
      project_id: input.project_id,
      mode: input.mode,
      description: input.description,
      captured_at: now(),
      files: input.files,
      files_truncated: false,
      warnings: [],
    };
    if (input.mode !== "explicit") {
      invariant(
        input.directory,
        "directory_required",
        "Git capture requires an explicitly mapped directory",
      );
      const resolved = await new Projects(this.store).resolve(input.directory);
      invariant(
        resolved.status === "mapped" &&
          resolved.project.id === input.project_id,
        "project_mismatch",
        "Git directory must map to the requested project",
      );
      const head = (
        await git(
          input.directory,
          [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${input.head_ref ?? "HEAD"}^{commit}`,
          ],
          256,
        )
      ).text.trim();
      invariant(
        /^[a-f0-9]{40,64}$/.test(head),
        "invalid_git_ref",
        "Git ref did not resolve to a commit",
      );
      let base = head,
        mergeBase: string | undefined;
      if (input.mode !== "working-tree") {
        invariant(
          input.base_ref,
          "base_ref_required",
          "Range/base capture requires base_ref",
        );
        base = (
          await git(
            input.directory,
            [
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${input.base_ref}^{commit}`,
            ],
            256,
          )
        ).text.trim();
        invariant(
          /^[a-f0-9]{40,64}$/.test(base),
          "invalid_git_ref",
          "Base ref did not resolve to a commit",
        );
        if (input.mode === "base")
          mergeBase = (
            await git(input.directory, ["merge-base", base, head], 256)
          ).text.trim();
      }
      const diffArgs = [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--find-renames",
        ],
        range =
          input.mode === "working-tree" ? [head] : [mergeBase ?? base, head];
      const diff = await git(
        input.directory,
        [...diffArgs, ...range, "--"],
        input.max_diff_chars * 4,
      );
      const files: GitFile[] = [];
      let filesTruncated = false;
      if (input.mode === "working-tree") {
        for (const [area, args] of [
          ["staged", ["--cached", head]],
          ["unstaged", []],
        ] as const) {
          const list = await git(input.directory, [
            ...diffArgs,
            "--name-status",
            "-z",
            ...args,
            "--",
          ]);
          files.push(...names(list.text, area));
          filesTruncated ||= list.truncated || !list.complete;
        }
        const untracked = await git(input.directory, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]);
        filesTruncated ||= untracked.truncated || !untracked.complete;
        for (const filename of untracked.text.split("\0").filter(Boolean)) {
          if (files.length >= input.max_files) {
            filesTruncated = true;
            break;
          }
          const absolute = path.resolve(input.directory, filename),
            relative = path.relative(input.directory, absolute);
          invariant(
            relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative),
            "source_path_escape",
            "Git returned an unsafe relative path",
          );
          try {
            const stat = await lstat(absolute),
              file: GitFile = {
                path: filename,
                status: "?",
                area: "untracked",
                size: stat.size,
                symlink: stat.isSymbolicLink(),
              };
            if (stat.isFile() && stat.size <= 1024 * 1024) {
              const canonicalRoot = await realpath(input.directory),
                canonicalFile = await realpath(absolute),
                fromRoot = path.relative(canonicalRoot, canonicalFile);
              invariant(
                fromRoot !== ".." &&
                  !fromRoot.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(fromRoot),
                "source_path_escape",
                "Untracked file left the project directory",
              );
              const handle = await open(canonicalFile, "r");
              try {
                const bytes = Buffer.alloc(stat.size),
                  read = await handle.read(bytes, 0, bytes.length, 0),
                  after = await handle.stat();
                file.content_hash = hash(bytes.subarray(0, read.bytesRead));
                if (
                  read.bytesRead !== stat.size ||
                  after.size !== stat.size ||
                  after.mtimeMs !== stat.mtimeMs
                )
                  file.content_truncated = true;
              } finally {
                await handle.close();
              }
            } else file.content_truncated = true;
            files.push(file);
          } catch {
            files.push({
              path: filename,
              status: "?",
              area: "untracked",
              content_truncated: true,
            });
            snapshot.warnings.push(
              "An untracked file changed or became unavailable during capture",
            );
          }
        }
      } else {
        const list = await git(input.directory, [
          ...diffArgs,
          "--name-status",
          "-z",
          ...range,
          "--",
        ]);
        files.push(...names(list.text, "committed"));
        filesTruncated = list.truncated || !list.complete;
      }
      const diffText = boundedText(diff.text, input.max_diff_chars),
        diffTruncated = diff.truncated || diffText.length < diff.text.length;
      snapshot = {
        ...snapshot,
        base_sha: base,
        head_sha: head,
        merge_base_sha: mergeBase,
        files: files.slice(0, input.max_files),
        files_truncated: filesTruncated || files.length > input.max_files,
        diff: diffText,
        diff_truncated: diffTruncated,
        dirty_hash: hash(canonical({ diff: diff.digest, files })),
        dirty_hash_complete:
          diff.complete &&
          !filesTruncated &&
          files.every((f) => !f.content_truncated),
      };
      if (
        snapshot.files_truncated ||
        snapshot.diff_truncated ||
        !snapshot.dirty_hash_complete
      )
        snapshot.warnings.push(
          "Change capture is bounded; truncated or unavailable ranges are not proof of no changes",
        );
    }
    snapshot = redactValue(
      snapshot,
      (this.config.privacy?.patterns ?? []).map((p) => new RegExp(p, "g")),
    ) as ChangeSnapshot;
    return this.store.write(meta, request, async (tx) => {
      const change_id = id(),
        content_hash = hash(canonical(snapshot));
      await tx
        .insertInto("change_snapshots")
        .values({
          id: change_id,
          project_id: input.project_id,
          snapshot: canonical(snapshot),
          content_hash,
          created_at: now(),
        })
        .execute();
      return { change_id, content_hash, snapshot };
    });
  }
  async get(change_id: string) {
    uuid.parse(change_id);
    const row = await this.store.db
      .selectFrom("change_snapshots")
      .selectAll()
      .where("id", "=", change_id)
      .executeTakeFirst();
    invariant(row, "not_found", "Change snapshot not found");
    return { ...row, snapshot: decodeJson<ChangeSnapshot>(row.snapshot) };
  }
}
