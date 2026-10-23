import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema, KnowledgeVectors } from "@bug-manager/core";
import { fixture, mutation, standard } from "../helpers.js";

for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} optional vectors`, () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture(backend);
    });
    afterEach(async () => {
      await f?.cleanup();
    });
    it("DED-002/007 isolates model, dimensions and version without touching knowledge or requiring vectors for full-text", async () => {
      const type = (await f.type("重试")).id,
        otherType = (await f.type("布局")).id,
        saved = await f.catalog.apply(
          {
            standards: [
              { ref: "in", record: standard([type]) },
              {
                ref: "other",
                record: standard([otherType], { title: "Unselected type" }),
              },
              {
                ref: "second",
                record: standard([type], { title: "Second typed standard" }),
              },
            ],
          },
          mutation(),
        ),
        config = configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          embeddings: {
            enabled: true,
            model_id: "synthetic-provider/model-a",
            dimensions: 2,
            normalization_version: "v1",
          },
        }),
        vectors = new KnowledgeVectors(f.store, config),
        input = {
          kind: "standard",
          id: saved.entities[0]!.id,
          revision: 1,
          model_id: config.embeddings!.model_id,
          dimensions: 2,
          normalization_version: "v1",
          vector: [1, 0],
        };
      for (const entity of saved.entities)
        await vectors.put({ ...input, id: entity.id }, mutation());
      expect((await vectors.put(input, mutation())).status).toBe("unchanged");
      await expect(
        vectors.put({ ...input, vector: [0, 1] }, mutation()),
      ).rejects.toHaveProperty("code", "embedding_conflict");
      await expect(
        vectors.put({ ...input, vector: [1] }, mutation()),
      ).rejects.toHaveProperty("code", "embedding_dimensions_mismatch");
      await expect(
        vectors.put({ ...input, vector: [0, 0] }, mutation()),
      ).rejects.toHaveProperty("code", "embedding_zero_vector");
      const first = await vectors.search({
        kind: "standard",
        type_ids: [type],
        query_vector: [1, 0],
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.next_cursor).toBeTruthy();
      expect(first.coverage.complete).toBe(false);
      const next = await vectors.search({
        kind: "standard",
        type_ids: [type],
        query_vector: [1, 0],
        limit: 1,
        cursor: first.next_cursor,
      });
      expect(next.items).toHaveLength(1);
      expect(
        new Set([...first.items, ...next.items].map((i) => i.id)).size,
      ).toBe(2);
      expect(
        [...first.items, ...next.items].every(
          (i) => i.id !== saved.entities[1]!.id && i.cosine_similarity === 1,
        ),
      ).toBe(true);
      for (const changed of [
        { model_id: "synthetic-provider/model-b" },
        { dimensions: 3 },
        { normalization_version: "v2" },
      ]) {
        const swapped = new KnowledgeVectors(f.store, {
          ...config,
          embeddings: { ...config.embeddings!, ...changed },
        });
        expect(
          (
            await swapped.search({
              kind: "standard",
              type_ids: [type],
              query_vector: changed.dimensions ? [1, 0, 0] : [1, 0],
            })
          ).items,
        ).toHaveLength(0);
        await expect(swapped.put(input, mutation())).rejects.toHaveProperty(
          "code",
          "embedding_space_mismatch",
        );
      }
      await f.catalog.apply(
        {
          standards: [
            {
              ref: "changed",
              id: input.id,
              expected_revision: 1,
              record: standard([type], { title: "Changed current revision" }),
            },
          ],
        },
        mutation(),
      );
      expect(
        (
          await vectors.search({
            kind: "standard",
            type_ids: [type],
            query_vector: [1, 0],
          })
        ).items.map((i) => i.id),
      ).not.toContain(input.id);
      await expect(vectors.put(input, mutation())).rejects.toHaveProperty(
        "code",
        "revision_conflict",
      );
      const disabled = new KnowledgeVectors(f.store, {
        ...config,
        embeddings: { ...config.embeddings!, enabled: false },
      });
      await expect(
        disabled.search({
          kind: "standard",
          type_ids: [type],
          query_vector: [1, 0],
        }),
      ).rejects.toHaveProperty("code", "embeddings_disabled");
      expect(
        (
          await f.catalog.search("standard", {
            type_ids: [type],
            query: "幂等",
          })
        ).items,
      ).toHaveLength(2);
      expect(
        await f.store.db.selectFrom("embeddings").select("entity_id").execute(),
      ).toHaveLength(3);
    });
  });
