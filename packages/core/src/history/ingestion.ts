import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { invariant } from "../errors.js";
import { Jobs } from "../domain/jobs.js";
import { pageSchema, uuid } from "../domain/schemas.js";
import type { Mutation, Store, Db } from "../storage/database.js";
import {
  canonical,
  decodeJson,
  hash,
  id,
  makeCursor,
  normalizePath,
  now,
  parseCursor,
  boundedText,
} from "../util.js";
import { redact, redactValue } from "../privacy.js";
import { matchesHistoryGlob } from "./globs.js";
import { initialAdapterState, normalizeHistoryRecord } from "./adapters.js";
import { readJsonl } from "./reader.js";
import { ContextSegmenter } from "./segmenter.js";
import type { SegmenterState } from "./segmenter.js";
import { CURRENT_ANALYSIS_VERSION } from "./versions.js";
import type {
  AdapterState,
  HistoryAdapter,
  HistoryEvent,
  Locator,
} from "./types.js";

export const syncStartSchema = z
  .object({
    trigger: z.enum(["manual", "lazy", "background"]).default("manual"),
    analysis: z.enum(["external", "builtin"]).default("external"),
    max_files: z.number().int().min(1).max(1000).default(100),
    max_bytes: z
      .number()
      .int()
      .min(1024)
      .max(32 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    segment_chars: z.number().int().min(64).max(16000).default(6000),
  })
  .strict();
export const syncResumeSchema = z.object({ job_id: uuid }).strict();
export const syncStatusSchema = pageSchema
  .extend({ job_id: uuid.optional(), root_id: uuid.optional() })
  .strict();
type SourceRoot = Config["history"][number];
type SyncPayload = z.infer<typeof syncStartSchema> & {
  sources: SourceRoot[];
  after?: string;
};
interface FileState {
  adapter: AdapterState;
  segmenter: SegmenterState;
  line_number: number;
  read_offset: number;
  consumed_hash: string;
  file_identity: string;
  observed_size: number;
  mtime_ms: number;
  gaps: number;
  warnings: string[];
  last_issue?: Locator & { code: string };
  pending_tail?: Locator & { code: string };
  project_hint?: string;
  unavailable?: boolean;
  skipping_oversize?: boolean;
}
interface Collection {
  files: number;
  bytes: number;
  new_segments: number;
  replayed_events: number;
  gaps: number;
  excluded: number;
  unavailable: number;
  after?: string;
  complete: boolean;
}
interface SyncResumeResult {
  job_id: string;
  status: string;
  collection?: Collection;
  analysis?: Awaited<ReturnType<HistoryIngestion["freshness"]>>;
}

function isWithin(root: string, target: string) {
  const r = path.relative(root, target);
  return (
    r === "" ||
    (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r))
  );
}
function excluded(source: SourceRoot, relative: string, session?: string) {
  const normalized = relative.split(path.sep).join("/");
  return source.exclude.some((p) =>
    p.startsWith("session:")
      ? !!session && matchesHistoryGlob(session, p.slice(8))
      : normalized === p ||
        normalized.startsWith(p.replace(/\/$/, "") + "/") ||
        matchesHistoryGlob(normalized, p),
  );
}
async function* discover(
  root: string,
  source: SourceRoot,
  relative = "",
): AsyncGenerator<{ file?: string; relative: string; code?: string }> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    yield { relative, code: "source_unavailable" };
    return;
  }
  entries.sort((a, b) => {
    const x = a.name + (a.isDirectory() ? "/" : ""),
      y = b.name + (b.isDirectory() ? "/" : "");
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded(source, next)) {
      yield { relative: next, code: "excluded" };
      continue;
    }
    if (entry.isSymbolicLink()) {
      yield { relative: next, code: "symlink_excluded" };
      continue;
    }
    if (entry.isDirectory()) yield* discover(root, source, next);
    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
      yield { file: path.join(root, next), relative: next };
  }
}
async function digestPrefix(filename: string, length: number) {
  const file = await open(filename, "r"),
    digest = createHash("sha256"),
    buffer = Buffer.alloc(64 * 1024);
  try {
    let position = 0;
    while (position < length) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(length - position, buffer.length),
        position,
      );
      invariant(
        bytesRead > 0,
        "source_changed",
        "History was truncated while reading",
      );
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}
async function headerIdentity(filename: string, adapter: HistoryAdapter) {
  const state = initialAdapterState(filename);
  // Parse only identity fields here; excluded sessions never enter normalization.
  for await (const line of readJsonl(filename, {
    max_bytes: 128 * 1024,
    max_line_bytes: 128 * 1024,
  })) {
    if (line.kind !== "record" || !line.value || typeof line.value !== "object")
      continue;
    const raw = line.value as Record<string, unknown>;
    const p =
      raw.payload && typeof raw.payload === "object"
        ? (raw.payload as Record<string, unknown>)
        : {};
    const session =
      adapter === "codex" && raw.type === "session_meta"
        ? p.id
        : adapter === "claude"
          ? raw.sessionId
          : undefined;
    if (typeof session === "string")
      return `${session}${adapter === "claude" && state.agent_id ? `/${state.agent_id}` : ""}`.slice(
        0,
        200,
      );
  }
  return state.session_id;
}

export class HistoryIngestion {
  readonly jobs: Jobs;
  readonly patterns: RegExp[];
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.jobs = new Jobs(store);
    this.patterns = (config.privacy?.patterns ?? []).map(
      (p) => new RegExp(p, "g"),
    );
  }
  private async configuredSources() {
    invariant(
      this.config.history.length > 0,
      "history_sources_required",
      "Configure explicit history paths before synchronizing",
    );
    return Promise.all(
      this.config.history.map(async (source) => ({
        ...source,
        path: await normalizePath(source.path),
      })),
    );
  }
  private async registerSources(sources: SyncPayload["sources"]) {
    for (const source of sources) {
      const request = { operation: "history.root", source };
      await this.store.write(
        {
          idempotency_key: `history-root:${hash(canonical(request)).slice(0, 64)}`,
          actor: "history",
          reason: "Register configured history root and exclusions",
        },
        request,
        async (tx) => {
          const row = await tx
            .selectFrom("source_roots")
            .select("id")
            .where("adapter", "=", source.adapter)
            .where("path", "=", source.path)
            .executeTakeFirst();
          if (row)
            await tx
              .updateTable("source_roots")
              .set({ exclusions: canonical(source.exclude) })
              .where("id", "=", row.id)
              .execute();
          else
            await tx
              .insertInto("source_roots")
              .values({
                id: id(),
                adapter: source.adapter,
                path: source.path,
                exclusions: canonical(source.exclude),
                created_at: now(),
              })
              .execute();
          return { registered: true };
        },
      );
    }
  }
  async rearmBackground(raw: unknown, meta: Mutation) {
    const { job_id } = syncResumeSchema.parse(raw);
    const sources = await this.configuredSources();
    await this.registerSources(sources);
    return this.store.write(
      meta,
      { operation: "history.background.rearm", job_id },
      async (tx) => {
        const job = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", job_id)
          .executeTakeFirst();
        invariant(job, "not_found", "History synchronization job not found");
        invariant(
          job.kind === "history_sync",
          "validation_error",
          "Background history job has the wrong kind",
        );
        const payload = decodeJson<SyncPayload>(job.payload);
        invariant(
          payload.trigger === "background",
          "validation_error",
          "Only a background history job can be rearmed by the worker",
        );
        if (
          job.status === "pending" ||
          (job.status === "running" && job.lease_until > Date.now())
        )
          return { job_id, status: job.status };
        await tx
          .updateTable("jobs")
          .set({
            status: "pending",
            payload: canonical({ ...payload, sources, after: undefined }),
            owner_token: null,
            lease_until: 0,
            updated_at: now(),
          })
          .where("id", "=", job_id)
          .where("kind", "=", "history_sync")
          .execute();
        return { job_id, status: "pending" as const };
      },
    );
  }
  async start(raw: unknown, meta: Mutation) {
    const input = syncStartSchema.parse(raw);
    const sources = await this.configuredSources();
    await this.registerSources(sources);
    const job = await this.jobs.enqueue(
      { kind: "history_sync", payload: { ...input, sources } },
      meta,
    );
    return { job_id: job.id, status: job.status, analysis: input.analysis };
  }
  async resume(
    raw: unknown,
    meta: Mutation,
    signal?: AbortSignal,
  ): Promise<SyncResumeResult> {
    const { job_id } = syncResumeSchema.parse(raw);
    const request = { operation: "sync.resume", job_id };
    const begun = await this.store.begin(meta, request, async (tx) => {
      const job = await tx
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", job_id)
        .where("kind", "=", "history_sync")
        .executeTakeFirst();
      invariant(job, "not_found", "History synchronization job not found");
      if (job.status === "completed") return null;
      invariant(
        job.status !== "running" || job.lease_until <= Date.now(),
        "job_busy",
        "Synchronization is owned by another worker",
      );
      const owner_token = id();
      await tx
        .updateTable("jobs")
        .set({
          status: "running",
          owner_token,
          lease_until: Date.now() + 60000,
          attempts: job.attempts + 1,
          updated_at: now(),
        })
        .where("id", "=", job_id)
        .execute();
      return { owner_token, payload: decodeJson<SyncPayload>(job.payload) };
    });
    if (begun.replayed) return begun.result as SyncResumeResult;
    const claim = begun.claim;
    if (!claim)
      return this.store.write(meta, request, async () => ({
        job_id,
        status: "completed",
      }));
    const heartbeat = setInterval(() => {
      void this.jobs
        .heartbeat(
          { job_id, owner_token: claim.owner_token },
          {
            idempotency_key: id(),
            actor: meta.actor,
            reason: "Renew history collection lease",
          },
        )
        .catch(() => undefined);
    }, 20000);
    try {
      const collection = await this.collect(claim.payload, job_id, signal);
      return await this.store.write(meta, request, async (tx) => {
        const job = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", job_id)
          .executeTakeFirstOrThrow();
        invariant(
          job.owner_token === claim.owner_token && job.lease_until > Date.now(),
          "lease_lost",
          "Synchronization lease was lost",
        );
        await tx
          .updateTable("jobs")
          .set({
            status: collection.complete ? "completed" : "pending",
            payload: canonical({ ...claim.payload, after: collection.after }),
            result: canonical(collection),
            owner_token: null,
            lease_until: 0,
            updated_at: now(),
          })
          .where("id", "=", job_id)
          .execute();
        return {
          job_id,
          status: collection.complete ? "completed" : "pending",
          collection,
          analysis: await this.freshness(tx),
        };
      });
    } catch (error) {
      await this.jobs
        .complete(
          {
            job_id,
            owner_token: claim.owner_token,
            status: "pending",
            result: { code: "collection_interrupted" },
          },
          {
            idempotency_key: id(),
            actor: meta.actor,
            reason: "Keep interrupted collection resumable",
          },
        )
        .catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async collect(
    input: SyncPayload,
    scan_id: string,
    signal?: AbortSignal,
  ): Promise<Collection> {
    const result: Collection = {
      files: 0,
      bytes: 0,
      new_segments: 0,
      replayed_events: 0,
      gaps: 0,
      excluded: 0,
      unavailable: 0,
      complete: true,
    };
    for (const source of input.sources
      .slice()
      .sort((a, b) =>
        `${a.adapter}:${a.path}` < `${b.adapter}:${b.path}` ? -1 : 1,
      )) {
      const root = await this.store.db
        .selectFrom("source_roots")
        .selectAll()
        .where("adapter", "=", source.adapter)
        .where("path", "=", source.path)
        .executeTakeFirstOrThrow();
      let rootPath: string;
      try {
        rootPath = await realpath(source.path);
      } catch {
        result.unavailable++;
        result.gaps++;
        await this.discoveryIssue(root.id, "", "source_unavailable", scan_id);
        continue;
      }
      for await (const entry of discover(rootPath, source)) {
        const key = `${source.adapter}:${source.path}/${entry.relative}`;
        if (input.after && key <= input.after) continue;
        if (signal?.aborted || result.files >= input.max_files) {
          result.complete = false;
          return result;
        }
        if (excluded(source, entry.relative)) {
          result.excluded++;
          result.after = key;
          continue;
        }
        if (entry.code) {
          result.gaps++;
          if (entry.code === "source_unavailable") result.unavailable++;
          await this.discoveryIssue(
            root.id,
            entry.relative,
            entry.code,
            scan_id,
          );
          result.after = key;
          continue;
        }
        if (!entry.file) continue;
        result.files++;
        try {
          const canonicalFile = await realpath(entry.file);
          invariant(
            isWithin(rootPath, canonicalFile),
            "source_path_escape",
            "History path left the configured root",
          );
          const external_id = redact(
            await headerIdentity(canonicalFile, source.adapter),
            this.patterns,
          );
          if (excluded(source, entry.relative, external_id)) {
            result.excluded++;
            await this.recordExcluded(root.id, external_id, canonicalFile);
            result.after = key;
            continue;
          }
          const step = await this.readFile(
            source,
            root.id,
            canonicalFile,
            external_id,
            input,
            signal,
          );
          result.bytes += step.bytes;
          result.new_segments += step.segments;
          result.replayed_events += step.replayed;
          result.gaps += step.gaps;
          if (step.more) {
            result.complete = false;
            return result;
          }
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
          ) {
            result.unavailable++;
            result.gaps++;
            await this.discoveryIssue(
              root.id,
              entry.relative,
              "source_unavailable",
              scan_id,
            );
          } else throw error;
        }
        result.after = key;
      }
      // A root's diagnostic set is reconciled only after all its pages finish.
      // Do not clear observations made by a newer concurrent scan.
      const scan = await this.jobs.get(scan_id);
      await this.store.write(
        {
          idempotency_key: id(),
          actor: "history",
          reason: "Reconcile completed root discovery",
        },
        { operation: "history.discovery.complete", root_id: root.id, scan_id },
        async (tx) => {
          await tx
            .deleteFrom("history_discovery_issues")
            .where("root_id", "=", root.id)
            .where("scan_id", "!=", scan_id)
            .where("observed_at", "<=", scan.created_at)
            .execute();
          return { reconciled: true };
        },
      );
    }
    // Previously known files may disappear; keep their evidence and mark visibility.
    let afterSession = "";
    while (true) {
      const known = await this.store.db
        .selectFrom("source_sessions")
        .select(["id", "source_path", "metadata"])
        .where("coverage", "!=", "excluded")
        .where("id", ">", afterSession)
        .orderBy("id")
        .limit(200)
        .execute();
      const missing: Array<{ id: string; source_path: string }> = [];
      for (const session of known) {
        if (signal?.aborted) {
          result.complete = false;
          return result;
        }
        try {
          await lstat(session.source_path);
        } catch {
          const metadata = decodeJson<Partial<FileState>>(session.metadata);
          if (!metadata.unavailable) missing.push(session);
        }
      }
      if (missing.length)
        await this.store.write(
          {
            idempotency_key: id(),
            actor: "history",
            reason: "Mark missing source; retain extracted evidence",
          },
          { operation: "history.unavailable", ids: missing.map((s) => s.id) },
          async (tx) => {
            for (const session of missing) {
              const current = await tx
                .selectFrom("source_sessions")
                .selectAll()
                .where("id", "=", session.id)
                .executeTakeFirstOrThrow();
              if (current.source_path !== session.source_path) continue;
              const metadata = decodeJson<Partial<FileState>>(current.metadata);
              await tx
                .updateTable("source_sessions")
                .set({
                  metadata: canonical({ ...metadata, unavailable: true }),
                  coverage: "unavailable",
                })
                .where("id", "=", session.id)
                .execute();
            }
            return { marked: true };
          },
        );
      if (known.length < 200) break;
      afterSession = known.at(-1)!.id;
    }
    return result;
  }
  private async discoveryIssue(
    root_id: string,
    relative: string,
    code: string,
    scan_id: string,
  ) {
    await this.store.write(
      {
        idempotency_key: id(),
        actor: "history",
        reason: "Retain discovery coverage gap",
      },
      {
        operation: "history.discovery.issue",
        root_id,
        path_hash: hash(relative),
        code,
        scan_id,
      },
      async (tx) => {
        const row = {
          root_id,
          path_hash: hash(relative),
          code,
          scan_id,
          observed_at: now(),
        };
        await tx
          .insertInto("history_discovery_issues")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["root_id", "path_hash"]).doUpdateSet(row),
          )
          .execute();
        return { recorded: true };
      },
    );
  }
  private async recordExcluded(
    root_id: string,
    external_id: string,
    source_path: string,
  ) {
    await this.store.write(
      {
        idempotency_key: id(),
        actor: "history",
        reason: "Record excluded session without content",
      },
      { operation: "history.excluded", root_id, external_id },
      async (tx) => {
        await tx
          .insertInto("source_sessions")
          .values({
            id: id(),
            root_id,
            external_id,
            generation: "excluded",
            source_path,
            metadata: "{}",
            coverage: "excluded",
            created_at: now(),
          })
          .onConflict((oc) =>
            oc.columns(["root_id", "external_id", "generation"]).doNothing(),
          )
          .execute();
        return { excluded: true };
      },
    );
  }
  private async readFile(
    source: SourceRoot,
    root_id: string,
    filename: string,
    external_id: string,
    input: SyncPayload,
    signal?: AbortSignal,
  ) {
    const stat = await lstat(filename),
      identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const candidates = await this.store.db
      .selectFrom("source_sessions as s")
      .innerJoin("source_roots as r", "r.id", "s.root_id")
      .selectAll("s")
      .where("s.external_id", "=", external_id)
      .where("r.adapter", "=", source.adapter)
      .where("s.coverage", "!=", "excluded")
      .orderBy("s.created_at", "desc")
      .limit(20)
      .execute();
    let previous =
      candidates.find(
        (c) =>
          decodeJson<Partial<FileState>>(c.metadata).file_identity === identity,
      ) ?? candidates.find((c) => c.source_path === filename);
    // A declared session ID can be copied/archived. Confirm its committed prefix before reusing it.
    if (!previous)
      for (const candidate of candidates) {
        const state = decodeJson<Partial<FileState>>(candidate.metadata);
        if (
          state.read_offset !== undefined &&
          state.read_offset <= stat.size &&
          state.consumed_hash ===
            (await digestPrefix(filename, state.read_offset))
        ) {
          previous = candidate;
          break;
        }
      }
    let old = previous ? decodeJson<FileState>(previous.metadata) : undefined;
    if (
      old &&
      (old.read_offset > stat.size ||
        old.consumed_hash !== (await digestPrefix(filename, old.read_offset)))
    ) {
      previous = undefined;
      old = undefined;
    }
    const sourceId = previous?.id ?? id(),
      generation = previous?.generation ?? id(),
      offset = old?.read_offset ?? 0;
    const adapter = old?.adapter ?? initialAdapterState(filename),
      events: HistoryEvent[] = [],
      warnings = new Set(old?.warnings ?? []);
    const issues: Array<Locator & { code: string }> = [];
    let readOffset = offset,
      lineNumber = old?.line_number ?? 1,
      gaps = old?.gaps ?? 0,
      lastIssue = old?.last_issue,
      pendingTail: FileState["pending_tail"],
      skipping_oversize = false;
    for await (const line of readJsonl(filename, {
      offset,
      line_number: lineNumber,
      max_bytes: input.max_bytes,
      max_line_bytes: Math.min(1024 * 1024, Math.floor(input.max_bytes / 2)),
      skip_oversized: old?.skipping_oversize,
      signal,
    })) {
      if (line.kind === "incomplete") {
        pendingTail = {
          byte_start: line.byte_start,
          byte_end: line.byte_end,
          line_number: line.line_number,
          code: line.code,
        };
        break;
      }
      readOffset = line.byte_end;
      lineNumber = line.line_number + 1;
      if (line.kind === "issue") {
        gaps++;
        lastIssue = {
          byte_start: line.byte_start,
          byte_end: line.byte_end,
          line_number: line.line_number,
          code: line.code,
        };
        issues.push(lastIssue);
        if (line.continuation) {
          skipping_oversize = true;
          lineNumber = line.line_number;
          pendingTail = {
            ...lastIssue,
            code: readOffset < stat.size ? "budget_exhausted" : "pending_write",
          };
        }
        continue;
      }
      if (line.kind !== "record") continue;
      const normalized = normalizeHistoryRecord(
        source.adapter,
        line.value,
        adapter,
        line,
      );
      if (
        normalized.coverage === "unknown" ||
        normalized.warnings.some(
          (w) => w.startsWith("unsupported_content") || w.endsWith("exceeded"),
        )
      ) {
        gaps++;
        lastIssue = {
          byte_start: line.byte_start,
          byte_end: line.byte_end,
          line_number: line.line_number,
          code: redact(
            normalized.warnings[0] ?? "unknown_format",
            this.patterns,
          ).slice(0, 200),
        };
        issues.push(lastIssue);
      }
      for (const warning of normalized.warnings)
        if (warnings.size < 100)
          warnings.add(redact(warning, this.patterns).slice(0, 200));
      for (const event of normalized.events)
        events.push(redactValue(event, this.patterns) as HistoryEvent);
    }
    const consumed_hash = await digestPrefix(filename, readOffset);
    if (old)
      invariant(
        old.consumed_hash === (await digestPrefix(filename, offset)),
        "source_changed",
        "History changed during collection; retry from checkpoint",
      );
    const after = await lstat(filename);
    invariant(
      `${after.dev}:${after.ino}:${after.birthtimeMs}` === identity &&
        after.size >= readOffset &&
        after.mtimeMs === stat.mtimeMs,
      "source_changed",
      "History was replaced during collection",
    );
    const checkpoint: FileState = {
      adapter,
      segmenter: old?.segmenter ?? {
        context: [],
        summary: "",
        summary_hash: hash(""),
      },
      line_number: lineNumber,
      read_offset: readOffset,
      consumed_hash,
      file_identity: identity,
      observed_size: after.size,
      mtime_ms: after.mtimeMs,
      gaps,
      warnings: [...warnings],
      last_issue: lastIssue,
      pending_tail: pendingTail,
      project_hint: adapter.cwd,
      unavailable: false,
      skipping_oversize,
    };
    const result = await this.store.write(
      {
        idempotency_key: id(),
        actor: "history",
        reason: "Commit redacted segments and collection checkpoint atomically",
      },
      {
        operation: "history.collect",
        sourceId,
        generation,
        offset,
        readOffset,
        consumed_hash,
      },
      async (tx) => {
        if (previous) {
          const actual = await tx
            .selectFrom("source_sessions")
            .select("metadata")
            .where("id", "=", sourceId)
            .executeTakeFirstOrThrow();
          invariant(
            actual.metadata === previous.metadata,
            "checkpoint_changed",
            "Another collector advanced the source; retry",
          );
        } else {
          const concurrent = await tx
            .selectFrom("source_sessions")
            .select("id")
            .where("root_id", "=", root_id)
            .where("external_id", "=", external_id)
            .where("source_path", "=", filename)
            .where("generation", "!=", "excluded")
            .execute();
          invariant(
            concurrent.every((c) => candidates.some((p) => p.id === c.id)),
            "checkpoint_changed",
            "Another collector discovered this source; retry",
          );
        }
        if (!previous)
          await tx
            .insertInto("source_sessions")
            .values({
              id: sourceId,
              root_id,
              external_id,
              generation,
              source_path: filename,
              metadata: "{}",
              coverage: "pending",
              created_at: now(),
            })
            .execute();
        const segmenter = new ContextSegmenter(
          input.segment_chars,
          checkpoint.segmenter,
          CURRENT_ANALYSIS_VERSION,
          this.config.privacy?.version ?? "1",
        );
        const pending: Array<{ event: HistoryEvent; key: string }> = [];
        let replayed = 0;
        const seen = new Set<string>();
        for (const event of events) {
          const key = hash(
            canonical({
              adapter: source.adapter,
              external_id,
              event_id: event.event_id,
              content: hash(event.text),
              privacy: this.config.privacy?.version ?? "1",
            }),
          );
          if (
            seen.has(key) ||
            (await tx
              .selectFrom("history_event_receipts")
              .select("replay_key")
              .where("replay_key", "=", key)
              .executeTakeFirst())
          ) {
            replayed++;
            continue;
          }
          seen.add(key);
          pending.push({ event, key });
        }
        const segments = pending.flatMap((p) => segmenter.push(p.event));
        const tail = segmenter.flush();
        if (tail) segments.push(tail);
        const segmentIds = new Map<string, string>();
        for (const segment of segments) {
          const segment_id = id();
          // Bounded excerpts are retained; the full redacted primary text is rebuilt from read-only locators on demand.
          const context = canonical({
            adapter: source.adapter,
            external_id,
            fingerprint: segment.fingerprint,
            summary_hash: segment.summary_hash,
            summary_version: segment.summary_version,
            project_hints: segment.project_hints,
            analysis_version: segment.analysis_version,
            privacy_version: segment.privacy_version,
            events: segment.event_ids,
            ranges: segment.ranges,
            adjacent: decodeJson(segment.context),
            primary_chars: segment.excerpt.length,
            primary_truncated: segment.excerpt.length > 1500,
          });
          await tx
            .insertInto("source_segments")
            .values({
              id: segment_id,
              session_id: sourceId,
              logical_key: `${String(segment.ranges[0]!.byte_start).padStart(16, "0")}:${String(segment.ranges[0]!.char_start ?? 0).padStart(8, "0")}:${segment.logical_key}`,
              content_hash: segment.content_hash,
              excerpt: boundedText(segment.excerpt, 1500),
              context,
              analysis_version: segment.analysis_version,
              privacy_version: segment.privacy_version,
              created_at: now(),
            })
            .execute();
          await tx
            .insertInto("segment_tasks")
            .values({
              id: id(),
              segment_id,
              analysis_version: segment.analysis_version,
              status: "pending",
              owner_token: null,
              lease_until: 0,
              attempts: 0,
              result: null,
              updated_at: now(),
            })
            .execute();
          for (const eventId of segment.event_ids)
            segmentIds.set(eventId, segment_id);
        }
        for (const receipt of pending) {
          const resolved =
            segmentIds.get(receipt.event.event_id) ??
            [...segmentIds].find(([eventId]) =>
              eventId.startsWith(`${receipt.event.event_id}:chars:`),
            )?.[1];
          invariant(
            resolved,
            "missing_event_segment",
            "Every collected event must have a durable segment",
          );
          await tx
            .insertInto("history_event_receipts")
            .values({ replay_key: receipt.key, segment_id: resolved })
            .onConflict((oc) => oc.column("replay_key").doNothing())
            .execute();
        }
        checkpoint.segmenter = segmenter.checkpoint();
        for (const issue of issues)
          await tx
            .insertInto("history_source_issues")
            .values({
              id: id(),
              source_id: sourceId,
              ...issue,
              created_at: now(),
            })
            .onConflict((oc) =>
              oc
                .columns(["source_id", "byte_start", "byte_end", "code"])
                .doNothing(),
            )
            .execute();
        await tx
          .updateTable("source_sessions")
          .set({
            root_id,
            source_path: filename,
            metadata: canonical(redactValue(checkpoint, this.patterns)),
            coverage: gaps ? "partial" : pendingTail ? "waiting" : "collected",
          })
          .where("id", "=", sourceId)
          .execute();
        await tx
          .insertInto("checkpoints")
          .values({
            source_id: sourceId,
            generation,
            read_offset: readOffset,
            metadata: canonical({
              line_number: lineNumber,
              segmented_offset: readOffset,
              summary_hash: checkpoint.segmenter.summary_hash,
            }),
            updated_at: now(),
          })
          .onConflict((oc) =>
            oc.column("source_id").doUpdateSet({
              read_offset: readOffset,
              metadata: canonical({
                line_number: lineNumber,
                segmented_offset: readOffset,
                summary_hash: checkpoint.segmenter.summary_hash,
              }),
              updated_at: now(),
            }),
          )
          .execute();
        return { segments: segments.length, replayed };
      },
    );
    return {
      ...result,
      bytes: readOffset - offset,
      gaps: gaps - (old?.gaps ?? 0),
      more: pendingTail?.code === "budget_exhausted" && !signal?.aborted,
    };
  }
  async freshness(db: Db = this.store.db) {
    const statuses = await db
      .selectFrom("segment_tasks")
      .select(["status"])
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .groupBy("status")
      .execute();
    const counts = Object.fromEntries(
      statuses.map((s) => [s.status, Number(s.count)]),
    );
    const latest = await db
      .selectFrom("jobs")
      .select(["status", "result", "updated_at"])
      .where("kind", "=", "history_sync")
      .orderBy("updated_at", "desc")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const scan = latest?.result
      ? decodeJson<Partial<Collection>>(latest.result)
      : {};
    const sources = await db
      .selectFrom("source_sessions")
      .select(["coverage"])
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .groupBy("coverage")
      .execute();
    const discovery = await db
      .selectFrom("history_discovery_issues")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    const discovery_gaps = Number(discovery.count);
    return {
      observed_at: now(),
      fresh_through: latest?.status === "completed" ? latest.updated_at : null,
      pending_segments:
        (counts.pending ?? 0) + (counts.running ?? 0) + (counts.failed ?? 0),
      committed_segments:
        (counts.committed ?? 0) +
        (counts.no_findings ?? 0) +
        (counts.candidate ?? 0),
      failed_segments: counts.failed ?? 0,
      collection_status: latest?.status ?? "not_started",
      collection_gaps: scan.gaps ?? 0,
      discovery_gaps,
      unavailable_roots_or_files: scan.unavailable ?? 0,
      source_coverage: Object.fromEntries(
        sources.map((s) => [s.coverage, Number(s.count)]),
      ),
      complete:
        latest?.status === "completed" &&
        discovery_gaps === 0 &&
        (scan.gaps ?? 0) === 0 &&
        (scan.unavailable ?? 0) === 0 &&
        (counts.pending ?? 0) + (counts.running ?? 0) + (counts.failed ?? 0) ===
          0 &&
        sources.every((s) => ["collected", "excluded"].includes(s.coverage)),
    };
  }
  async status(raw: unknown) {
    const input = syncStatusSchema.parse(raw),
      scope = hash(
        canonical({ operation: "sync.status", root_id: input.root_id }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("source_sessions")
      .selectAll()
      .orderBy("id")
      .limit(input.limit + 1);
    if (input.root_id) query = query.where("root_id", "=", input.root_id);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query.execute(),
      hasMore = rows.length > input.limit;
    return {
      job: input.job_id ? await this.jobs.get(input.job_id) : undefined,
      analysis: await this.freshness(),
      sources: rows.slice(0, input.limit).map((row) => {
        const state = decodeJson<Partial<FileState>>(row.metadata);
        return {
          id: row.id,
          root_id: row.root_id,
          external_id: row.external_id,
          generation: row.generation,
          coverage: row.coverage,
          read_offset: state.read_offset,
          gaps: state.gaps,
          last_issue: state.last_issue,
          pending_tail: state.pending_tail,
          warnings: state.warnings,
          client_version: state.adapter?.client_version,
        };
      }),
      next_cursor: hasMore
        ? makeCursor(rows[input.limit - 1]!.id, now(), scope)
        : null,
    };
  }
  async issues(raw: unknown) {
    const input = pageSchema.extend({ source_id: uuid }).strict().parse(raw),
      scope = hash(
        canonical({ operation: "history.issues", source_id: input.source_id }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("history_source_issues")
      .selectAll()
      .where("source_id", "=", input.source_id)
      .orderBy("id")
      .limit(input.limit + 1);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query.execute();
    return {
      items: rows.slice(0, input.limit),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.id, now(), scope)
          : null,
    };
  }
  async discoveryIssues(raw: unknown) {
    const input = pageSchema.extend({ root_id: uuid }).strict().parse(raw),
      scope = hash(
        canonical({
          operation: "history.discovery.issues",
          root_id: input.root_id,
        }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("history_discovery_issues")
      .selectAll()
      .where("root_id", "=", input.root_id)
      .orderBy("path_hash")
      .limit(input.limit + 1);
    if (cursor) query = query.where("path_hash", ">", cursor.last);
    const rows = await query.execute();
    return {
      items: rows.slice(0, input.limit),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.path_hash, now(), scope)
          : null,
    };
  }
}
