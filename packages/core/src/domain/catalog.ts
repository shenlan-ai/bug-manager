import { sql } from "kysely";
import type { Transaction } from "kysely";
import { z } from "zod";
import type { Db, Mutation, Store } from "../storage/database.js";
import type { Schema } from "../storage/schema.js";
import { DomainError, invariant } from "../errors.js";
import {
  canonical,
  decodeJson,
  hash,
  id,
  makeCursor,
  normalizeName,
  now,
  parseCursor,
  searchTokens,
  boundedText,
} from "../util.js";
import {
  bugSchema,
  standardSchema,
  confidenceSchema,
  isSupported,
  knowledgeSearchSchema,
  pageSchema,
  text,
  uuid,
} from "./schemas.js";
import type { Bug, EntityKind, Knowledge, Standard } from "./schemas.js";
import { requireActiveTypes } from "./taxonomy.js";

const editBase = {
  ref: text.max(200),
  id: uuid.optional(),
  expected_revision: z.number().int().positive().optional(),
};
export const bundleSchema = z
  .object({
    bugs: z
      .array(z.object({ ...editBase, record: bugSchema }).strict())
      .max(200)
      .default([]),
    standards: z
      .array(z.object({ ...editBase, record: standardSchema }).strict())
      .max(200)
      .default([]),
    links: z
      .array(
        z
          .object({
            bug_ref: text.max(200),
            standard_ref: text.max(200),
            coverage_reason: text,
            scenario_ids: z.array(text).default([]),
            parameter_mapping: z.record(z.string(), z.unknown()).default({}),
            expected_revision: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    contexts: z
      .array(
        z
          .object({
            bug_ref: text.max(200),
            project_id: uuid.optional(),
            description: text,
            version: z.string().optional(),
            evidence: z.array(text).default([]),
          })
          .strict(),
      )
      .max(500)
      .default([]),
    source_segment_id: uuid.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    for (const key of ["bugs", "standards"] as const)
      if (new Set(b[key].map((v) => v.ref)).size !== b[key].length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${key} refs` });
  });
export type Bundle = z.infer<typeof bundleSchema>;
export function bugContextFingerprint(input: {
  bug_id: string;
  context: Bundle["contexts"][number];
  source_segment_id?: string;
}) {
  const { bug_ref: _, ...contextFields } = input.context;
  return hash(
    canonical({
      bug_id: input.bug_id,
      context: contextFields,
      source_segment_id: input.source_segment_id,
    }),
  );
}
type Tx = Transaction<Schema>;
type Saved = {
  ref: string;
  id: string;
  kind: EntityKind;
  revision: number;
  disposition: string;
  candidate_id?: string;
  change_applied: boolean;
};
export type EntityView = {
  id: string;
  kind: EntityKind;
  revision: number;
  disposition: string;
  record: Knowledge;
  requested_id?: string;
};

const tables = (kind: EntityKind) =>
  kind === "bug"
    ? {
        entity: "bugs" as const,
        revision: "bug_revisions" as const,
        types: "bug_types" as const,
      }
    : {
        entity: "standards" as const,
        revision: "standard_revisions" as const,
        types: "standard_types" as const,
      };

export class Catalog {
  constructor(readonly store: Store) {}
  async apply(raw: unknown, meta: Mutation) {
    const input = bundleSchema.parse(raw);
    return this.store.write(
      meta,
      { operation: "knowledge.apply", input },
      (tx) => this.applyTransaction(tx, input, meta),
    );
  }

  async applyTransaction(tx: Tx, input: Bundle, meta: Mutation) {
    if (input.source_segment_id)
      invariant(
        await tx
          .selectFrom("source_segments")
          .select("id")
          .where("id", "=", input.source_segment_id)
          .executeTakeFirst(),
        "not_found",
        "Source segment not found",
      );
    const bugRefs = new Map(input.bugs.map((b) => [b.ref, b.id ?? id()]));
    const standardRefs = new Map(
      input.standards.map((s) => [s.ref, s.id ?? id()]),
    );
    const resolveRef = (ref: string, refs: Map<string, string>) => {
      const result = refs.get(ref) ?? ref;
      uuid.parse(result);
      return result;
    };
    const links = input.links.map((l) => ({
      ...l,
      bug_id: resolveRef(l.bug_ref, bugRefs),
      standard_id: resolveRef(l.standard_ref, standardRefs),
    }));
    const saved: Saved[] = [];
    for (const edit of input.standards)
      saved.push(
        await this.save(
          tx,
          "standard",
          standardRefs.get(edit.ref)!,
          edit,
          meta,
          isSupported(edit.record.confidence),
        ),
      );
    for (const edit of input.bugs) {
      const bugId = bugRefs.get(edit.ref)!;
      const covering = new Set(
        links.filter((l) => l.bug_id === bugId).map((l) => l.standard_id),
      );
      const existing = await tx
        .selectFrom("bug_standard_links")
        .select("standard_id")
        .where("bug_id", "=", bugId)
        .execute();
      for (const l of existing) covering.add(l.standard_id);
      const active = covering.size
        ? await tx
            .selectFrom("standards")
            .select("id")
            .where("id", "in", [...covering])
            .where("disposition", "=", "active")
            .execute()
        : [];
      saved.push(
        await this.save(
          tx,
          "bug",
          bugId,
          edit,
          meta,
          isSupported(edit.record.confidence) && active.length > 0,
        ),
      );
    }
    for (const link of links) {
      const bug = await tx
        .selectFrom("bugs")
        .select("id")
        .where("id", "=", link.bug_id)
        .executeTakeFirst();
      const standard = await tx
        .selectFrom("standards")
        .selectAll()
        .where("id", "=", link.standard_id)
        .executeTakeFirst();
      invariant(
        bug && standard,
        "not_found",
        "Coverage must reference existing Bug and standard",
      );
      const revisionRow = await tx
        .selectFrom("standard_revisions")
        .select("payload")
        .where("entity_id", "=", standard.id)
        .where("revision", "=", standard.current_revision)
        .executeTakeFirstOrThrow();
      const definition = decodeJson<{ record: Standard }>(
        revisionRow.payload,
      ).record;
      invariant(
        link.scenario_ids.every((s) =>
          definition.scenarios.some((v) => v.scenario_id === s),
        ),
        "unknown_scenario",
        "Coverage references unknown standard scenario",
      );
      const old = await tx
        .selectFrom("bug_standard_links")
        .selectAll()
        .where("bug_id", "=", link.bug_id)
        .where("standard_id", "=", link.standard_id)
        .executeTakeFirst();
      const payload = canonical({
        coverage_reason: link.coverage_reason,
        scenario_ids: link.scenario_ids,
        parameter_mapping: link.parameter_mapping,
        standard_revision: standard.current_revision,
        source_segment_id: input.source_segment_id,
      });
      if (old?.payload === payload) continue;
      invariant(
        !old || link.expected_revision === old.revision,
        "revision_conflict",
        "Coverage changed; supply its current expected_revision",
      );
      invariant(
        !!old ||
          link.expected_revision === undefined ||
          link.expected_revision === 0,
        "revision_conflict",
        "Coverage does not exist at the expected revision",
      );
      const row = {
        bug_id: link.bug_id,
        standard_id: link.standard_id,
        revision: (old?.revision ?? 0) + 1,
        payload,
        actor: meta.actor,
        reason: meta.reason,
        created_at: now(),
      };
      if (old)
        await tx
          .updateTable("bug_standard_links")
          .set(row)
          .where("bug_id", "=", row.bug_id)
          .where("standard_id", "=", row.standard_id)
          .execute();
      else await tx.insertInto("bug_standard_links").values(row).execute();
      await tx.insertInto("bug_standard_link_revisions").values(row).execute();
    }
    for (const context of input.contexts) {
      const bug_id = resolveRef(context.bug_ref, bugRefs);
      invariant(
        await tx
          .selectFrom("bugs")
          .select("id")
          .where("id", "=", bug_id)
          .executeTakeFirst(),
        "not_found",
        "Bug context target not found",
      );
      if (context.project_id)
        invariant(
          await tx
            .selectFrom("projects")
            .select("id")
            .where("id", "=", context.project_id)
            .executeTakeFirst(),
          "not_found",
          "Context project not found",
        );
      const { bug_ref: _, ...contextFields } = context,
        payload = canonical({
          ...contextFields,
          source_segment_id: input.source_segment_id,
        }),
        fingerprint = bugContextFingerprint({
          bug_id,
          context,
          source_segment_id: input.source_segment_id,
        });
      await tx
        .insertInto("bug_contexts")
        .values({
          id: id(),
          bug_id,
          project_id: context.project_id ?? null,
          payload,
          fingerprint,
        })
        .onConflict((oc) => oc.column("fingerprint").doNothing())
        .execute();
    }
    if (input.source_segment_id) {
      const subjects = new Map<
        string,
        {
          id: string;
          kind: EntityKind;
          revision: number;
          source_ids: string[];
          candidate_id?: string;
        }
      >();
      for (const item of saved) {
        const edit = (item.kind === "bug" ? input.bugs : input.standards).find(
          (e) => e.ref === item.ref,
        );
        subjects.set(`${item.kind}:${item.id}`, {
          ...item,
          source_ids: [
            input.source_segment_id,
            ...(edit?.record.confidence.evidence.flatMap((e) =>
              e.segment_id ? [e.segment_id] : [],
            ) ?? []),
          ],
        });
      }
      for (const link of links)
        for (const kind of ["bug", "standard"] as const) {
          const entity_id = kind === "bug" ? link.bug_id : link.standard_id,
            key = `${kind}:${entity_id}`;
          if (!subjects.has(key)) {
            const entity = await tx
              .selectFrom(tables(kind).entity)
              .select("current_revision")
              .where("id", "=", entity_id)
              .executeTakeFirstOrThrow();
            subjects.set(key, {
              id: entity_id,
              kind,
              revision: entity.current_revision,
              source_ids: [input.source_segment_id],
            });
          }
        }
      for (const context of input.contexts) {
        const bug_id = resolveRef(context.bug_ref, bugRefs),
          key = `bug:${bug_id}`;
        if (!subjects.has(key)) {
          const bug = await tx
            .selectFrom("bugs")
            .select("current_revision")
            .where("id", "=", bug_id)
            .executeTakeFirstOrThrow();
          subjects.set(key, {
            id: bug_id,
            kind: "bug",
            revision: bug.current_revision,
            source_ids: [input.source_segment_id],
          });
        }
      }
      for (const item of subjects.values())
        for (const segment_id of new Set(item.source_ids)) {
          invariant(
            await tx
              .selectFrom("source_segments")
              .select("id")
              .where("id", "=", segment_id)
              .executeTakeFirst(),
            "not_found",
            "Evidence source segment not found",
          );
          const fingerprint = hash(
            canonical({ kind: item.kind, id: item.id, segment: segment_id }),
          );
          await tx
            .insertInto("provenance_links")
            .values({
              id: id(),
              entity_kind: item.kind,
              entity_id: item.id,
              segment_id,
              payload: canonical({
                revision: item.revision,
                candidate_id: item.candidate_id,
              }),
              fingerprint,
            })
            .onConflict((oc) => oc.column("fingerprint").doNothing())
            .execute();
        }
    }
    return { entities: saved, links: links.length };
  }

  private async save(
    tx: Tx,
    kind: EntityKind,
    entityId: string,
    edit: {
      ref: string;
      id?: string;
      expected_revision?: number;
      record: Knowledge;
    },
    meta: Mutation,
    supported: boolean,
  ): Promise<Saved> {
    const names = tables(kind),
      record = edit.record;
    const type_ids = await requireActiveTypes(tx, record.type_ids);
    const previous = await tx
      .selectFrom(names.entity)
      .selectAll()
      .where("id", "=", entityId)
      .executeTakeFirst();
    if (edit.id) {
      invariant(previous, "not_found", "Knowledge target not found");
      invariant(
        edit.expected_revision === previous.current_revision,
        "revision_conflict",
        "Knowledge revision changed",
      );
      invariant(
        previous.disposition !== "superseded",
        "superseded_entity",
        "Resolve the merged entity ID before updating",
      );
    }
    if (previous && !supported && previous.disposition === "active") {
      const candidate_id = await this.candidate(
        tx,
        kind,
        {
          entity_id: entityId,
          expected_revision: previous.current_revision,
          record,
        },
        "Uncertain edit cannot replace active knowledge",
        record.confidence,
        meta,
      );
      return {
        ref: edit.ref,
        id: entityId,
        kind,
        revision: previous.current_revision,
        disposition: previous.disposition,
        candidate_id,
        change_applied: false,
      };
    }
    const disposition = supported ? "active" : "candidate",
      revision = (previous?.current_revision ?? 0) + 1;
    const normalizedRecord = { ...record, type_ids };
    const rating =
      kind === "bug"
        ? (record as Bug).severity
        : (record as Standard).importance;
    const search_text = searchTokens(
      [
        record.title,
        record.mechanism,
        kind === "bug"
          ? (record as Bug).symptoms.join(" ")
          : (record as Standard).objective,
      ].join(" "),
    ).join(" ");
    const fingerprint = hash(
      canonical({ mechanism: normalizeName(record.mechanism), kind, type_ids }),
    );
    const row = {
      id: entityId,
      current_revision: revision,
      disposition,
      title: record.title,
      mechanism: record.mechanism,
      rating,
      search_text,
      fingerprint,
      created_at: previous?.created_at ?? now(),
      updated_at: now(),
    };
    if (previous)
      await tx
        .updateTable(names.entity)
        .set(row)
        .where("id", "=", entityId)
        .execute();
    else await tx.insertInto(names.entity).values(row).execute();
    await tx
      .insertInto(names.revision)
      .values({
        entity_id: entityId,
        revision,
        payload: canonical({ record: normalizedRecord, disposition }),
        actor: meta.actor,
        reason: meta.reason,
        created_at: now(),
      })
      .execute();
    await tx
      .deleteFrom(names.types)
      .where("entity_id", "=", entityId)
      .execute();
    await tx
      .insertInto(names.types)
      .values(type_ids.map((type_id) => ({ entity_id: entityId, type_id })))
      .execute();
    if (this.store.dialect === "sqlite") {
      const fts = sql.table(kind === "bug" ? "bugs_fts" : "standards_fts");
      await sql`DELETE FROM ${fts} WHERE entity_id=${entityId}`.execute(tx);
      await sql`INSERT INTO ${fts}(entity_id,tokens) VALUES(${entityId},${search_text})`.execute(
        tx,
      );
    }
    await tx
      .deleteFrom("entity_tag_links")
      .where("entity_kind", "=", kind)
      .where("entity_id", "=", entityId)
      .execute();
    for (const name of [...new Set(record.tags.map(normalizeName))]) {
      const existing = await tx
        .selectFrom("tags")
        .select("id")
        .where("normalized_name", "=", name)
        .executeTakeFirst();
      const tagId = existing?.id ?? id();
      if (!existing)
        await tx
          .insertInto("tags")
          .values({ id: tagId, name, normalized_name: name })
          .execute();
      await tx
        .insertInto("entity_tag_links")
        .values({ entity_kind: kind, entity_id: entityId, tag_id: tagId })
        .execute();
    }
    let candidate_id: string | undefined;
    if (!supported)
      candidate_id = await this.candidate(
        tx,
        kind,
        {
          entity_id: entityId,
          expected_revision: revision,
          record: normalizedRecord,
        },
        kind === "bug"
          ? "Insufficient evidence or executable coverage"
          : "Insufficient evidence",
        record.confidence,
        meta,
      );
    return {
      ref: edit.ref,
      id: entityId,
      kind,
      revision,
      disposition,
      candidate_id,
      change_applied: true,
    };
  }
  private async candidate(
    tx: Tx,
    kind: string,
    payload: unknown,
    reason: string,
    evidence: unknown,
    meta: Mutation,
  ) {
    const candidate_id = id();
    await tx
      .insertInto("knowledge_candidates")
      .values({
        id: candidate_id,
        kind,
        payload: canonical(payload),
        reason,
        evidence: canonical(evidence),
        disposition: "pending",
        revision: 1,
        actor: meta.actor,
        created_at: now(),
      })
      .execute();
    return candidate_id;
  }
  async get(
    kind: EntityKind,
    entityId: string,
    revision?: number,
  ): Promise<EntityView> {
    uuid.parse(entityId);
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const requested_id = entityId,
      names = tables(kind);
    if (revision === undefined)
      for (let i = 0; i < 32; i++) {
        const redirected = await this.store.db
          .selectFrom("entity_redirects")
          .select("target_id")
          .where("entity_kind", "=", kind)
          .where("old_id", "=", entityId)
          .executeTakeFirst();
        if (!redirected) break;
        entityId = redirected.target_id;
        if (i === 31)
          throw new DomainError(
            "redirect_cycle",
            "Knowledge redirect chain is invalid",
          );
      }
    const entity = await this.store.db
      .selectFrom(names.entity)
      .selectAll()
      .where("id", "=", entityId)
      .executeTakeFirst();
    invariant(entity, "not_found", "Knowledge not found");
    const record = await this.store.db
      .selectFrom(names.revision)
      .selectAll()
      .where("entity_id", "=", entityId)
      .where("revision", "=", revision ?? entity.current_revision)
      .executeTakeFirst();
    invariant(record, "not_found", "Knowledge revision not found");
    const payload = decodeJson<{ record: Knowledge; disposition: string }>(
      record.payload,
    );
    return {
      id: entityId,
      kind,
      revision: record.revision,
      disposition: payload.disposition,
      record: payload.record,
      ...(requested_id !== entityId ? { requested_id } : {}),
    };
  }
  async search(kind: EntityKind, raw: unknown, db: Db = this.store.db) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("type_ids" in raw) ||
      !Array.isArray(raw.type_ids) ||
      raw.type_ids.length === 0
    )
      throw new DomainError(
        "type_scope_required",
        "Knowledge searches require controlled type IDs",
      );
    const input = knowledgeSearchSchema.parse(raw),
      names = tables(kind),
      type_ids = await requireActiveTypes(db, input.type_ids);
    const scope = hash(
      canonical({
        kind,
        type_ids,
        match: input.type_match,
        query: input.query,
        disposition: input.disposition,
      }),
    );
    const cursor = parseCursor(input.cursor, scope),
      watermark = cursor?.watermark ?? now();
    const snapshot = await db
      .selectFrom("library_lock")
      .select("revision")
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    invariant(
      !cursor || cursor.revision === snapshot.revision,
      "cursor_stale",
      "Knowledge changed since the previous page; restart this query",
    );
    let membership = db
      .selectFrom(names.types)
      .select("entity_id")
      .where("type_id", "in", type_ids)
      .groupBy("entity_id");
    if (input.type_match === "all")
      membership = membership.having(
        sql<number>`count(distinct type_id)`,
        "=",
        type_ids.length,
      );
    let query = db
      .selectFrom(names.entity)
      .select([
        "id",
        "title",
        "mechanism",
        "rating",
        "current_revision",
        "disposition",
      ])
      .where("id", "in", membership)
      .where("disposition", "=", input.disposition)
      .where("created_at", "<=", watermark);
    if (cursor) query = query.where("id", ">", cursor.last);
    if (input.query?.trim()) {
      const tokens = searchTokens(input.query).slice(0, 64);
      if (!tokens.length)
        return {
          items: [],
          next_cursor: null,
          coverage: { type_ids, complete: true },
        };
      if (this.store.dialect === "sqlite") {
        const fts = sql.table(kind === "bug" ? "bugs_fts" : "standards_fts"),
          match = tokens
            .map((t) => `"${t.replaceAll('"', '""')}"`)
            .join(" OR ");
        query = query.where(
          sql<boolean>`${sql.ref(`${names.entity}.id`)} IN (SELECT entity_id FROM ${fts} WHERE tokens MATCH ${match})`,
        );
      } else
        query = query.where(
          sql<boolean>`to_tsvector('simple',search_text) @@ to_tsquery('simple',${tokens.map((t) => `'${t.replaceAll("'", "''")}'`).join(" | ")})`,
        );
    }
    const rows = await query
        .orderBy("id")
        .limit(input.limit + 1)
        .execute(),
      items = rows.slice(0, input.limit),
      last = items.at(-1);
    const after = await db
      .selectFrom("library_lock")
      .select("revision")
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    invariant(
      after.revision === snapshot.revision,
      "cursor_stale",
      "Knowledge changed during the query; retry to obtain a consistent page",
    );
    return {
      items: items.map((item) => ({
        ...item,
        mechanism: boundedText(item.mechanism, 500),
        mechanism_truncated: item.mechanism.length > 500,
      })),
      next_cursor:
        rows.length > input.limit && last
          ? makeCursor(last.id, watermark, scope, snapshot.revision)
          : null,
      coverage: {
        type_ids,
        complete: rows.length <= input.limit,
        snapshot_revision: snapshot.revision,
      },
    };
  }
  async history(kind: EntityKind, entityId: string, raw: unknown = {}) {
    uuid.parse(entityId);
    const input = pageSchema.parse(raw),
      scope = hash(canonical({ kind, entityId, operation: "history" })),
      cursor = parseCursor(input.cursor, scope),
      watermark = cursor?.watermark ?? now();
    const rows = await this.store.db
      .selectFrom(tables(kind).revision)
      .selectAll()
      .where("entity_id", "=", entityId)
      .where("revision", ">", cursor ? Number(cursor.last) : 0)
      .where("created_at", "<=", watermark)
      .orderBy("revision")
      .limit(input.limit + 1)
      .execute();
    const items = rows
        .slice(0, input.limit)
        .map((r) => ({ ...r, payload: decodeJson(r.payload) })),
      last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > input.limit && last
          ? makeCursor(String(last.revision), watermark, scope)
          : null,
    };
  }
  async candidates(raw: unknown = {}) {
    const input = pageSchema
      .extend({
        kind: z.string().optional(),
        disposition: z
          .enum(["pending", "confirmed", "rejected"])
          .default("pending"),
      })
      .parse(raw);
    const scope = hash(
        canonical({
          operation: "candidates",
          kind: input.kind,
          disposition: input.disposition,
        }),
      ),
      cursor = parseCursor(input.cursor, scope),
      watermark = cursor?.watermark ?? now();
    let query = this.store.db
      .selectFrom("knowledge_candidates")
      .selectAll()
      .where("disposition", "=", input.disposition)
      .where("created_at", "<=", watermark);
    if (input.kind) query = query.where("kind", "=", input.kind);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query
        .orderBy("id")
        .limit(input.limit + 1)
        .execute(),
      items = rows.slice(0, input.limit).map((r) => ({
        id: r.id,
        kind: r.kind,
        revision: r.revision,
        disposition: r.disposition,
        actor: r.actor,
        created_at: r.created_at,
      })),
      last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > input.limit && last
          ? makeCursor(last.id, watermark, scope)
          : null,
    };
  }
  async resolveCandidate(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        candidate_id: uuid,
        expected_revision: z.number().int().positive(),
        decision: z.enum(["confirm", "reject"]),
        confidence: confidenceSchema.optional(),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "candidate.resolve", input },
      async (tx) => {
        const row = await tx
          .selectFrom("knowledge_candidates")
          .selectAll()
          .where("id", "=", input.candidate_id)
          .executeTakeFirst();
        invariant(row, "not_found", "Candidate not found");
        invariant(
          row.revision === input.expected_revision &&
            row.disposition === "pending",
          "revision_conflict",
          "Candidate already changed",
        );
        if (input.decision === "confirm") {
          invariant(
            row.kind !== "merge",
            "merge_confirmation_required",
            "Confirm a merge through knowledge_merge with candidate_id, current revisions and compatibility evidence",
          );
          invariant(
            (row.kind === "bug" || row.kind === "standard") &&
              input.confidence &&
              isSupported(input.confidence),
            "confirmation_evidence_required",
            "Confirmation requires explicit supporting observations",
          );
          const proposal = decodeJson<{
            entity_id: string;
            expected_revision: number;
            record: Knowledge;
          }>(row.payload);
          const record = { ...proposal.record, confidence: input.confidence };
          const bundle = bundleSchema.parse({
            [row.kind === "bug" ? "bugs" : "standards"]: [
              {
                ref: proposal.entity_id,
                id: proposal.entity_id,
                expected_revision: proposal.expected_revision,
                record,
              },
            ],
          });
          const result = await this.applyTransaction(tx, bundle, meta);
          invariant(
            result.entities.every(
              (e) => e.disposition === "active" && e.change_applied,
            ),
            "coverage_required",
            "Confirmation requires active executable coverage",
          );
        } else if (row.kind === "bug" || row.kind === "standard") {
          const proposal = decodeJson<{
              entity_id: string;
              expected_revision: number;
              record: Knowledge;
            }>(row.payload),
            names = tables(row.kind);
          const entity = await tx
            .selectFrom(names.entity)
            .selectAll()
            .where("id", "=", proposal.entity_id)
            .executeTakeFirst();
          // Rejecting an uncertain edit must never reject an existing active fact.
          if (
            entity?.disposition === "candidate" &&
            entity.current_revision === proposal.expected_revision
          ) {
            const revision = entity.current_revision + 1;
            await tx
              .updateTable(names.entity)
              .set({
                disposition: "rejected",
                current_revision: revision,
                updated_at: now(),
              })
              .where("id", "=", entity.id)
              .execute();
            await tx
              .insertInto(names.revision)
              .values({
                entity_id: entity.id,
                revision,
                payload: canonical({
                  record: proposal.record,
                  disposition: "rejected",
                }),
                actor: meta.actor,
                reason: meta.reason,
                created_at: now(),
              })
              .execute();
          }
        }
        await tx
          .updateTable("knowledge_candidates")
          .set({
            disposition:
              input.decision === "confirm" ? "confirmed" : "rejected",
            revision: row.revision + 1,
            actor: meta.actor,
          })
          .where("id", "=", row.id)
          .execute();
        return {
          id: row.id,
          disposition: input.decision === "confirm" ? "confirmed" : "rejected",
          revision: row.revision + 1,
          actor: meta.actor,
          reason: meta.reason,
        };
      },
    );
  }
  async candidateGet(candidateId: string) {
    uuid.parse(candidateId);
    const row = await this.store.db
      .selectFrom("knowledge_candidates")
      .selectAll()
      .where("id", "=", candidateId)
      .executeTakeFirst();
    invariant(row, "not_found", "Knowledge candidate not found");
    return {
      ...row,
      payload: decodeJson(row.payload),
      evidence: decodeJson(row.evidence),
    };
  }
  async coverage(raw: unknown) {
    const input = pageSchema
        .extend({
          kind: z.enum(["bug", "standard"]),
          id: uuid,
          history: z.boolean().default(false),
        })
        .strict()
        .parse(raw),
      column = input.kind === "bug" ? "bug_id" : "standard_id",
      other = input.kind === "bug" ? "standard_id" : "bug_id",
      scope = hash(
        canonical({
          operation: "knowledge.coverage",
          kind: input.kind,
          id: input.id,
          history: input.history,
        }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom(
        input.history ? "bug_standard_link_revisions" : "bug_standard_links",
      )
      .selectAll()
      .where(column, "=", input.id);
    if (cursor) {
      const [otherId, revision] = cursor.last.split(":");
      query = query.where((eb) =>
        eb.or([
          eb(other, ">", otherId!),
          eb.and([
            eb(other, "=", otherId!),
            eb("revision", ">", Number(revision)),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy(other)
      .orderBy("revision")
      .limit(input.limit + 1)
      .execute();
    return {
      items: rows
        .slice(0, input.limit)
        .map((row) => ({ ...row, payload: decodeJson(row.payload) })),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(
              `${rows[input.limit - 1]![other]}:${rows[input.limit - 1]!.revision}`,
              now(),
              scope,
            )
          : null,
    };
  }
  async provenance(raw: unknown) {
    const input = pageSchema
        .extend({ kind: z.enum(["bug", "standard"]), id: uuid })
        .strict()
        .parse(raw),
      scope = hash(
        canonical({
          operation: "knowledge.provenance",
          kind: input.kind,
          id: input.id,
        }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("provenance_links")
      .selectAll()
      .where("entity_kind", "=", input.kind)
      .where("entity_id", "=", input.id);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query
      .orderBy("id")
      .limit(input.limit + 1)
      .execute();
    return {
      items: rows
        .slice(0, input.limit)
        .map((row) => ({ ...row, payload: decodeJson(row.payload) })),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.id, now(), scope)
          : null,
    };
  }
}
