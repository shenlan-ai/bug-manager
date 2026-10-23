import { z } from "zod";
import type { Config } from "../config.js";
import type { Store, Mutation } from "../storage/database.js";
import { invariant } from "../errors.js";
import {
  canonical,
  hash,
  decodeJson,
  now,
  makeCursor,
  parseCursor,
  boundedText,
} from "../util.js";
import { uuid, pageSchema } from "./schemas.js";
import { requireActiveTypes } from "./taxonomy.js";

const vector = z.array(z.number().finite()).min(1).max(4096),
  space = z
    .object({
      model_id: z.string().min(1).max(200),
      dimensions: z.number().int().min(1).max(4096),
      normalization_version: z.string().min(1).max(200),
    })
    .strict();
export const vectorPutSchema = space
  .extend({
    kind: z.enum(["bug", "standard"]),
    id: uuid,
    revision: z.number().int().positive(),
    vector,
  })
  .strict();
export const vectorSearchSchema = pageSchema
  .extend({
    kind: z.enum(["bug", "standard"]),
    type_ids: z.array(uuid).min(1).max(1000),
    query_vector: vector,
    scan_limit: z.number().int().min(1).max(2000).default(200),
  })
  .strict();
function normalized(values: number[], dimensions: number) {
  invariant(
    values.length === dimensions,
    "embedding_dimensions_mismatch",
    "Embedding dimensions do not match the configured representation",
  );
  // Scaling before normalization prevents overflow/underflow for finite inputs.
  const scale = Math.max(...values.map(Math.abs));
  invariant(
    scale > 0,
    "embedding_zero_vector",
    "A zero vector has no cosine similarity",
  );
  const scaled = values.map((v) => v / scale),
    norm = Math.hypot(...scaled);
  return scaled.map((v) => v / norm);
}
export class KnowledgeVectors {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  private partition() {
    const configured = this.config.embeddings;
    invariant(
      configured?.enabled,
      "embeddings_disabled",
      "Optional vector retrieval is disabled; use typed full-text retrieval",
    );
    return {
      ...configured,
      partition: canonical({
        model_id: configured.model_id,
        dimensions: configured.dimensions,
        normalization_version: configured.normalization_version,
      }),
    };
  }
  async put(raw: unknown, meta: Mutation) {
    const input = vectorPutSchema.parse(raw),
      active = this.partition();
    invariant(
      input.model_id === active.model_id &&
        input.dimensions === active.dimensions &&
        input.normalization_version === active.normalization_version,
      "embedding_space_mismatch",
      "Representation metadata must match the configured embedding space",
    );
    const values = normalized(input.vector, active.dimensions);
    return this.store.write(
      meta,
      { operation: "vectors.put", input },
      async (tx) => {
        const table = input.kind === "bug" ? "bugs" : "standards",
          entity = await tx
            .selectFrom(table)
            .select(["current_revision", "disposition"])
            .where("id", "=", input.id)
            .executeTakeFirst();
        invariant(
          entity && entity.disposition === "active",
          "not_found",
          "An active knowledge entity is required",
        );
        invariant(
          entity.current_revision === input.revision,
          "revision_conflict",
          "Embedding must describe the current knowledge revision",
        );
        const key = {
            entity_kind: input.kind,
            entity_id: input.id,
            revision: input.revision,
            model_id: input.model_id,
            normalization_version: active.partition,
          },
          previous = await tx
            .selectFrom("embeddings")
            .select("vector")
            .where("entity_kind", "=", input.kind)
            .where("entity_id", "=", input.id)
            .where("revision", "=", input.revision)
            .where("model_id", "=", input.model_id)
            .where("normalization_version", "=", active.partition)
            .executeTakeFirst();
        const serialized = canonical(values);
        invariant(
          !previous || previous.vector === serialized,
          "embedding_conflict",
          "Representation already exists; use a new normalization version for changes",
        );
        if (!previous)
          await tx
            .insertInto("embeddings")
            .values({
              ...key,
              dimensions: input.dimensions,
              vector: serialized,
            })
            .execute();
        return {
          id: input.id,
          revision: input.revision,
          partition: active.partition,
          status: previous ? "unchanged" : "indexed",
        };
      },
    );
  }
  async search(raw: unknown) {
    invariant(
      raw &&
        typeof raw === "object" &&
        "type_ids" in raw &&
        Array.isArray(raw.type_ids) &&
        raw.type_ids.length > 0,
      "type_scope_required",
      "Vector candidate retrieval requires controlled type IDs",
    );
    const input = vectorSearchSchema.parse(raw),
      active = this.partition(),
      queryVector = normalized(input.query_vector, active.dimensions),
      type_ids = await requireActiveTypes(this.store.db, input.type_ids),
      scope = hash(
        canonical({
          operation: "vectors.search",
          kind: input.kind,
          type_ids,
          partition: active.partition,
          queryVector,
          scan_limit: input.scan_limit,
        }),
      ),
      cursor = parseCursor(input.cursor, scope),
      watermark = cursor?.watermark ?? now(),
      revision = (
        await this.store.db
          .selectFrom("library_lock")
          .select("revision")
          .where("id", "=", 1)
          .executeTakeFirstOrThrow()
      ).revision;
    invariant(
      !cursor || cursor.revision === revision,
      "cursor_stale",
      "Knowledge changed; restart vector candidate retrieval",
    );
    const table = input.kind === "bug" ? "bugs" : "standards",
      types = input.kind === "bug" ? "bug_types" : "standard_types";
    const membership = this.store.db
      .selectFrom(types)
      .select("entity_id")
      .where("type_id", "in", type_ids)
      .groupBy("entity_id");
    let query = this.store.db
      .selectFrom("embeddings as v")
      .innerJoin(`${table} as e`, "e.id", "v.entity_id")
      .select([
        "e.id",
        "e.title",
        "e.mechanism",
        "e.rating",
        "e.current_revision",
        "v.vector",
      ])
      .where("v.entity_kind", "=", input.kind)
      .where("v.model_id", "=", active.model_id)
      .where("v.normalization_version", "=", active.partition)
      .where("v.dimensions", "=", active.dimensions)
      .whereRef("v.revision", "=", "e.current_revision")
      .where("e.disposition", "=", "active")
      .where("e.id", "in", membership)
      .where("e.created_at", "<=", watermark);
    if (cursor) query = query.where("e.id", ">", cursor.last);
    const batchSize = Math.min(input.scan_limit, input.limit),
      rows = await query
        .orderBy("e.id")
        .limit(batchSize + 1)
        .execute(),
      scanned = rows.slice(0, batchSize);
    const ranked = scanned
      .map((row) => {
        const stored = decodeJson<number[]>(row.vector);
        invariant(
          stored.length === active.dimensions && stored.every(Number.isFinite),
          "embedding_corrupt",
          "Stored embedding does not match its partition",
        );
        return {
          id: row.id,
          title: row.title,
          mechanism: boundedText(row.mechanism, 500),
          current_revision: row.current_revision,
          rating: row.rating,
          cosine_similarity: stored.reduce(
            (sum, v, i) => sum + v * queryVector[i]!,
            0,
          ),
        };
      })
      .sort(
        (a, b) =>
          b.cosine_similarity - a.cosine_similarity || a.id.localeCompare(b.id),
      );
    const after = (
      await this.store.db
        .selectFrom("library_lock")
        .select("revision")
        .where("id", "=", 1)
        .executeTakeFirstOrThrow()
    ).revision;
    invariant(
      after === revision,
      "cursor_stale",
      "Knowledge changed during vector retrieval; retry",
    );
    return {
      items: ranked,
      next_cursor:
        rows.length > batchSize
          ? makeCursor(scanned.at(-1)!.id, watermark, scope, revision)
          : null,
      coverage: {
        type_ids,
        scanned: scanned.length,
        complete: rows.length <= batchSize,
        indexed_only: true,
        partition: active.partition,
        model_id: active.model_id,
        dimensions: active.dimensions,
        normalization_version: active.normalization_version,
        meaning:
          "Cosine ranking within this bounded page of indexed current revisions; missing or unindexed entities are not evidence of uniqueness",
      },
    };
  }
}
