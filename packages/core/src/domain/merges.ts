import { z } from "zod";
import type { Transaction } from "kysely";
import type { Mutation, Store } from "../storage/database.js";
import type { Schema } from "../storage/schema.js";
import { invariant } from "../errors.js";
import { canonical, decodeJson, hash, id, now } from "../util.js";
import { Catalog, bundleSchema } from "./catalog.js";
import { confidenceSchema, isSupported, text, uuid } from "./schemas.js";
import type { Bug, Standard, Knowledge } from "./schemas.js";

export const mergeSchema = z
  .object({
    kind: z.enum(["bug", "standard"]),
    source_id: uuid,
    target_id: uuid,
    expected_source_revision: z.number().int().positive(),
    expected_target_revision: z.number().int().positive(),
    compatibility: z
      .object({
        mechanism: z.boolean(),
        preconditions: z.boolean(),
        expected_results: z.boolean(),
        reason: text,
        confidence: confidenceSchema,
      })
      .strict(),
    candidate_id: uuid.optional(),
  })
  .strict();
type Merge = z.infer<typeof mergeSchema>;
const union = <T>(a: T[], b: T[]) => [
  ...new Map([...a, ...b].map((v) => [canonical(v), v])).values(),
];

export class KnowledgeMerges {
  constructor(readonly store: Store) {}
  async merge(raw: unknown, meta: Mutation) {
    const input = mergeSchema.parse(raw);
    invariant(
      input.source_id !== input.target_id,
      "invalid_merge",
      "Source and target must differ",
    );
    return this.store.write(
      meta,
      { operation: "knowledge.merge", input },
      (tx) => this.mergeTransaction(tx, input, meta),
    );
  }
  private async mergeTransaction(
    tx: Transaction<Schema>,
    input: Merge,
    meta: Mutation,
  ) {
    const names =
      input.kind === "bug"
        ? { entity: "bugs" as const, revision: "bug_revisions" as const }
        : {
            entity: "standards" as const,
            revision: "standard_revisions" as const,
          };
    const load = async (entity_id: string, expected: number) => {
      const entity = await tx
        .selectFrom(names.entity)
        .selectAll()
        .where("id", "=", entity_id)
        .executeTakeFirst();
      invariant(entity, "not_found", "Merge entity not found");
      invariant(
        entity.current_revision === expected,
        "revision_conflict",
        "Merge entity changed",
      );
      invariant(
        entity.disposition === "active",
        "merge_active_required",
        "Resolve inactive knowledge before merging",
      );
      const revision = await tx
        .selectFrom(names.revision)
        .selectAll()
        .where("entity_id", "=", entity_id)
        .where("revision", "=", expected)
        .executeTakeFirstOrThrow();
      return {
        entity,
        record: decodeJson<{ record: Knowledge }>(revision.payload).record,
      };
    };
    const source = await load(input.source_id, input.expected_source_revision),
      target = await load(input.target_id, input.expected_target_revision);
    const conflicts: string[] = [];
    if (!isSupported(input.compatibility.confidence))
      conflicts.push("Supporting observations are required");
    for (const key of [
      "mechanism",
      "preconditions",
      "expected_results",
    ] as const)
      if (!input.compatibility[key])
        conflicts.push(`Compatibility uncertain or conflicting: ${key}`);
    if (source.entity.rating !== target.entity.rating)
      conflicts.push(
        "Ratings differ; resolve their evidence and rating before merging",
      );
    let record: Knowledge = {
      ...target.record,
      type_ids: union(target.record.type_ids, source.record.type_ids),
      tags: union(target.record.tags, source.record.tags),
      confidence: {
        assessment: "supported",
        reason: input.compatibility.reason,
        evidence: union(
          target.record.confidence.evidence,
          source.record.confidence.evidence,
        ),
      },
    };
    if (input.kind === "standard") {
      const a = source.record as Standard,
        b = target.record as Standard;
      for (const p of a.parameters) {
        const other = b.parameters.find((x) => x.name === p.name);
        if (other && canonical(other) !== canonical(p))
          conflicts.push(`Parameter definitions differ: ${p.name}`);
      }
      for (const s of a.scenarios) {
        const other = b.scenarios.find((x) => x.scenario_id === s.scenario_id);
        if (other && canonical(other) !== canonical(s))
          conflicts.push(`Scenario definitions differ: ${s.scenario_id}`);
      }
      record = {
        ...record,
        objective: union([b.objective], [a.objective]).join("\n"),
        parameters: union(b.parameters, a.parameters),
        scenarios: union(b.scenarios, a.scenarios),
      } as Standard;
    } else {
      const a = source.record as Bug,
        b = target.record as Bug;
      record = {
        ...record,
        symptoms: union(b.symptoms, a.symptoms),
        trigger_conditions: union(b.trigger_conditions, a.trigger_conditions),
        impact: union([b.impact], [a.impact]).join("\n"),
      } as Bug;
    }
    if (conflicts.length) {
      const candidate_id = id();
      await tx
        .insertInto("knowledge_candidates")
        .values({
          id: candidate_id,
          kind: "merge",
          payload: canonical(input),
          reason: conflicts.join("; "),
          evidence: canonical(input.compatibility),
          disposition: "pending",
          revision: 1,
          actor: meta.actor,
          created_at: now(),
        })
        .execute();
      return { status: "candidate", candidate_id, conflicts };
    }
    if (input.candidate_id) {
      const candidate = await tx
        .selectFrom("knowledge_candidates")
        .selectAll()
        .where("id", "=", input.candidate_id)
        .executeTakeFirst();
      invariant(
        candidate?.kind === "merge" && candidate.disposition === "pending",
        "revision_conflict",
        "Merge candidate is not pending",
      );
      const previous = mergeSchema.parse(decodeJson(candidate.payload));
      invariant(
        previous.kind === input.kind &&
          previous.source_id === input.source_id &&
          previous.target_id === input.target_id,
        "candidate_mismatch",
        "Merge candidate belongs to another entity pair",
      );
      await tx
        .updateTable("knowledge_candidates")
        .set({
          disposition: "confirmed",
          revision: candidate.revision + 1,
          actor: meta.actor,
        })
        .where("id", "=", candidate.id)
        .execute();
    }
    const catalog = new Catalog(this.store);
    const saved = await catalog.applyTransaction(
      tx,
      bundleSchema.parse({
        [input.kind === "bug" ? "bugs" : "standards"]: [
          {
            ref: "target",
            id: input.target_id,
            expected_revision: input.expected_target_revision,
            record,
          },
        ],
      }),
      meta,
    );
    invariant(
      saved.entities[0]?.change_applied &&
        saved.entities[0].disposition === "active",
      "merge_validation_failed",
      "Merged knowledge could not become active",
    );
    const target_revision = saved.entities[0].revision;
    // Preserve current and historical source edges. New target edges reference the
    // exact old coverage revisions, including different parameter mappings.
    let after = "";
    const column = input.kind === "bug" ? "bug_id" : "standard_id",
      other = input.kind === "bug" ? "standard_id" : "bug_id";
    while (true) {
      const links = await tx
        .selectFrom("bug_standard_links")
        .selectAll()
        .where(column, "=", input.source_id)
        .where(other, ">", after)
        .orderBy(other)
        .limit(200)
        .execute();
      for (const link of links) {
        const bug_id = input.kind === "bug" ? input.target_id : link.bug_id,
          standard_id =
            input.kind === "standard" ? input.target_id : link.standard_id;
        const old = await tx
          .selectFrom("bug_standard_links")
          .selectAll()
          .where("bug_id", "=", bug_id)
          .where("standard_id", "=", standard_id)
          .executeTakeFirst();
        const payload = decodeJson<Record<string, unknown>>(
          old?.payload ?? link.payload,
        );
        const refs = union((payload.merged_coverage_refs ?? []) as unknown[], [
          {
            bug_id: link.bug_id,
            standard_id: link.standard_id,
            revision: link.revision,
          },
        ]);
        const row = {
          bug_id,
          standard_id,
          revision: (old?.revision ?? 0) + 1,
          payload: canonical({
            ...payload,
            merged_coverage_refs: refs,
            ...(input.kind === "standard"
              ? { standard_revision: target_revision }
              : {}),
          }),
          actor: meta.actor,
          reason: meta.reason,
          created_at: now(),
        };
        await tx
          .insertInto("bug_standard_links")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["bug_id", "standard_id"]).doUpdateSet(row),
          )
          .execute();
        await tx
          .insertInto("bug_standard_link_revisions")
          .values(row)
          .execute();
      }
      if (links.length < 200) break;
      after = links.at(-1)![other];
    }
    let afterProvenance = "";
    while (true) {
      const links = await tx
        .selectFrom("provenance_links")
        .selectAll()
        .where("entity_kind", "=", input.kind)
        .where("entity_id", "=", input.source_id)
        .where("id", ">", afterProvenance)
        .orderBy("id")
        .limit(200)
        .execute();
      for (const link of links) {
        const fingerprint = hash(
          canonical({
            kind: input.kind,
            id: input.target_id,
            segment: link.segment_id,
          }),
        );
        await tx
          .insertInto("provenance_links")
          .values({
            ...link,
            id: id(),
            entity_id: input.target_id,
            fingerprint,
            payload: canonical({
              ...decodeJson<Record<string, unknown>>(link.payload),
              merged_from: {
                entity_id: input.source_id,
                provenance_id: link.id,
              },
            }),
          })
          .onConflict((oc) => oc.column("fingerprint").doNothing())
          .execute();
      }
      if (links.length < 200) break;
      afterProvenance = links.at(-1)!.id;
    }
    if (input.kind === "bug") {
      let afterContext = "";
      while (true) {
        const contexts = await tx
          .selectFrom("bug_contexts")
          .selectAll()
          .where("bug_id", "=", input.source_id)
          .where("id", ">", afterContext)
          .orderBy("id")
          .limit(200)
          .execute();
        for (const context of contexts)
          await tx
            .insertInto("bug_contexts")
            .values({
              ...context,
              id: id(),
              bug_id: input.target_id,
              fingerprint: hash(
                canonical({
                  target: input.target_id,
                  original_context: context.id,
                }),
              ),
            })
            .onConflict((oc) => oc.column("fingerprint").doNothing())
            .execute();
        if (contexts.length < 200) break;
        afterContext = contexts.at(-1)!.id;
      }
    }
    const merge = {
      target_id: input.target_id,
      target_revision,
      compatibility: input.compatibility,
    };
    await tx
      .updateTable(names.entity)
      .set({
        disposition: "superseded",
        current_revision: input.expected_source_revision + 1,
        updated_at: now(),
      })
      .where("id", "=", input.source_id)
      .execute();
    await tx
      .insertInto(names.revision)
      .values({
        entity_id: input.source_id,
        revision: input.expected_source_revision + 1,
        payload: canonical({
          record: source.record,
          disposition: "superseded",
          merge,
        }),
        actor: meta.actor,
        reason: meta.reason,
        created_at: now(),
      })
      .execute();
    await tx
      .insertInto("entity_redirects")
      .values({
        entity_kind: input.kind,
        old_id: input.source_id,
        target_id: input.target_id,
        reason: meta.reason,
        actor: meta.actor,
        created_at: now(),
      })
      .execute();
    return {
      status: "merged",
      source_id: input.source_id,
      target_id: input.target_id,
      target_revision,
    };
  }
}
