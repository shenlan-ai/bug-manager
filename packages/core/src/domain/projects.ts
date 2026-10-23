import path from "node:path";
import { z } from "zod";
import type { Transaction } from "kysely";
import type { Schema } from "../storage/schema.js";
import type { Mutation, Store } from "../storage/database.js";
import { invariant } from "../errors.js";
import { canonical, decodeJson, id, normalizePath, now } from "../util.js";
import {
  projectRegistrationSchema,
  typeSelectionSchema,
  uuid,
} from "./schemas.js";
import { requireActiveTypes } from "./taxonomy.js";

export class Projects {
  constructor(readonly store: Store) {}
  async register(raw: unknown, meta: Mutation) {
    const input = projectRegistrationSchema.parse(raw),
      location = await normalizePath(input.directory);
    return this.store.write(
      meta,
      {
        operation: "project.register",
        input: { ...input, directory: location },
      },
      async (tx) => {
        const mapped = await tx
          .selectFrom("project_locations")
          .selectAll()
          .where("location", "=", location)
          .executeTakeFirst();
        if (mapped) {
          invariant(
            !input.project_id || input.project_id === mapped.project_id,
            "project_mapping_conflict",
            "Directory already belongs to another project",
          );
          const existing = await tx
            .selectFrom("projects")
            .selectAll()
            .where("id", "=", mapped.project_id)
            .executeTakeFirstOrThrow();
          return existing;
        }
        let project;
        if (input.project_id) {
          project = await tx
            .selectFrom("projects")
            .selectAll()
            .where("id", "=", input.project_id)
            .executeTakeFirst();
          invariant(project, "not_found", "Project not found");
        } else {
          project = {
            id: id(),
            name: input.name,
            revision: 0,
            metadata: canonical({}),
            created_at: now(),
          };
          await tx.insertInto("projects").values(project).execute();
        }
        await tx
          .insertInto("project_locations")
          .values({
            location,
            project_id: project.id,
            repository_hint: input.repository_hint ?? null,
            reason: meta.reason,
            actor: meta.actor,
          })
          .execute();
        return project;
      },
    );
  }
  async resolve(directory: string, repositoryHint?: string) {
    z.string().min(1).parse(directory);
    const location = await normalizePath(directory),
      ancestors = [location];
    for (
      let current = path.dirname(location);
      current !== ancestors.at(-1);
      current = path.dirname(current)
    ) {
      ancestors.push(current);
    }
    const mappings = await this.store.db
      .selectFrom("project_locations")
      .selectAll()
      .where("location", "in", ancestors)
      .execute();
    const match = mappings.sort(
      (a, b) => b.location.length - a.location.length,
    )[0];
    if (match)
      return {
        status: "mapped" as const,
        project: await this.get(match.project_id),
        location: match.location,
      };
    const candidates = repositoryHint
      ? await this.store.db
          .selectFrom("project_locations")
          .select("project_id")
          .distinct()
          .where("repository_hint", "=", repositoryHint)
          .limit(50)
          .execute()
      : [];
    return {
      status: candidates.length
        ? ("uncertain" as const)
        : ("unmapped" as const),
      candidates: candidates.map((c) => c.project_id),
      reason:
        "Explicit directory mapping required; repository hint alone does not establish identity",
    };
  }
  async get(projectId: string) {
    uuid.parse(projectId);
    const row = await this.store.db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();
    invariant(row, "not_found", "Project not found");
    return row;
  }
  async types(projectId: string) {
    const project = await this.get(projectId);
    const revision = await this.store.db
      .selectFrom("project_type_revisions")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("revision", "=", project.revision)
      .executeTakeFirst();
    return {
      project_id: project.id,
      revision: project.revision,
      type_ids: revision ? decodeJson<string[]>(revision.type_ids) : [],
      reason: revision?.reason ?? null,
      actor: revision?.actor ?? null,
    };
  }
  async setTypes(raw: unknown, meta: Mutation) {
    const input = typeSelectionSchema.parse(raw);
    return this.store.write(
      meta,
      { operation: "project.types.set", input },
      (tx) => this.setTypesTransaction(tx, input, meta),
    );
  }
  async setTypesTransaction(
    tx: Transaction<Schema>,
    input: z.infer<typeof typeSelectionSchema>,
    meta: Mutation,
  ) {
    const project = await tx
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", input.project_id)
      .executeTakeFirst();
    invariant(project, "not_found", "Project not found");
    invariant(
      project.revision === input.expected_revision,
      "revision_conflict",
      "Project type selection changed",
    );
    const type_ids = await requireActiveTypes(tx, input.type_ids),
      revision = project.revision + 1;
    await tx
      .updateTable("projects")
      .set({ revision })
      .where("id", "=", project.id)
      .execute();
    await tx
      .deleteFrom("project_type_selections")
      .where("project_id", "=", project.id)
      .execute();
    await tx
      .insertInto("project_type_selections")
      .values(
        type_ids.map((type_id) => ({
          project_id: project.id,
          type_id,
          selection_revision: revision,
        })),
      )
      .execute();
    await tx
      .insertInto("project_type_revisions")
      .values({
        project_id: project.id,
        revision,
        type_ids: canonical(type_ids),
        reason: meta.reason,
        actor: meta.actor,
        created_at: now(),
      })
      .execute();
    return {
      project_id: project.id,
      revision,
      type_ids,
      reason: meta.reason,
      actor: meta.actor,
    };
  }
}
