import { z } from "zod";
import type { Db, Mutation, Store } from "../storage/database.js";
import { invariant } from "../errors.js";
import {
  canonical,
  hash,
  id,
  makeCursor,
  normalizeName,
  now,
  parseCursor,
} from "../util.js";
import { pageSchema, typeProposalSchema, uuid } from "./schemas.js";

export async function requireActiveTypes(db: Db, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  invariant(
    unique.length > 0,
    "type_scope_required",
    "At least one controlled type is required",
  );
  const found = await db
    .selectFrom("types")
    .select("id")
    .where("id", "in", unique)
    .where("disposition", "=", "active")
    .execute();
  invariant(
    found.length === unique.length,
    "unknown_type",
    "All type IDs must refer to active controlled types",
  );
  return unique;
}

export class Taxonomy {
  constructor(readonly store: Store) {}
  async propose(raw: unknown, meta: Mutation) {
    const input = typeProposalSchema.parse(raw);
    return this.store.write(
      meta,
      { operation: "type.propose", input },
      async (tx) => {
        if (input.parent_id) await requireActiveTypes(tx, [input.parent_id]);
        const names = [
          ...new Set([input.name, ...input.aliases].map(normalizeName)),
        ];
        const collision = await tx
          .selectFrom("type_aliases")
          .select("type_id")
          .where("alias", "in", names)
          .executeTakeFirst();
        invariant(
          !collision,
          "type_name_conflict",
          "A controlled type or alias already uses this name",
        );
        const row = {
          id: id(),
          name: input.name,
          normalized_name: normalizeName(input.name),
          definition: input.definition,
          parent_id: input.parent_id ?? null,
          revision: 1,
          disposition: "candidate",
          created_at: now(),
        };
        await tx.insertInto("types").values(row).execute();
        await tx
          .insertInto("type_aliases")
          .values(names.map((alias) => ({ alias, type_id: row.id })))
          .execute();
        await tx
          .insertInto("type_revisions")
          .values({
            entity_id: row.id,
            revision: 1,
            payload: canonical({ ...row, aliases: input.aliases }),
            actor: meta.actor,
            reason: meta.reason,
            created_at: now(),
          })
          .execute();
        return { ...row, aliases: input.aliases };
      },
    );
  }
  async resolve(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        type_id: uuid,
        expected_revision: z.number().int().positive(),
        decision: z.enum(["confirm", "reject"]),
        name: z.string().min(1).max(200).optional(),
        aliases: z.array(z.string().min(1).max(200)).optional(),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "type.resolve", input },
      async (tx) => {
        const row = await tx
          .selectFrom("types")
          .selectAll()
          .where("id", "=", input.type_id)
          .executeTakeFirst();
        invariant(row, "not_found", "Type not found");
        invariant(
          row.revision === input.expected_revision,
          "revision_conflict",
          "Type revision changed",
        );
        const name = input.name ?? row.name;
        const aliases = [
          ...new Set([name, ...(input.aliases ?? [])].map(normalizeName)),
        ];
        const collision = await tx
          .selectFrom("type_aliases")
          .select("type_id")
          .where("alias", "in", aliases)
          .where("type_id", "!=", row.id)
          .executeTakeFirst();
        invariant(
          !collision,
          "type_name_conflict",
          "A name is already assigned to another type",
        );
        const revision = row.revision + 1,
          disposition = input.decision === "confirm" ? "active" : "rejected";
        if (disposition === "rejected") {
          const used = await tx
            .selectFrom("project_type_selections")
            .select("project_id")
            .where("type_id", "=", row.id)
            .executeTakeFirst();
          const bug = await tx
            .selectFrom("bug_types")
            .select("entity_id")
            .where("type_id", "=", row.id)
            .executeTakeFirst();
          const standard = await tx
            .selectFrom("standard_types")
            .select("entity_id")
            .where("type_id", "=", row.id)
            .executeTakeFirst();
          invariant(
            !used && !bug && !standard,
            "type_in_use",
            "Referenced types cannot be rejected",
          );
        }
        await tx
          .updateTable("types")
          .set({
            name,
            normalized_name: normalizeName(name),
            revision,
            disposition,
          })
          .where("id", "=", row.id)
          .execute();
        for (const alias of aliases)
          await tx
            .insertInto("type_aliases")
            .values({ alias, type_id: row.id })
            .onConflict((oc) => oc.column("alias").doNothing())
            .execute();
        const result = {
          ...row,
          name,
          normalized_name: normalizeName(name),
          revision,
          disposition,
        };
        await tx
          .insertInto("type_revisions")
          .values({
            entity_id: row.id,
            revision,
            payload: canonical({ ...result, aliases }),
            actor: meta.actor,
            reason: meta.reason,
            created_at: now(),
          })
          .execute();
        return result;
      },
    );
  }
  async resolveNames(names: string[]) {
    z.array(z.string().min(1)).max(1000).parse(names);
    if (!names.length) return [];
    return this.store.db
      .selectFrom("type_aliases")
      .innerJoin("types", "types.id", "type_aliases.type_id")
      .select(["types.id", "types.name"])
      .where("type_aliases.alias", "in", names.map(normalizeName))
      .where("types.disposition", "=", "active")
      .execute();
  }
  async list(raw: unknown = {}) {
    const input = pageSchema
      .extend({
        disposition: z
          .enum(["active", "candidate", "rejected"])
          .default("active"),
      })
      .strict()
      .parse(raw);
    const scope = hash(
      canonical({ operation: "types.list", disposition: input.disposition }),
    );
    const cursor = parseCursor(input.cursor, scope),
      watermark = cursor?.watermark ?? now();
    let query = this.store.db
      .selectFrom("types")
      .selectAll()
      .where("disposition", "=", input.disposition)
      .where("created_at", "<=", watermark);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query
      .orderBy("id")
      .limit(input.limit + 1)
      .execute();
    const items = rows.slice(0, input.limit),
      last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > input.limit && last
          ? makeCursor(last.id, watermark, scope)
          : null,
    };
  }
}
