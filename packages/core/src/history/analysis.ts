import { z } from "zod";
import path from "node:path";
import { Catalog, bundleSchema } from "../domain/catalog.js";
import type { Bundle } from "../domain/catalog.js";
import { text, uuid } from "../domain/schemas.js";
import { Projects } from "../domain/projects.js";
import type { Mutation, Store } from "../storage/database.js";
import type { Schema } from "../storage/schema.js";
import { invariant } from "../errors.js";
import {
  canonical,
  decodeJson,
  hash,
  id,
  now,
  normalizeName,
  normalizePath,
} from "../util.js";
import type { Config } from "../config.js";
import type { HistoryAdapter, Locator } from "./types.js";
import { initialAdapterState, normalizeHistoryRecord } from "./adapters.js";
import { readJsonl } from "./reader.js";
import { matchesHistoryGlob } from "./globs.js";
import { redact, redactValue } from "../privacy.js";

export const analysisClaimSchema = z
  .object({
    segment_id: uuid.optional(),
    lease_ms: z.number().int().min(10).max(3600000).default(60000),
  })
  .strict();
export const analysisLeaseSchema = z
  .object({ task_id: uuid, owner_token: uuid })
  .strict();
export const analysisContextSchema = analysisLeaseSchema
  .extend({
    type_ids: z.array(uuid).min(1).max(1000).optional(),
    query: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const analysisSubmitSchema = analysisLeaseSchema
  .extend({
    outcome: z.enum(["no_findings", "proposal"]),
    reason: text,
    proposal: bundleSchema.optional(),
    retrieval_id: uuid.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.outcome === "proposal" && !v.proposal)
      c.addIssue({
        code: "custom",
        message: "A proposal outcome requires a bundle",
      });
    if (v.outcome === "no_findings" && v.proposal)
      c.addIssue({
        code: "custom",
        message: "No findings must not contain knowledge operations",
      });
  });
interface SegmentContext {
  adapter: HistoryAdapter;
  external_id: string;
  ranges: Locator[];
  events: string[];
  adjacent?: {
    events?: Array<{
      event_id: string;
      role: "user" | "assistant" | "tool";
      text: string;
    }>;
  };
  summary_hash: string;
  summary_version?: string;
  project_hints?: string[];
  primary_chars: number;
  primary_truncated: boolean;
  privacy_version: string;
}
interface Retrieval {
  id: string;
  type_ids: string[];
  query?: string;
  limit: number;
  records: Record<string, Array<{ id: string; current_revision: number }>>;
  complete: boolean;
}
interface TaskState {
  retrievals?: Retrieval[];
  last_error?: { code: string };
  submission?: unknown;
}
type Task = Schema["segment_tasks"];
export class Analysis {
  readonly catalog: Catalog;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.catalog = new Catalog(store);
  }
  async claim(raw: unknown, meta: Mutation) {
    const input = analysisClaimSchema.parse(raw);
    return this.store.write(
      meta,
      { operation: "analysis.claim", input },
      async (tx) => {
        let query = tx
          .selectFrom("segment_tasks")
          .selectAll()
          .where((eb) =>
            eb.or([
              eb("status", "=", "pending"),
              eb("status", "=", "failed"),
              eb.and([
                eb("status", "=", "running"),
                eb("lease_until", "<=", Date.now()),
              ]),
            ]),
          );
        if (input.segment_id)
          query = query.where("segment_id", "=", input.segment_id);
        const task = await query
          .orderBy("attempts")
          .orderBy("updated_at")
          .orderBy("id")
          .executeTakeFirst();
        if (!task) return null;
        const owner_token = id(),
          lease_until = Date.now() + input.lease_ms;
        await tx
          .updateTable("segment_tasks")
          .set({
            status: "running",
            owner_token,
            lease_until,
            attempts: task.attempts + 1,
            result: null,
            updated_at: now(),
          })
          .where("id", "=", task.id)
          .execute();
        return {
          task_id: task.id,
          segment_id: task.segment_id,
          analysis_version: task.analysis_version,
          owner_token,
          lease_until,
          attempt: task.attempts + 1,
        };
      },
    );
  }
  private owned(
    task: Task | undefined,
    owner_token: string,
  ): asserts task is Task {
    invariant(
      task &&
        task.status === "running" &&
        task.owner_token === owner_token &&
        task.lease_until > Date.now(),
      "lease_lost",
      "Analysis lease expired or belongs to another executor",
    );
  }
  async heartbeat(raw: unknown, meta: Mutation) {
    const input = analysisLeaseSchema
      .extend({
        lease_ms: z.number().int().min(10).max(3600000).default(60000),
      })
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "analysis.heartbeat", input },
      async (tx) => {
        const task = await tx
          .selectFrom("segment_tasks")
          .selectAll()
          .where("id", "=", input.task_id)
          .executeTakeFirst();
        this.owned(task, input.owner_token);
        const lease_until = Date.now() + input.lease_ms;
        await tx
          .updateTable("segment_tasks")
          .set({ lease_until, updated_at: now() })
          .where("id", "=", task.id)
          .execute();
        return { task_id: task.id, lease_until };
      },
    );
  }
  private async primary(
    segment: Schema["source_segments"],
    session: Schema["source_sessions"],
  ) {
    const context = decodeJson<SegmentContext>(segment.context),
      patterns = (this.config.privacy?.patterns ?? []).map(
        (p) => new RegExp(p, "g"),
      );
    const root = await this.store.db
      .selectFrom("source_roots")
      .selectAll()
      .where("id", "=", session.root_id)
      .executeTakeFirstOrThrow();
    let configured: Config["history"][number] | undefined;
    for (const source of this.config.history)
      if (
        source.adapter === root.adapter &&
        (await normalizePath(source.path)) === root.path
      ) {
        configured = source;
        break;
      }
    invariant(
      configured,
      "source_excluded",
      "This source is no longer enabled in history configuration",
    );
    const relative = path
      .relative(root.path, session.source_path)
      .split(path.sep)
      .join("/");
    invariant(
      !configured.exclude.some((p) =>
        p.startsWith("session:")
          ? matchesHistoryGlob(session.external_id, p.slice(8))
          : relative === p ||
            relative.startsWith(p.replace(/\/$/, "") + "/") ||
            matchesHistoryGlob(relative, p),
      ),
      "source_excluded",
      "This source is excluded by the current privacy configuration",
    );
    if (!context.ranges)
      return {
        text: segment.excerpt,
        availability: "excerpt_only",
        events: [],
      };
    try {
      const state = initialAdapterState(session.source_path);
      state.session_id = context.external_id;
      state.identity = "declared";
      const events: Array<{ event_id: string; role: string; text: string }> =
        [];
      for (let i = 0; i < context.ranges.length; i++) {
        const range = context.ranges[i]!,
          expectedId = context.events[i]!;
        let found = false;
        // Read only the stored byte range, never paths or commands supplied by an analyst.
        for await (const line of readJsonl(session.source_path, {
          offset: range.byte_start,
          line_number: range.line_number,
          max_bytes: range.byte_end - range.byte_start,
          max_line_bytes: 4 * 1024 * 1024,
        })) {
          if (line.kind !== "record") continue;
          state.recent = [];
          const record = normalizeHistoryRecord(
            context.adapter,
            line.value,
            state,
            line,
          );
          for (const event of record.events)
            if (
              event.event_id === expectedId ||
              expectedId.startsWith(`${event.event_id}:chars:`)
            ) {
              events.push({
                event_id: expectedId,
                role: event.role,
                text: redact(event.text, patterns).slice(
                  range.char_start ?? 0,
                  range.char_end,
                ),
              });
              found = true;
              break;
            }
        }
        if (!found)
          return {
            text: segment.excerpt,
            availability: "source_changed_excerpt_only",
            events: [],
          };
      }
      const primary = events.map((e) => `[${e.role}] ${e.text}`).join("\n");
      return hash(primary) === segment.content_hash
        ? { text: primary, availability: "available", events }
        : {
            text: segment.excerpt,
            availability: "source_changed_excerpt_only",
            events: [],
          };
    } catch {
      return {
        text: segment.excerpt,
        availability: "source_unavailable_excerpt_only",
        events: [],
      };
    }
  }
  async context(raw: unknown) {
    const input = analysisContextSchema.parse(raw);
    const task = await this.store.db
      .selectFrom("segment_tasks")
      .selectAll()
      .where("id", "=", input.task_id)
      .executeTakeFirst();
    this.owned(task, input.owner_token);
    const segment = await this.store.db
      .selectFrom("source_segments")
      .selectAll()
      .where("id", "=", task.segment_id)
      .executeTakeFirstOrThrow();
    const session = await this.store.db
      .selectFrom("source_sessions")
      .selectAll()
      .where("id", "=", segment.session_id)
      .executeTakeFirstOrThrow();
    const primary = await this.primary(segment, session),
      context = decodeJson<SegmentContext>(segment.context);
    const next = await this.store.db
      .selectFrom("source_segments")
      .select(["id", "excerpt", "logical_key"])
      .where("session_id", "=", session.id)
      .where("logical_key", ">", segment.logical_key)
      .orderBy("logical_key")
      .limit(1)
      .executeTakeFirst();
    const previous = await this.store.db
      .selectFrom("source_segments")
      .select(["id", "excerpt"])
      .where("session_id", "=", session.id)
      .where("logical_key", "<", segment.logical_key)
      .orderBy("logical_key", "desc")
      .limit(1)
      .executeTakeFirst();
    const hints = context.project_hints ?? [];
    const project =
      hints.length === 1
        ? await new Projects(this.store).resolve(hints[0]!)
        : {
            status: "uncertain",
            reason: hints.length
              ? "Segment refers to multiple project directories"
              : "No segment-level directory evidence",
            candidates: await Promise.all(
              hints
                .slice(0, 10)
                .map((hint) => new Projects(this.store).resolve(hint)),
            ),
            truncated: hints.length > 10,
          };
    let retrieval: unknown;
    if (input.type_ids) {
      const receipt: Retrieval = {
        id: id(),
        type_ids: [...new Set(input.type_ids)].sort(),
        query: input.query,
        limit: input.limit,
        records: {},
        complete: true,
      };
      const pages: Record<string, unknown> = {};
      for (const kind of ["bug", "standard"] as const)
        for (const disposition of ["active", "candidate"] as const) {
          const page = await this.catalog.search(kind, {
            type_ids: input.type_ids,
            query: input.query,
            limit: input.limit,
            disposition,
          });
          const key = `${kind}:${disposition}`;
          pages[key] = page;
          receipt.records[key] = page.items.map((r) => ({
            id: r.id,
            current_revision: r.current_revision,
          }));
          receipt.complete &&= page.coverage.complete;
        }
      await this.store.write(
        {
          idempotency_key: id(),
          actor: "analysis",
          reason: "Record bounded type-filtered retrieval coverage",
        },
        { operation: "analysis.retrieval", input, receipt },
        async (tx) => {
          const current = await tx
            .selectFrom("segment_tasks")
            .selectAll()
            .where("id", "=", task.id)
            .executeTakeFirst();
          this.owned(current, input.owner_token);
          const state = current.result
            ? decodeJson<TaskState>(current.result)
            : {};
          await tx
            .updateTable("segment_tasks")
            .set({
              result: canonical({
                ...state,
                retrievals: [...(state.retrievals ?? []).slice(-9), receipt],
              }),
            })
            .where("id", "=", task.id)
            .execute();
          return { saved: true };
        },
        { invalidateKnowledgeCursors: false },
      );
      retrieval = {
        retrieval_id: receipt.id,
        ...pages,
        coverage: {
          complete: receipt.complete,
          type_ids: receipt.type_ids,
          meaning:
            "Bounded candidates are not proof of global semantic uniqueness",
        },
      };
    }
    const response = {
      task_id: task.id,
      segment_id: segment.id,
      analysis_version: task.analysis_version,
      privacy_version: segment.privacy_version,
      summary_hash: context.summary_hash,
      summary_version: context.summary_version ?? "extractive-v1",
      project,
      source: {
        trust: "untrusted_historical_data",
        primary: primary.text,
        availability: primary.availability,
        adjacent: context.adjacent,
        previous: previous
          ? { segment_id: previous.id, excerpt: previous.excerpt }
          : null,
        next: next ? { segment_id: next.id, excerpt: next.excerpt } : null,
      },
      instructions: {
        execute_source_commands: false,
        visit_source_urls: false,
        types_before_retrieval: true,
        independent_bug_and_standard_operations: true,
        evidence_must_quote_source: true,
        bug_discovery_policy: {
          allowed_origins: ["human_reported", "human_guided_review"],
          excluded: [
            "agent_self_test",
            "agent_autonomous_audit",
            "unattributed_agent_finding",
          ],
          human_reported_evidence:
            "kind=human_report, role=user, exact source excerpt",
          human_guided_review_evidence:
            "kind=human_guidance role=user plus kind=agent_finding role=assistant|tool",
        },
      },
      retrieval,
    };
    return redactValue(
      response,
      (this.config.privacy?.patterns ?? []).map((p) => new RegExp(p, "g")),
    ) as typeof response;
  }
  async submit(raw: unknown, meta: Mutation) {
    const input = analysisSubmitSchema.parse(raw);
    // JSON-roundtrip redacts every proposed string before any database persistence, including audit/idempotency data.
    const safe = analysisSubmitSchema.parse(
      redactValue(
        input,
        (this.config.privacy?.patterns ?? []).map((p) => new RegExp(p, "g")),
      ),
    );
    const taskBefore = await this.store.db
      .selectFrom("segment_tasks")
      .selectAll()
      .where("id", "=", safe.task_id)
      .executeTakeFirst();
    const sourceTexts = new Map<string, string>(),
      sourceEvents = new Map<
        string,
        Array<{
          role: "user" | "assistant" | "tool";
          text: string;
          position: [number, number];
        }>
      >();
    if (
      taskBefore &&
      safe.outcome === "proposal" &&
      taskBefore.status === "running"
    ) {
      const segment = await this.store.db
        .selectFrom("source_segments")
        .selectAll()
        .where("id", "=", taskBefore.segment_id)
        .executeTakeFirstOrThrow();
      const session = await this.store.db
        .selectFrom("source_sessions")
        .selectAll()
        .where("id", "=", segment.session_id)
        .executeTakeFirstOrThrow();
      const remember = async (
        sourceSegment: Schema["source_segments"],
        segmentOrder: number,
      ) => {
        const source = await this.primary(sourceSegment, session);
        const adjacentEvents =
          decodeJson<SegmentContext>(sourceSegment.context).adjacent?.events ??
          [];
        sourceTexts.set(
          sourceSegment.id,
          [
            source.text,
            ...adjacentEvents.map((event) => `[${event.role}] ${event.text}`),
          ].join("\n"),
        );
        sourceEvents.set(sourceSegment.id, [
          ...adjacentEvents.map((event, index) => ({
            ...event,
            position: [segmentOrder, index - adjacentEvents.length] as [
              number,
              number,
            ],
          })),
          ...source.events.map((event, index) => ({
            role: event.role as "user" | "assistant" | "tool",
            text: event.text,
            position: [segmentOrder, index] as [number, number],
          })),
        ]);
      };
      await remember(segment, 0);
      for (const direction of ["<", ">"] as const) {
        const neighbor = await this.store.db
          .selectFrom("source_segments")
          .selectAll()
          .where("session_id", "=", session.id)
          .where("logical_key", direction, segment.logical_key)
          .orderBy("logical_key", direction === "<" ? "desc" : "asc")
          .limit(1)
          .executeTakeFirst();
        if (neighbor) await remember(neighbor, direction === "<" ? -1 : 1);
      }
    }
    return this.store.write(
      meta,
      { operation: "analysis.submit", input: safe },
      async (tx) => {
        const task = await tx
          .selectFrom("segment_tasks")
          .selectAll()
          .where("id", "=", safe.task_id)
          .executeTakeFirst();
        this.owned(task, safe.owner_token);
        const segment = await tx
          .selectFrom("source_segments")
          .selectAll()
          .where("id", "=", task.segment_id)
          .executeTakeFirstOrThrow();
        const state = task.result ? decodeJson<TaskState>(task.result) : {},
          receipt = state.retrievals?.find((r) => r.id === safe.retrieval_id);
        let status = "no_findings",
          result: unknown = { entities: [], links: 0 };
        if (safe.outcome === "proposal") {
          const proposal: Bundle = bundleSchema.parse(safe.proposal);
          invariant(
            !proposal.source_segment_id ||
              proposal.source_segment_id === segment.id,
            "source_mismatch",
            "Proposal belongs to another source segment",
          );
          proposal.source_segment_id = segment.id;
          invariant(
            proposal.bugs.length +
              proposal.standards.length +
              proposal.links.length +
              proposal.contexts.length >
              0,
            "empty_proposal",
            "Use no_findings for an empty analysis",
          );
          for (const kind of ["bug", "standard"] as const)
            for (const edit of kind === "bug"
              ? proposal.bugs
              : proposal.standards) {
              invariant(
                edit.record.confidence.evidence.every(
                  (e) => !e.segment_id || sourceTexts.has(e.segment_id),
                ),
                "source_mismatch",
                "Evidence must belong to the claimed segment or its bounded neighbors",
              );
              edit.record.confidence.evidence =
                edit.record.confidence.evidence.map((e) => ({
                  ...e,
                  segment_id: e.segment_id ?? segment.id,
                }));
              const discoveryEvents: Array<{
                kind: "human_report" | "human_guidance" | "agent_finding";
                role: "user" | "assistant" | "tool";
                position: [number, number];
              }> = [];
              if ("discovery" in edit.record)
                for (const evidence of edit.record.discovery.evidence) {
                  const evidenceSegmentId = evidence.segment_id ?? segment.id,
                    events = sourceEvents.get(evidenceSegmentId);
                  invariant(
                    events?.length,
                    "discovery_origin_unverified",
                    "Bug discovery evidence requires an available source segment with event roles",
                  );
                  const sourceEvent = events.find(
                    (event) =>
                      event.role === evidence.role &&
                      event.text.includes(evidence.excerpt),
                  );
                  invariant(
                    sourceEvent,
                    "discovery_origin_unverified",
                    "Bug discovery evidence must quote the claimed source role",
                  );
                  discoveryEvents.push({
                    kind: evidence.kind,
                    role: evidence.role,
                    position: sourceEvent.position,
                  });
                  evidence.segment_id = evidenceSegmentId;
                }
              if (
                "discovery" in edit.record &&
                edit.record.discovery.origin === "human_guided_review"
              ) {
                const guidance = discoveryEvents.filter(
                    (event) =>
                      event.kind === "human_guidance" && event.role === "user",
                  ),
                  findings = discoveryEvents.filter(
                    (event) =>
                      event.kind === "agent_finding" &&
                      ["assistant", "tool"].includes(event.role),
                  );
                invariant(
                  guidance.some((guide) =>
                    findings.some(
                      (finding) =>
                        guide.position[0] < finding.position[0] ||
                        (guide.position[0] === finding.position[0] &&
                          guide.position[1] < finding.position[1]),
                    ),
                  ),
                  "discovery_origin_unverified",
                  "Human guidance must precede the Agent finding it directs",
                );
              }
              // Evidence sufficiency remains a knowledge proposal judgement; missing source references or incomplete retrieval prevent automatic activation.
              let uncertain =
                !edit.record.confidence.evidence.length ||
                edit.record.confidence.evidence.some(
                  (e) =>
                    !sourceTexts
                      .get(e.segment_id ?? segment.id)
                      ?.includes(e.excerpt),
                );
              if (!edit.id) {
                uncertain ||=
                  !receipt ||
                  !edit.record.type_ids.every((t) =>
                    receipt.type_ids.includes(t),
                  ) ||
                  !receipt.complete;
                if (receipt)
                  for (const disposition of ["active", "candidate"] as const) {
                    const current = await this.catalog.search(
                      kind,
                      {
                        type_ids: edit.record.type_ids,
                        query: receipt.query,
                        limit: receipt.limit,
                        disposition,
                      },
                      tx,
                    );
                    const seen =
                      receipt.records[`${kind}:${disposition}`] ?? [];
                    uncertain ||=
                      !current.coverage.complete ||
                      current.items.some(
                        (item) =>
                          !seen.some(
                            (s) =>
                              s.id === item.id &&
                              s.current_revision === item.current_revision,
                          ),
                      );
                  }
                const names =
                  kind === "bug"
                    ? { entity: "bugs" as const, types: "bug_types" as const }
                    : {
                        entity: "standards" as const,
                        types: "standard_types" as const,
                      };
                const exact = await tx
                  .selectFrom(names.entity)
                  .select(["id", "mechanism"])
                  .where(
                    "id",
                    "in",
                    tx
                      .selectFrom(names.types)
                      .select("entity_id")
                      .where("type_id", "in", edit.record.type_ids),
                  )
                  .where("mechanism", "=", edit.record.mechanism)
                  .where("disposition", "in", ["active", "candidate"])
                  .limit(1)
                  .executeTakeFirst();
                uncertain ||= !!exact;
              }
              if (uncertain)
                edit.record.confidence = {
                  ...edit.record.confidence,
                  assessment: "uncertain",
                  reason: `${edit.record.confidence.reason}; retrieval incomplete, changed, duplicate, or source evidence absent`,
                };
            }
          const hasEligibleNewBug = proposal.bugs.some(
            (edit) =>
              !edit.id &&
              edit.record.discovery.evidence.some(
                (evidence) => evidence.role === "user",
              ),
          );
          if (!hasEligibleNewBug)
            for (const edit of proposal.standards) {
              if (edit.id) continue;
              invariant(
                edit.record.confidence.evidence.some((evidence) =>
                  sourceEvents
                    .get(evidence.segment_id ?? segment.id)
                    ?.some(
                      (event) =>
                        event.role === "user" &&
                        event.text.includes(evidence.excerpt),
                    ),
                ),
                "standard_origin_unverified",
                "A new standard without a new human-origin Bug must cite human source evidence",
              );
            }
          const applied = await this.catalog.applyTransaction(
            tx,
            proposal,
            meta,
          );
          result = applied;
          status = applied.entities.some(
            (e) => e.disposition === "candidate" || e.candidate_id,
          )
            ? "candidate"
            : "committed";
        }
        const saved = {
          task_id: task.id,
          analysis_version: task.analysis_version,
          privacy_version: segment.privacy_version,
          summary_hash: decodeJson<SegmentContext>(segment.context)
            .summary_hash,
          summary_version:
            decodeJson<SegmentContext>(segment.context).summary_version ??
            "extractive-v1",
          segment_id: segment.id,
          status,
          reason: safe.reason,
          result,
        };
        await tx
          .updateTable("segment_tasks")
          .set({
            status,
            owner_token: null,
            lease_until: 0,
            result: canonical(saved),
            updated_at: now(),
          })
          .where("id", "=", task.id)
          .execute();
        return saved;
      },
    );
  }
  async reanalyze(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        analysis_version: text.max(100),
        segment_id: uuid.optional(),
        cursor: z.string().max(4000).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "analysis.reanalyze", input },
      async (tx) => {
        let query = tx
          .selectFrom("source_segments")
          .select("id")
          .orderBy("id")
          .limit(input.limit + 1);
        if (input.segment_id) query = query.where("id", "=", input.segment_id);
        if (input.cursor) {
          const cursor = z
            .object({ version: z.string(), last: uuid })
            .parse(
              JSON.parse(
                Buffer.from(input.cursor, "base64url").toString("utf8"),
              ),
            );
          invariant(
            cursor.version === input.analysis_version,
            "invalid_cursor",
            "Reanalysis cursor belongs to a different strategy",
          );
          query = query.where("id", ">", cursor.last);
        }
        const segments = await query.execute();
        for (const segment of segments.slice(0, input.limit))
          await tx
            .insertInto("segment_tasks")
            .values({
              id: id(),
              segment_id: segment.id,
              analysis_version: input.analysis_version,
              status: "pending",
              owner_token: null,
              lease_until: 0,
              attempts: 0,
              result: null,
              updated_at: now(),
            })
            .onConflict((oc) =>
              oc.columns(["segment_id", "analysis_version"]).doNothing(),
            )
            .execute();
        return {
          segments: segments.slice(0, input.limit).map((s) => s.id),
          analysis_version: input.analysis_version,
          next_cursor:
            segments.length > input.limit
              ? Buffer.from(
                  canonical({
                    version: input.analysis_version,
                    last: segments[input.limit - 1]!.id,
                  }),
                ).toString("base64url")
              : null,
        };
      },
    );
  }
  async release(raw: unknown, meta: Mutation) {
    const input = analysisLeaseSchema
      .extend({
        failed: z.boolean().default(false),
        code: z.string().min(1).max(100).default("executor_interrupted"),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "analysis.release", input },
      async (tx) => {
        const task = await tx
          .selectFrom("segment_tasks")
          .selectAll()
          .where("id", "=", input.task_id)
          .executeTakeFirst();
        this.owned(task, input.owner_token);
        await tx
          .updateTable("segment_tasks")
          .set({
            status: input.failed ? "failed" : "pending",
            owner_token: null,
            lease_until: 0,
            result: canonical({
              last_error: { code: normalizeName(redact(input.code)) },
            }),
            updated_at: now(),
          })
          .where("id", "=", task.id)
          .execute();
        return {
          task_id: task.id,
          status: input.failed ? "failed" : "pending",
        };
      },
    );
  }
}
