import {
  mkdir,
  writeFile,
  appendFile,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Analysis,
  HistoryIngestion,
  canonical,
  id,
  hash,
} from "@bug-manager/core";
import type { Config } from "@bug-manager/core";
import { fixture, mutation, standard, bug } from "../helpers.js";

const codex = (messages: string[], session = "synthetic-session") =>
  [
    {
      type: "session_meta",
      payload: { id: session, cwd: "/synthetic/project" },
    },
    ...messages.map((text, i) => ({
      type: "response_item",
      payload: {
        type: "message",
        id: `message-${i}`,
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "input_text", text }],
      },
    })),
  ]
    .map(canonical)
    .join("\n") + "\n";
const codexMessages = (
  messages: Array<{ role: "user" | "assistant" | "tool"; text: string }>,
  session = "synthetic-session",
) =>
  [
    {
      type: "session_meta",
      payload: { id: session, cwd: "/synthetic/project" },
    },
    ...messages.map((message, i) => ({
      type: "response_item",
      payload: {
        type: "message",
        id: `message-${i}`,
        role: message.role,
        content: [{ type: "input_text", text: message.text }],
      },
    })),
  ]
    .map(canonical)
    .join("\n") + "\n";
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} history/analysis transaction`, () => {
    let f: Awaited<ReturnType<typeof fixture>>,
      config: Config,
      ingestion: HistoryIngestion,
      analysis: Analysis,
      filename: string,
      typeId: string;
    beforeEach(async () => {
      f = await fixture(backend);
      const root = path.join(f.directory, "history");
      await mkdir(root);
      filename = path.join(root, "synthetic.jsonl");
      config = {
        database: f.database,
        evidence_dir: path.join(f.directory, "evidence"),
        history: [{ adapter: "codex", path: root, exclude: [] }],
        schema_version: 1,
      };
      ingestion = new HistoryIngestion(f.store, config);
      analysis = new Analysis(f.store, config);
      typeId = (await f.type("并发")).id;
    });
    afterEach(async () => {
      await f?.cleanup();
    });
    async function collect(input: unknown = {}) {
      const job = await ingestion.start(input, mutation());
      return ingestion.resume({ job_id: job.job_id }, mutation());
    }
    async function owned() {
      const claim = await analysis.claim({}, mutation());
      expect(claim).not.toBeNull();
      return { task_id: claim!.task_id, owner_token: claim!.owner_token };
    }
    it("HIS-005 replays a completed resume response without claiming the next batch", async () => {
      await writeFile(filename, codex(["one"]));
      await writeFile(
        path.join(path.dirname(filename), "two.jsonl"),
        codex(["two"], "two"),
      );
      const job = await ingestion.start({ max_files: 1 }, mutation()),
        meta = mutation();
      const first = await ingestion.resume({ job_id: job.job_id }, meta);
      expect(first.status).toBe("pending");
      const before = await ingestion.jobs.get(job.job_id);
      expect(await ingestion.resume({ job_id: job.job_id }, meta)).toEqual(
        first,
      );
      expect((await ingestion.jobs.get(job.job_id)).attempts).toBe(
        before.attempts,
      );
      expect(
        (await ingestion.resume({ job_id: job.job_id }, mutation())).status,
      ).toBe("completed");
      expect(await ingestion.resume({ job_id: job.job_id }, meta)).toEqual(
        first,
      );
      await expect(
        ingestion.resume(
          { job_id: job.job_id },
          { ...meta, reason: "different" },
        ),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    });
    it("HIS-005 resumes an interrupted public request after its work lease expires", async () => {
      await writeFile(filename, codex(["one"]));
      const job = await ingestion.start({}, mutation()),
        meta = mutation();
      await f.store.begin(
        meta,
        { operation: "sync.resume", job_id: job.job_id },
        async (tx) => {
          await tx
            .updateTable("jobs")
            .set({
              status: "running",
              owner_token: id(),
              lease_until: Date.now() - 1,
            })
            .where("id", "=", job.job_id)
            .execute();
          return { interrupted: true };
        },
      );
      const other = await ingestion.start({}, mutation());
      await expect(
        ingestion.resume({ job_id: other.job_id }, meta),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const result = await ingestion.resume({ job_id: job.job_id }, meta);
      expect(result).toMatchObject({
        status: "completed",
        collection: { new_segments: 1 },
      });
      expect(await ingestion.resume({ job_id: job.job_id }, meta)).toEqual(
        result,
      );
    });
    it("HIS-007 preserves discovery gaps across pages and clears them only after a full rescan", async () => {
      const root = path.dirname(filename),
        link = path.join(root, "a-link");
      await symlink(
        f.directory,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeFile(filename, codex(["one"]));
      await writeFile(path.join(root, "z.jsonl"), codex(["two"], "two"));
      const job = await ingestion.start({ max_files: 1 }, mutation());
      expect(
        (await ingestion.resume({ job_id: job.job_id }, mutation())).status,
      ).toBe("pending");
      expect(
        (await ingestion.resume({ job_id: job.job_id }, mutation())).status,
      ).toBe("completed");
      expect(await ingestion.freshness()).toMatchObject({
        collection_gaps: 0,
        discovery_gaps: 1,
        complete: false,
      });
      const sourceRoot = await f.store.db
        .selectFrom("source_roots")
        .select("id")
        .executeTakeFirstOrThrow();
      const issues = await ingestion.discoveryIssues({
        root_id: sourceRoot.id,
      });
      expect(issues.items).toHaveLength(1);
      expect(issues.items[0]!.code).toBe("symlink_excluded");
      expect(canonical(issues)).not.toContain(link);
      await rm(link);
      await collect();
      expect((await ingestion.freshness()).discovery_gaps).toBe(0);
    });
    it("HIS-007 checks missing-source coverage beyond the first thousand sessions", async () => {
      const job = await ingestion.start({}, mutation());
      const root = await f.store.db
        .selectFrom("source_roots")
        .select("id")
        .executeTakeFirstOrThrow();
      await f.store.db.transaction().execute(async (tx) => {
        for (let offset = 0; offset < 1001; offset += 100)
          await tx
            .insertInto("source_sessions")
            .values(
              Array.from({ length: Math.min(100, 1001 - offset) }, (_, i) => ({
                id: id(),
                root_id: root.id,
                external_id: `missing-${offset + i}`,
                generation: id(),
                source_path: path.join(
                  f.directory,
                  `absent-${offset + i}.jsonl`,
                ),
                metadata: "{}",
                coverage: "collected",
                created_at: new Date().toISOString(),
              })),
            )
            .execute();
      });
      await ingestion.resume({ job_id: job.job_id }, mutation());
      expect((await ingestion.freshness()).source_coverage).toMatchObject({
        unavailable: 1001,
      });
    }, 60000);
    it("HIS-003 exposes both sides of a boundary and preserves summary dependencies", async () => {
      await writeFile(
        filename,
        codex([
          "symptom observed: repeated business effects",
          "cause confirmed: missing uniqueness guard",
        ]),
      );
      await collect({ segment_chars: 64 });
      const segments = await f.store.db
        .selectFrom("source_segments")
        .selectAll()
        .orderBy("logical_key")
        .execute();
      expect(segments).toHaveLength(2);
      const first = await analysis.claim(
          { segment_id: segments[0]!.id },
          mutation(),
        ),
        second = await analysis.claim(
          { segment_id: segments[1]!.id },
          mutation(),
        );
      const a = await analysis.context({
          task_id: first!.task_id,
          owner_token: first!.owner_token,
        }),
        b = await analysis.context({
          task_id: second!.task_id,
          owner_token: second!.owner_token,
        });
      expect(a.source.next?.excerpt).toContain("cause confirmed");
      expect(canonical(b.source.adjacent)).toContain("symptom observed");
      expect(b.summary_hash).not.toBe(a.summary_hash);
      expect(b.source.previous?.segment_id).toBe(segments[0]!.id);
      const lease = {
          task_id: second!.task_id,
          owner_token: second!.owner_token,
        },
        retrieved = await analysis.context({ ...lease, type_ids: [typeId] });
      const submitted = await analysis.submit(
        {
          ...lease,
          outcome: "proposal",
          reason: "Connect the bounded symptom and cause sources",
          retrieval_id: (retrieved.retrieval as { retrieval_id: string })
            .retrieval_id,
          proposal: {
            standards: [
              {
                ref: "s",
                record: standard([typeId], {
                  confidence: {
                    assessment: "supported",
                    reason:
                      "Explicit symptom in previous segment with cause here",
                    evidence: [
                      {
                        segment_id: segments[0]!.id,
                        kind: "observation",
                        excerpt: "symptom observed: repeated business effects",
                      },
                    ],
                  },
                }),
              },
            ],
          },
        },
        mutation(),
      );
      expect(submitted.status).toBe("committed");
      expect(
        await f.store.db.selectFrom("provenance_links").select("id").execute(),
      ).toHaveLength(2);
    });
    it("PRJ-002 attributes each segment using its own directory evidence when a session changes projects", async () => {
      const firstDirectory = path.join(f.directory, "project-one"),
        secondDirectory = path.join(f.directory, "project-two");
      const firstProject = await f.projects.register(
        { name: "first project", directory: firstDirectory },
        mutation(),
      );
      await f.projects.register(
        { name: "second project", directory: secondDirectory },
        mutation(),
      );
      await writeFile(
        filename,
        [
          {
            type: "session_meta",
            payload: { id: "multi-project", cwd: firstDirectory },
          },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "first project observation is recorded here",
            },
          },
          { type: "turn_context", payload: { cwd: secondDirectory } },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "second project observation is recorded here",
            },
          },
        ]
          .map(canonical)
          .join("\n") + "\n",
      );
      await collect({ segment_chars: 64 });
      const segment = await f.store.db
          .selectFrom("source_segments")
          .select("id")
          .orderBy("logical_key")
          .limit(1)
          .executeTakeFirstOrThrow(),
        claim = await analysis.claim({ segment_id: segment.id }, mutation());
      expect(
        (
          await analysis.context({
            task_id: claim!.task_id,
            owner_token: claim!.owner_token,
          })
        ).project,
      ).toMatchObject({ status: "mapped", project: { id: firstProject.id } });
    });
    it("HIS-006 paginates discovery deterministically, advances over oversized corruption, and exposes every gap", async () => {
      const root = config.history[0]!.path;
      await mkdir(path.join(root, "a"));
      await writeFile(
        path.join(root, "a", "nested.jsonl"),
        codex(["nested"], "nested"),
      );
      await writeFile(path.join(root, "a.jsonl"), codex(["flat"], "flat"));
      const job = await ingestion.start(
        { max_files: 1, max_bytes: 1024 },
        mutation(),
      );
      let status = "pending";
      for (let attempt = 0; attempt < 8 && status === "pending"; attempt++)
        status = (await ingestion.resume({ job_id: job.job_id }, mutation()))
          .status;
      expect(status).toBe("completed");
      expect(
        await f.store.db.selectFrom("source_sessions").select("id").execute(),
      ).toHaveLength(2);
      await writeFile(
        filename,
        codex([], "oversized") +
          "x".repeat(3000) +
          "\nbad-json\n" +
          canonical({ type: "future_record" }) +
          "\n" +
          canonical({
            type: "event_msg",
            payload: { type: "user_message", message: "after corruption" },
          }) +
          "\n",
      );
      const corrupted = await ingestion.start({ max_bytes: 1024 }, mutation());
      status = "pending";
      for (let attempt = 0; attempt < 12 && status === "pending"; attempt++)
        status = (
          await ingestion.resume({ job_id: corrupted.job_id }, mutation())
        ).status;
      expect(status).toBe("completed");
      const session = await f.store.db
        .selectFrom("source_sessions")
        .selectAll()
        .where("external_id", "=", "oversized")
        .executeTakeFirstOrThrow();
      const issues = await ingestion.issues({
        source_id: session.id,
        limit: 200,
      });
      expect(issues.items.some((i) => i.code === "invalid_json")).toBe(true);
      expect(
        issues.items.some((i) => i.code.startsWith("unknown_record_type")),
      ).toBe(true);
      const segments = await f.store.db
        .selectFrom("source_segments")
        .select("excerpt")
        .where("session_id", "=", session.id)
        .execute();
      expect(canonical(segments)).toContain("after corruption");
      expect((await ingestion.freshness()).complete).toBe(false);
    });
    it("ANA-007 creates explicit analysis versions, preserves earlier results, and applies new exclusions before context access", async () => {
      await writeFile(filename, codex(["preserved source"]));
      await collect();
      const first = await owned();
      await analysis.submit(
        { ...first, outcome: "no_findings", reason: "first strategy" },
        mutation(),
      );
      await analysis.reanalyze({ analysis_version: "strategy-2" }, mutation());
      await analysis.reanalyze({ analysis_version: "strategy-2" }, mutation());
      expect(
        await f.store.db.selectFrom("segment_tasks").selectAll().execute(),
      ).toHaveLength(2);
      const second = await owned();
      expect((await analysis.context(second)).analysis_version).toBe(
        "strategy-2",
      );
      config.history[0]!.exclude = ["session:synthetic-session"];
      await expect(analysis.context(second)).rejects.toMatchObject({
        code: "source_excluded",
      });
      expect(
        await f.store.db
          .selectFrom("segment_tasks")
          .selectAll()
          .where("status", "=", "no_findings")
          .execute(),
      ).toHaveLength(1);
    });
    it("HIS-004 distinguishes collection from analysis and commits no-findings exactly once", async () => {
      await writeFile(filename, codex(["normal conversation"]));
      const before = hash(await readFile(filename));
      const sync = await collect();
      expect(sync).toMatchObject({
        status: "completed",
        analysis: { pending_segments: 1, complete: false },
      });
      const claim = await owned(),
        context = await analysis.context(claim);
      expect(context.source.primary).toContain("normal conversation");
      expect(context.source.trust).toBe("untrusted_historical_data");
      const meta = mutation(),
        input = {
          ...claim,
          outcome: "no_findings",
          reason: "No concrete failure or new criterion",
        };
      const first = await analysis.submit(input, meta);
      expect(await analysis.submit(input, meta)).toEqual(first);
      expect(await ingestion.freshness()).toMatchObject({
        pending_segments: 0,
        committed_segments: 1,
        complete: true,
      });
      expect(await analysis.claim({}, mutation())).toBeNull();
      await collect();
      expect(hash(await readFile(filename))).toBe(before);
      expect(
        await f.store.db.selectFrom("source_segments").selectAll().execute(),
      ).toHaveLength(1);
    });
    it("HIS-006 resumes UTF-8 tails, detects interior replacement, retains old segments and deduplicates replay", async () => {
      const source = codex([
          "observed duplicate operation",
          "cause " + "x".repeat(9000),
        ]),
        bytes = Buffer.from(source);
      await writeFile(filename, bytes.subarray(0, bytes.length - 3));
      await collect();
      expect(await ingestion.freshness()).toMatchObject({
        source_coverage: { waiting: 1 },
      });
      await appendFile(filename, bytes.subarray(bytes.length - 3));
      await collect();
      const before = await f.store.db
        .selectFrom("source_segments")
        .select("id")
        .execute();
      expect(before.length).toBeGreaterThan(1);
      await writeFile(
        filename,
        source.replace(
          "observed duplicate operation",
          "observed duplicate operation changed",
        ),
      );
      const result = await collect();
      expect(result).toMatchObject({
        collection: { replayed_events: 1, new_segments: 1 },
      });
      expect(
        await f.store.db.selectFrom("source_sessions").select("id").execute(),
      ).toHaveLength(2);
      const after = await f.store.db
        .selectFrom("source_segments")
        .select("id")
        .execute();
      expect(before.every((b) => after.some((a) => a.id === b.id))).toBe(true);
      await writeFile(
        filename,
        codex(["observed duplicate operation changed"]),
      );
      expect(await collect()).toMatchObject({
        collection: { replayed_events: 1, new_segments: 0 },
      });
      expect(
        await f.store.db.selectFrom("source_sessions").select("id").execute(),
      ).toHaveLength(3);
    });
    it("HIS-002 recognizes archive movement across roots without duplicate sessions or segments", async () => {
      await writeFile(filename, codex(["stable conversation"]));
      await collect();
      const archived = path.join(f.directory, "archive");
      await mkdir(archived);
      await rename(filename, path.join(archived, "renamed.jsonl"));
      config.history.push({ adapter: "codex", path: archived, exclude: [] });
      ingestion = new HistoryIngestion(f.store, config);
      await collect();
      expect(
        await f.store.db.selectFrom("source_sessions").selectAll().execute(),
      ).toHaveLength(1);
      expect(
        await f.store.db.selectFrom("source_segments").selectAll().execute(),
      ).toHaveLength(1);
    });
    it("ANA-004 excludes sessions without persisting contents and redacts source/knowledge/audit", async () => {
      const secret = "sk-syntheticSecret1234567890";
      config.history[0]!.exclude = ["session:excluded-session"];
      await writeFile(filename, codex([secret], "excluded-session"));
      await collect();
      expect(
        await f.store.db.selectFrom("source_segments").selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await f.store.db.selectFrom("source_sessions").selectAll().execute(),
      ).toMatchObject([{ coverage: "excluded", metadata: "{}" }]);
      await writeFile(
        path.join(config.history[0]!.path, "other.jsonl"),
        codex([`Concrete duplicate effect ${secret}`], "allowed-session"),
      );
      await collect();
      const claim = await owned(),
        context = await analysis.context({ ...claim, type_ids: [typeId] });
      expect(context.source.primary).not.toContain(secret);
      const receipt = context.retrieval as { retrieval_id: string };
      const proposal = {
        standards: [
          {
            ref: "s",
            record: standard([typeId], {
              title: `Avoid ${secret}`,
              confidence: {
                assessment: "supported" as const,
                reason: "source observation",
                evidence: [
                  {
                    kind: "observation" as const,
                    excerpt: "Concrete duplicate effect",
                  },
                ],
              },
            }),
          },
        ],
      };
      await analysis.submit(
        {
          ...claim,
          outcome: "proposal",
          reason: "Extract prevention knowledge",
          retrieval_id: receipt.retrieval_id,
          proposal,
        },
        mutation(),
      );
      for (const table of [
        "source_segments",
        "source_sessions",
        "standard_revisions",
        "mutation_records",
      ] as const)
        expect(
          canonical(await f.store.db.selectFrom(table).selectAll().execute()),
        ).not.toContain(secret);
    });
    it("ANA-001 atomically creates a Bug and an independently reusable standard; invalid links roll back progress", async () => {
      await writeFile(
        filename,
        codex(["Repeated request produced two business effects"]),
      );
      await collect();
      const claim = await owned(),
        context = await analysis.context({ ...claim, type_ids: [typeId] });
      const receipt = context.retrieval as { retrieval_id: string };
      await expect(
        analysis.submit(
          {
            ...claim,
            outcome: "proposal",
            reason: "fixture",
            retrieval_id: receipt.retrieval_id,
            proposal: {
              standards: [{ ref: "s", record: standard([typeId]) }],
              links: [
                {
                  bug_ref: id(),
                  standard_ref: "s",
                  coverage_reason: "invalid bug",
                },
              ],
            },
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        await f.store.db.selectFrom("standards").selectAll().execute(),
      ).toHaveLength(0);
      expect(await ingestion.freshness()).toMatchObject({
        pending_segments: 1,
      });
      const input = {
        ...claim,
        outcome: "proposal",
        reason: "fixture",
        retrieval_id: receipt.retrieval_id,
        proposal: {
          bugs: [{ ref: "b", record: bug([typeId]) }],
          standards: [{ ref: "s", record: standard([typeId]) }],
          links: [
            {
              bug_ref: "b",
              standard_ref: "s",
              coverage_reason:
                "repeat scenario detects the observed duplicate effect",
            },
          ],
        },
      };
      const result = await analysis.submit(input, mutation());
      expect(result.status).toBe("committed");
      expect(
        await f.store.db.selectFrom("bugs").selectAll().execute(),
      ).toHaveLength(1);
      expect(
        await f.store.db.selectFrom("provenance_links").selectAll().execute(),
      ).toHaveLength(2);
      const std = await f.store.db
        .selectFrom("standards")
        .select("id")
        .executeTakeFirstOrThrow();
      await writeFile(
        path.join(config.history[0]!.path, "another.jsonl"),
        codex(
          ["Repeated request produced two business effects"],
          "second-session",
        ),
      );
      await collect();
      const second = await owned(),
        c = await analysis.context({ ...second, type_ids: [typeId] });
      await analysis.submit(
        {
          ...second,
          outcome: "proposal",
          reason: "Reuse existing standard",
          retrieval_id: (c.retrieval as { retrieval_id: string }).retrieval_id,
          proposal: {
            bugs: [
              {
                ref: "new-bug",
                record: bug([typeId], {
                  mechanism: "Concurrent callback missing request uniqueness",
                  title: "Callback duplicated rights",
                }),
              },
            ],
            links: [
              {
                bug_ref: "new-bug",
                standard_ref: std.id,
                coverage_reason: "shared prevention",
              },
            ],
          },
        },
        mutation(),
      );
      expect(
        await f.store.db.selectFrom("standards").selectAll().execute(),
      ).toHaveLength(1);
      expect(
        await f.store.db.selectFrom("bugs").selectAll().execute(),
      ).toHaveLength(2);
    });
    it("ANA-008 accepts direct human reports and findings from human-guided review", async () => {
      const direct = "人工发现：同一订单被创建了两次",
        guidance = "请检查重试同一请求时是否会生成重复订单",
        finding = "检查结果：重试同一请求确实生成了第二张订单";
      await writeFile(
        filename,
        codexMessages([
          { role: "user", text: direct },
          { role: "assistant", text: "收到，我会记录这个现象" },
          { role: "user", text: guidance },
          { role: "assistant", text: finding },
        ]),
      );
      await collect();
      const claim = await owned(),
        context = await analysis.context({ ...claim, type_ids: [typeId] }),
        retrieval = context.retrieval as { retrieval_id: string };
      const result = await analysis.submit(
        {
          ...claim,
          outcome: "proposal",
          reason: "Extract only human-origin discoveries",
          retrieval_id: retrieval.retrieval_id,
          proposal: {
            bugs: [
              {
                ref: "reported",
                record: bug([typeId], {
                  title: "人工观察到重复订单",
                  mechanism: "人工报告的重试导致重复订单",
                  confidence: {
                    assessment: "supported",
                    reason: "The user directly reported the duplicate effect",
                    evidence: [
                      {
                        kind: "observation",
                        excerpt: direct,
                      },
                    ],
                  },
                  discovery: {
                    origin: "human_reported",
                    evidence: [
                      { role: "user", kind: "human_report", excerpt: direct },
                    ],
                  },
                }),
              },
              {
                ref: "guided",
                record: bug([typeId], {
                  title: "人工引导检查发现重复回调",
                  mechanism: "人工要求检查后确认重复回调缺少幂等保护",
                  confidence: {
                    assessment: "supported",
                    reason:
                      "The Agent finding followed the user's review request",
                    evidence: [
                      {
                        kind: "observation",
                        excerpt: finding,
                      },
                    ],
                  },
                  discovery: {
                    origin: "human_guided_review",
                    evidence: [
                      {
                        role: "user",
                        kind: "human_guidance",
                        excerpt: guidance,
                      },
                      {
                        role: "assistant",
                        kind: "agent_finding",
                        excerpt: finding,
                      },
                    ],
                  },
                }),
              },
            ],
            standards: [
              {
                ref: "prevention",
                record: standard([typeId], {
                  title: "人工关注范围内的重复订单必须只产生一次效果",
                  mechanism: "人工报告或人工引导检查确认重复请求产生副作用",
                  confidence: {
                    assessment: "supported",
                    reason: "The user reported the effect and directed review",
                    evidence: [{ kind: "observation", excerpt: direct }],
                  },
                }),
              },
            ],
            links: [
              {
                bug_ref: "reported",
                standard_ref: "prevention",
                coverage_reason:
                  "The repeat scenario covers the reported effect",
              },
              {
                bug_ref: "guided",
                standard_ref: "prevention",
                coverage_reason: "The guided finding shares the same mechanism",
              },
            ],
          },
        },
        mutation(),
      );
      expect(result.status).toBe("committed");
      expect(
        await f.store.db.selectFrom("bugs").selectAll().execute(),
      ).toHaveLength(2);
    });
    it("ANA-008 verifies human evidence retained across a long adjacent tool event", async () => {
      const report = "人工发现：复杂页面里的标题字号比正文还小，层级不可辨。";
      await writeFile(
        filename,
        codexMessages([
          { role: "user", text: report },
          { role: "assistant", text: "我会按这个现象检查页面层级。" },
          { role: "tool", text: "中".repeat(7000) },
        ]),
      );
      await collect();
      const segments = await f.store.db
        .selectFrom("source_segments")
        .select(["id", "logical_key"])
        .orderBy("logical_key")
        .execute();
      expect(segments).toHaveLength(3);
      const claim = await analysis.claim(
          { segment_id: segments[1]!.id },
          mutation(),
        ),
        context = await analysis.context({
          task_id: claim!.task_id,
          owner_token: claim!.owner_token,
          type_ids: [typeId],
        }),
        retrieval = context.retrieval as { retrieval_id: string };
      expect(canonical(context.source.adjacent)).toContain(report);
      const result = await analysis.submit(
        {
          task_id: claim!.task_id,
          owner_token: claim!.owner_token,
          outcome: "proposal",
          reason: "Verify a report retained outside the primary segment",
          retrieval_id: retrieval.retrieval_id,
          proposal: {
            bugs: [
              {
                ref: "reported",
                record: bug([typeId], {
                  title: "复杂页面标题弱于正文",
                  confidence: {
                    assessment: "supported",
                    reason:
                      "The adjacent user message directly reports the defect",
                    evidence: [{ kind: "observation", excerpt: report }],
                  },
                  discovery: {
                    origin: "human_reported",
                    evidence: [
                      { role: "user", kind: "human_report", excerpt: report },
                    ],
                  },
                }),
              },
            ],
            standards: [
              {
                ref: "order",
                record: standard([typeId], {
                  confidence: {
                    assessment: "supported",
                    reason:
                      "A user report establishes the prevention requirement",
                    evidence: [{ kind: "observation", excerpt: report }],
                  },
                }),
              },
            ],
            links: [
              {
                bug_ref: "reported",
                standard_ref: "order",
                coverage_reason:
                  "Typography order directly prevents the reported defect",
              },
            ],
          },
        },
        mutation(),
      );
      expect(result.status).toBe("committed");
    });
    it("ANA-008 verifies human-guided findings after a multi-segment tool response", async () => {
      const guidance =
          "请检查两份历史中的前端反馈，重点看复杂编辑页和表格层级。",
        finding =
          "检查结果：复杂编辑页把字段定义和填写值混在同一编辑区，用户无法辨认各自职责。";
      await writeFile(
        filename,
        codexMessages([
          { role: "user", text: guidance },
          { role: "assistant", text: "我会读取两份历史并检查。" },
          ...Array.from({ length: 3 }, (_, index) => ({
            role: "tool" as const,
            text: `工具分页 ${index}：${"长输出".repeat(1200)}`,
          })),
          { role: "assistant", text: finding },
        ]),
      );
      await collect();
      const segments = await f.store.db
        .selectFrom("source_segments")
        .select(["id", "logical_key"])
        .orderBy("logical_key", "desc")
        .execute();
      const claim = await analysis.claim(
          { segment_id: segments[0]!.id },
          mutation(),
        ),
        context = await analysis.context({
          task_id: claim!.task_id,
          owner_token: claim!.owner_token,
          type_ids: [typeId],
        }),
        retrieval = context.retrieval as { retrieval_id: string };
      expect(canonical(context.source.adjacent)).toContain(guidance);
      const result = await analysis.submit(
        {
          task_id: claim!.task_id,
          owner_token: claim!.owner_token,
          outcome: "proposal",
          reason: "Verify human-guided evidence across long tool output",
          retrieval_id: retrieval.retrieval_id,
          proposal: {
            bugs: [
              {
                ref: "guided-editor",
                record: bug([typeId], {
                  title: "字段定义与填写值混在同一编辑区",
                  confidence: {
                    assessment: "supported",
                    reason:
                      "The user directed a review and the later Agent finding identified the concrete UI failure",
                    evidence: [{ kind: "observation", excerpt: finding }],
                  },
                  discovery: {
                    origin: "human_guided_review",
                    evidence: [
                      {
                        role: "user",
                        kind: "human_guidance",
                        excerpt: guidance,
                      },
                      {
                        role: "assistant",
                        kind: "agent_finding",
                        excerpt: finding,
                      },
                    ],
                  },
                }),
              },
            ],
          },
        },
        mutation(),
      );
      expect(["committed", "candidate"]).toContain(result.status);
      expect(
        await f.store.db.selectFrom("bugs").selectAll().execute(),
      ).toHaveLength(1);
    });
    it("ANA-008 rejects an Agent self-test Bug and a standard derived only from it", async () => {
      const finding =
        "Agent 自写测试失败：重复请求产生了第二张订单，但此前没有人工引导";
      await writeFile(
        filename,
        codexMessages([{ role: "assistant", text: finding }]),
      );
      await collect();
      const claim = await owned(),
        context = await analysis.context({ ...claim, type_ids: [typeId] }),
        retrieval = context.retrieval as { retrieval_id: string };
      await expect(
        analysis.submit(
          {
            ...claim,
            outcome: "proposal",
            reason: "Reject autonomous test finding",
            retrieval_id: retrieval.retrieval_id,
            proposal: {
              bugs: [
                {
                  ref: "autonomous",
                  record: bug([typeId], {
                    discovery: {
                      origin: "human_reported",
                      evidence: [
                        {
                          role: "user",
                          kind: "human_report",
                          excerpt: finding,
                        },
                      ],
                    },
                  }),
                },
              ],
            },
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "discovery_origin_unverified" });
      await expect(
        analysis.submit(
          {
            ...claim,
            outcome: "proposal",
            reason: "Reject standard derived only from autonomous test",
            retrieval_id: retrieval.retrieval_id,
            proposal: {
              standards: [
                {
                  ref: "autonomous-standard",
                  record: standard([typeId], {
                    confidence: {
                      assessment: "supported",
                      reason: "Agent test observed the failure",
                      evidence: [{ kind: "observation", excerpt: finding }],
                    },
                  }),
                },
              ],
            },
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "standard_origin_unverified" });
      expect(
        await f.store.db.selectFrom("bugs").selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await f.store.db.selectFrom("standards").selectAll().execute(),
      ).toHaveLength(0);
    });
    it("ANA-008 rejects forged roles and guidance that follows the finding", async () => {
      const finding = "检查结果：发现重复订单副作用",
        guidance = "请调查为什么会产生这个结果";
      await writeFile(
        filename,
        codexMessages([
          { role: "assistant", text: finding },
          { role: "user", text: guidance },
        ]),
      );
      await collect();
      const claim = await owned(),
        context = await analysis.context({ ...claim, type_ids: [typeId] }),
        retrieval = context.retrieval as { retrieval_id: string };
      await expect(
        analysis.submit(
          {
            ...claim,
            outcome: "proposal",
            reason: "Attempt to disguise an autonomous finding",
            retrieval_id: retrieval.retrieval_id,
            proposal: {
              bugs: [
                {
                  ref: "forged",
                  record: bug([typeId], {
                    discovery: {
                      origin: "human_guided_review",
                      evidence: [
                        {
                          role: "user",
                          kind: "human_guidance",
                          excerpt: guidance,
                        },
                        {
                          role: "assistant",
                          kind: "agent_finding",
                          excerpt: finding,
                        },
                      ],
                    },
                  }),
                },
              ],
            },
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "discovery_origin_unverified" });
      await expect(
        analysis.submit(
          {
            ...claim,
            outcome: "proposal",
            reason: "Attempt to forge the source role",
            retrieval_id: retrieval.retrieval_id,
            proposal: {
              bugs: [
                {
                  ref: "forged-role",
                  record: bug([typeId], {
                    discovery: {
                      origin: "human_reported",
                      evidence: [
                        {
                          role: "user",
                          kind: "human_report",
                          excerpt: finding,
                        },
                      ],
                    },
                  }),
                },
              ],
            },
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "discovery_origin_unverified" });
    });
    it("HIS-005 fences late owners and recovers abandoned analysis leases", async () => {
      await writeFile(filename, codex(["test"]));
      await collect();
      const first = await analysis.claim({ lease_ms: 10 }, mutation());
      await delay(30);
      const second = await owned();
      expect(second.owner_token).not.toBe(first!.owner_token);
      await expect(
        analysis.submit(
          {
            task_id: first!.task_id,
            owner_token: first!.owner_token,
            outcome: "no_findings",
            reason: "stale",
          },
          mutation(),
        ),
      ).rejects.toMatchObject({ code: "lease_lost" });
      await analysis.heartbeat(second, mutation());
      await analysis.submit(
        { ...second, outcome: "no_findings", reason: "complete" },
        mutation(),
      );
    });
    it("DED-006 rechecks concurrent candidates and routes the second new proposal to confirmation", async () => {
      await writeFile(
        filename,
        codex(["Repeated request produced two business effects"]),
      );
      await writeFile(
        path.join(config.history[0]!.path, "second.jsonl"),
        codex(
          ["Repeated request produced two business effects"],
          "other-session",
        ),
      );
      await collect();
      const first = await owned(),
        second = await owned(),
        a = await analysis.context({ ...first, type_ids: [typeId] }),
        b = await analysis.context({ ...second, type_ids: [typeId] });
      const make = (claim: typeof first, context: typeof a) => ({
        ...claim,
        outcome: "proposal",
        reason: "fixture",
        retrieval_id: (context.retrieval as { retrieval_id: string })
          .retrieval_id,
        proposal: { standards: [{ ref: "s", record: standard([typeId]) }] },
      });
      expect((await analysis.submit(make(first, a), mutation())).status).toBe(
        "committed",
      );
      expect((await analysis.submit(make(second, b), mutation())).status).toBe(
        "candidate",
      );
      expect(
        await f.store.db
          .selectFrom("standards")
          .selectAll()
          .where("disposition", "=", "active")
          .execute(),
      ).toHaveLength(1);
    });
    it("DED-004 exposes truncated summaries and cursor follow-up without treating a first page as global uniqueness", async () => {
      await f.catalog.apply(
        {
          standards: [0, 1, 2].map((index) => ({
            ref: `s${index}`,
            record: standard([typeId], {
              title: `Existing ${index}`,
              mechanism:
                `Long synthetic mechanism ${index} ` + "重试".repeat(500),
            }),
          })),
        },
        mutation(),
      );
      await writeFile(
        filename,
        codex(["Repeated request produced two business effects"]),
      );
      await collect();
      const claim = await owned(),
        context = await analysis.context({
          ...claim,
          type_ids: [typeId],
          limit: 1,
        }),
        retrieval = context.retrieval as {
          retrieval_id: string;
          coverage: { complete: boolean };
          "standard:active": {
            next_cursor: string;
            items: Array<{ mechanism: string; mechanism_truncated: boolean }>;
          };
        };
      expect(retrieval.coverage.complete).toBe(false);
      expect(retrieval["standard:active"].items[0]!.mechanism_truncated).toBe(
        true,
      );
      expect(
        retrieval["standard:active"].items[0]!.mechanism.length,
      ).toBeLessThanOrEqual(500);
      const page = await f.catalog.search("standard", {
        type_ids: [typeId],
        limit: 2,
        cursor: retrieval["standard:active"].next_cursor,
      });
      expect(page.items).toHaveLength(2);
      expect(page.next_cursor).toBeNull();
      const result = await analysis.submit(
        {
          ...claim,
          outcome: "proposal",
          reason: "First page is insufficient uniqueness evidence",
          retrieval_id: retrieval.retrieval_id,
          proposal: { standards: [{ ref: "new", record: standard([typeId]) }] },
        },
        mutation(),
      );
      expect(result.status).toBe("candidate");
    });
    it("HIS-007 retains source-unavailable coverage while serving the redacted excerpt", async () => {
      await writeFile(filename, codex(["retained necessary evidence"]));
      await collect();
      await rm(filename);
      await collect();
      const claim = await owned(),
        context = await analysis.context(claim);
      expect(context.source.availability).toBe(
        "source_unavailable_excerpt_only",
      );
      expect(context.source.primary).toContain("retained necessary evidence");
      expect((await ingestion.freshness()).complete).toBe(false);
    });
  });
