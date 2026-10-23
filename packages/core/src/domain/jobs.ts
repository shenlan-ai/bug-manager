import { z } from "zod";
import type { Mutation, Store, Db } from "../storage/database.js";
import { invariant } from "../errors.js";
import { canonical, decodeJson, id, now } from "../util.js";
import { text, uuid } from "./schemas.js";

export class Jobs {
  constructor(readonly store: Store) {}
  async enqueue(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        kind: text.max(100),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "job.enqueue", input },
      async (tx) => {
        const row = {
          id: id(),
          kind: input.kind,
          status: "pending",
          payload: canonical(input.payload),
          result: null,
          owner_token: null,
          lease_until: 0,
          attempts: 0,
          created_at: now(),
          updated_at: now(),
        };
        await tx.insertInto("jobs").values(row).execute();
        return { ...row, payload: input.payload };
      },
    );
  }
  async claim(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        kind: text.max(100),
        lease_ms: z.number().int().min(10).max(3_600_000).default(60_000),
        job_id: uuid.optional(),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "job.claim", input },
      async (tx) => this.claimTransaction(tx, input),
    );
  }
  async claimTransaction(
    tx: Db,
    input: { kind: string; job_id?: string; lease_ms: number },
  ) {
    const timestamp = Date.now();
    let query = tx
      .selectFrom("jobs")
      .selectAll()
      .where("kind", "=", input.kind)
      .where((eb) =>
        eb.or([
          eb("status", "=", "pending"),
          eb.and([
            eb("status", "=", "running"),
            eb("lease_until", "<=", timestamp),
          ]),
        ]),
      );
    if (input.job_id) query = query.where("id", "=", input.job_id);
    const row = await query
      .orderBy("created_at")
      .orderBy("id")
      .executeTakeFirst();
    if (!row) return null;
    const change = {
      status: "running",
      owner_token: id(),
      lease_until: timestamp + input.lease_ms,
      attempts: row.attempts + 1,
      updated_at: now(),
    };
    await tx.updateTable("jobs").set(change).where("id", "=", row.id).execute();
    return { ...row, ...change, payload: decodeJson(row.payload) };
  }
  async heartbeat(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        job_id: uuid,
        owner_token: uuid,
        lease_ms: z.number().int().min(10).max(3_600_000).default(60_000),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "job.heartbeat", input },
      async (tx) => {
        const result = await tx
          .updateTable("jobs")
          .set({ lease_until: Date.now() + input.lease_ms, updated_at: now() })
          .where("id", "=", input.job_id)
          .where("owner_token", "=", input.owner_token)
          .where("status", "=", "running")
          .where("lease_until", ">", Date.now())
          .executeTakeFirst();
        invariant(
          Number(result.numUpdatedRows) === 1,
          "lease_lost",
          "Job lease expired or belongs to another worker",
        );
        return { id: input.job_id, renewed: true };
      },
    );
  }
  async complete(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        job_id: uuid,
        owner_token: uuid,
        result: z.unknown(),
        status: z
          .enum(["completed", "failed", "pending", "paused"])
          .default("completed"),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "job.complete", input },
      async (tx) => {
        const result = await tx
          .updateTable("jobs")
          .set({
            status: input.status,
            result: canonical(input.result),
            owner_token: null,
            lease_until: 0,
            updated_at: now(),
          })
          .where("id", "=", input.job_id)
          .where("owner_token", "=", input.owner_token)
          .where("status", "=", "running")
          .where("lease_until", ">", Date.now())
          .executeTakeFirst();
        invariant(
          Number(result.numUpdatedRows) === 1,
          "lease_lost",
          "Job lease expired or belongs to another worker",
        );
        return { id: input.job_id, status: input.status };
      },
    );
  }
  async get(jobId: string) {
    uuid.parse(jobId);
    const job = await this.store.db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirst();
    invariant(job, "not_found", "Job not found");
    return {
      ...job,
      payload: decodeJson(job.payload),
      result: job.result ? decodeJson(job.result) : null,
    };
  }
}
