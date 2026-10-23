import { z } from "zod";
import type { Transaction } from "kysely";
import type { Config } from "../config.js";
import type { Store, Mutation } from "../storage/database.js";
import type { Schema } from "../storage/schema.js";
import { invariant } from "../errors.js";
import {
  canonical,
  decodeJson,
  hash,
  id,
  now,
  makeCursor,
  parseCursor,
} from "../util.js";
import { redactValue } from "../privacy.js";
import { HistoryIngestion } from "../history/ingestion.js";
import { ModelRuntime } from "../model/runtime.js";
import { pageSchema, text, uuid } from "./schemas.js";
import type { Standard } from "./schemas.js";
import type { ChangeSnapshot } from "./changes.js";
type Scalar = string | number | boolean;
const scalar = z.union([
  z.string().max(20000),
  z.number().finite(),
  z.boolean(),
]);
export const selectionDecisionSchema = z
  .object({
    standard_id: uuid,
    standard_revision: z.number().int().positive(),
    decision: z.enum(["selected", "skipped", "unresolved"]),
    reason: text,
  })
  .strict();
export const planCreateSchema = z
  .object({
    project_id: uuid,
    change_id: uuid,
    mode: z.enum(["changes", "full"]).default("changes"),
    no_sync: z.boolean().default(false),
    sync_budget_ms: z.number().int().min(1).max(60000).default(3000),
    analysis: z.enum(["external", "builtin"]).default("external"),
    expected_project_revision: z.number().int().nonnegative().optional(),
    parameters: z.record(z.string(), scalar).default({}),
    standard_parameters: z
      .record(z.string(), z.record(z.string(), scalar))
      .default({}),
    decisions: z.array(selectionDecisionSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.decisions.map((d) => d.standard_id)).size !==
      input.decisions.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Selection standard IDs must be unique",
      });
  });
export const planPageSchema = pageSchema.extend({ plan_id: uuid }).strict();
export interface PlanItem {
  standard_id: string;
  standard_revision: number;
  record: Standard;
  selection: {
    decision: "selected" | "skipped" | "unresolved";
    reason: string;
    included: boolean;
    executor_proposal?: unknown;
  };
  resolved_parameters: Record<string, Scalar>;
  unresolved_parameters: string[];
}
export interface PlanSnapshot {
  schema_version: 1;
  project_id: string;
  project_name: string;
  project_types_revision: number;
  selected_type_ids: string[];
  selected_types: unknown[];
  type_selection: { reason: string; actor: string };
  change_id: string;
  change_content_hash: string;
  change_snapshot: ChangeSnapshot;
  history_freshness: Awaited<ReturnType<HistoryIngestion["freshness"]>> & {
    synchronization: Record<string, unknown>;
  };
  mode: "changes" | "full";
  selector_version: string;
  created_at: string;
  knowledge_revision: number;
  totals: {
    eligible: number;
    included: number;
    selected: number;
    skipped: number;
    unresolved: number;
  };
  actor: string;
  reason: string;
  basis_plan_id?: string;
}
export class AcceptancePlans {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  private meta(meta: Mutation, suffix: string): Mutation {
    return {
      ...meta,
      idempotency_key: `plan:${hash(meta.idempotency_key + ":" + suffix)}`,
      reason: `Prepare acceptance plan: ${suffix}`,
    };
  }
  async create(raw: unknown, meta: Mutation) {
    const input = planCreateSchema.parse(raw),
      request = { operation: "acceptance.plan", input };
    const replay = await this.store.replay<{
      plan_id: string;
      totals: PlanSnapshot["totals"];
    }>(meta, request);
    if (replay.found) return replay.result;
    const synchronization: Record<string, unknown> = {
      mode: input.no_sync ? "no-sync" : "incremental",
      requested_analysis: input.analysis,
    };
    const history = new HistoryIngestion(this.store, this.config);
    if (input.no_sync) synchronization.status = "explicitly_skipped";
    else if (!this.config.history.length)
      synchronization.status = "sources_not_configured";
    else {
      const deadline = Date.now() + input.sync_budget_ms,
        signal = AbortSignal.timeout(input.sync_budget_ms);
      const sync = await history.start(
        {
          trigger: "lazy",
          analysis: input.analysis,
          max_files: 20,
          max_bytes: 128 * 1024,
        },
        this.meta(meta, "sync-start"),
      );
      synchronization.job_id = sync.job_id;
      let complete = false;
      for (let batch = 0; batch < 20 && Date.now() < deadline; batch++) {
        const result = await history.resume(
          { job_id: sync.job_id },
          this.meta(meta, `sync-${batch}`),
          signal,
        );
        if (result.status === "completed") {
          complete = true;
          break;
        }
      }
      synchronization.status = complete ? "collected" : "partial";
      if (input.analysis === "builtin") {
        if (!this.config.model || !process.env[this.config.model.api_key_env])
          synchronization.analysis_status = "external_pending_no_model_key";
        else if (Date.now() < deadline) {
          const models = new ModelRuntime(this.store, this.config),
            job = await models.start(
              { max_segments: 20 },
              this.meta(meta, "model-start"),
            );
          synchronization.analysis_job_id = job.job_id;
          for (let batch = 0; batch < 20 && Date.now() < deadline; batch++) {
            const result = await models.resume(
              { job_id: job.job_id },
              this.meta(meta, `model-${batch}`),
              signal,
            );
            synchronization.analysis_status = result.status;
            if (result.status !== "pending") break;
          }
        } else synchronization.analysis_status = "pending_budget_expired";
      } else synchronization.analysis_status = "external";
    }
    return this.store.write(meta, request, async (tx) => {
      const project = await tx
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", input.project_id)
        .executeTakeFirst();
      invariant(project, "not_found", "Project not found");
      invariant(
        input.expected_project_revision === undefined ||
          input.expected_project_revision === project.revision,
        "revision_conflict",
        "Project type selection changed",
      );
      const selection = await tx
        .selectFrom("project_type_revisions")
        .selectAll()
        .where("project_id", "=", project.id)
        .where("revision", "=", project.revision)
        .executeTakeFirst();
      const type_ids = selection
        ? decodeJson<string[]>(selection.type_ids)
        : [];
      invariant(
        type_ids.length > 0,
        "type_configuration_required",
        "Explicitly select project types before planning",
      );
      const change = await tx
        .selectFrom("change_snapshots")
        .selectAll()
        .where("id", "=", input.change_id)
        .executeTakeFirst();
      invariant(change, "not_found", "Change snapshot not found");
      invariant(
        change.project_id === project.id,
        "project_mismatch",
        "Change snapshot belongs to another project",
      );
      const selected_types = await tx
        .selectFrom("types")
        .select(["id", "name", "definition", "revision"])
        .where("id", "in", type_ids)
        .execute();
      const knowledge = await tx
        .selectFrom("library_lock")
        .select("revision")
        .where("id", "=", 1)
        .executeTakeFirstOrThrow();
      const totals = {
        eligible: 0,
        included: 0,
        selected: 0,
        skipped: 0,
        unresolved: 0,
      };
      const snapshot: PlanSnapshot = {
        schema_version: 1,
        project_id: project.id,
        project_name: project.name,
        project_types_revision: project.revision,
        selected_type_ids: type_ids,
        selected_types,
        type_selection: { reason: selection!.reason, actor: selection!.actor },
        change_id: change.id,
        change_content_hash: change.content_hash,
        change_snapshot: decodeJson(change.snapshot),
        history_freshness: {
          ...(await history.freshness(tx)),
          synchronization,
        },
        mode: input.mode,
        selector_version: "explicit-or-conservative-v1",
        created_at: now(),
        knowledge_revision: knowledge.revision,
        totals,
        actor: meta.actor,
        reason: meta.reason,
      };
      const plan_id = id();
      await tx
        .insertInto("acceptance_plans")
        .values({
          id: plan_id,
          project_id: project.id,
          snapshot: canonical(snapshot),
          created_at: snapshot.created_at,
        })
        .execute();
      const decisions = new Map(input.decisions.map((d) => [d.standard_id, d]));
      let after = "";
      while (true) {
        const rows = await tx
          .selectFrom("standards as s")
          .innerJoin("standard_revisions as r", (join) =>
            join
              .onRef("r.entity_id", "=", "s.id")
              .onRef("r.revision", "=", "s.current_revision"),
          )
          .select(["s.id", "s.current_revision", "r.payload"])
          .where("s.disposition", "=", "active")
          .where("s.id", ">", after)
          .where(
            "s.id",
            "in",
            tx
              .selectFrom("standard_types")
              .select("entity_id")
              .where("type_id", "in", type_ids),
          )
          .orderBy("s.id")
          .limit(200)
          .execute();
        for (const row of rows) {
          const proposal = decisions.get(row.id);
          if (proposal)
            invariant(
              proposal.standard_revision === row.current_revision,
              "revision_conflict",
              "Selection refers to a different standard revision",
            );
          const record = decodeJson<{ record: Standard }>(row.payload).record;
          const item = this.bind(
            row.id,
            row.current_revision,
            record,
            input.mode,
            proposal,
            input.parameters,
            input.standard_parameters[row.id] ?? {},
          );
          await this.insertItem(tx, plan_id, item, totals);
          decisions.delete(row.id);
        }
        if (rows.length < 200) break;
        after = rows.at(-1)!.id;
      }
      invariant(
        decisions.size === 0,
        "selection_out_of_scope",
        "Selection references a standard outside the frozen active project type scope",
      );
      await tx
        .updateTable("acceptance_plans")
        .set({ snapshot: canonical(snapshot) })
        .where("id", "=", plan_id)
        .execute();
      return { plan_id, totals };
    });
  }
  bind(
    standard_id: string,
    standard_revision: number,
    record: Standard,
    mode: "changes" | "full",
    proposal: z.infer<typeof selectionDecisionSchema> | undefined,
    parameters: Record<string, Scalar>,
    specific: Record<string, Scalar>,
  ): PlanItem {
    let selection: PlanItem["selection"];
    if (record.importance === "I0")
      selection = {
        decision: "selected",
        included: true,
        reason: "I0 is required within the saved project type scope",
        executor_proposal: proposal,
      };
    else if (mode === "full")
      selection = {
        decision: "selected",
        included: true,
        reason: "Full mode includes every active in-scope standard",
        executor_proposal: proposal,
      };
    else if (proposal)
      selection = {
        decision: proposal.decision,
        included: proposal.decision !== "skipped",
        reason: proposal.reason,
      };
    else
      selection = {
        decision: "unresolved",
        included: true,
        reason: "No relevance judgement supplied; conservatively included",
      };
    const resolved_parameters: Record<string, Scalar> = Object.create(
        null,
      ) as Record<string, Scalar>,
      unresolved_parameters: string[] = [];
    for (const parameter of record.parameters) {
      const value =
        specific[parameter.name] ??
        parameters[parameter.name] ??
        parameter.default;
      if (value === undefined) {
        if (parameter.required) unresolved_parameters.push(parameter.name);
        continue;
      }
      invariant(
        typeof value === parameter.type,
        "invalid_parameter",
        "Parameter type differs from the frozen definition",
      );
      resolved_parameters[parameter.name] = value;
    }
    return {
      standard_id,
      standard_revision,
      record,
      selection,
      resolved_parameters,
      unresolved_parameters,
    };
  }
  async insertItem(
    tx: Transaction<Schema>,
    plan_id: string,
    item: PlanItem,
    totals: PlanSnapshot["totals"],
  ) {
    totals.eligible++;
    totals[item.selection.decision]++;
    if (item.selection.included) totals.included++;
    const safe = redactValue(
      item,
      (this.config.privacy?.patterns ?? []).map((p) => new RegExp(p, "g")),
    ) as PlanItem;
    await tx
      .insertInto("plan_selection_decisions")
      .values({
        plan_id,
        standard_id: item.standard_id,
        payload: canonical({
          standard_id: item.standard_id,
          standard_revision: item.standard_revision,
          title: safe.record.title,
          importance: safe.record.importance,
          type_ids: safe.record.type_ids,
          ...safe.selection,
        }),
      })
      .execute();
    if (item.selection.included)
      await tx
        .insertInto("plan_items")
        .values({
          id: id(),
          plan_id,
          standard_id: item.standard_id,
          standard_revision: item.standard_revision,
          payload: canonical(safe),
        })
        .execute();
  }
  async get(plan_id: string) {
    uuid.parse(plan_id);
    const row = await this.store.db
      .selectFrom("acceptance_plans")
      .selectAll()
      .where("id", "=", plan_id)
      .executeTakeFirst();
    invariant(row, "not_found", "Acceptance plan not found");
    return {
      plan_id: row.id,
      snapshot: decodeJson<PlanSnapshot>(row.snapshot),
    };
  }
  async items(raw: unknown) {
    const input = planPageSchema.parse(raw);
    await this.get(input.plan_id);
    const scope = hash(
        canonical({ operation: "plan.items", plan_id: input.plan_id }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("plan_items")
      .selectAll()
      .where("plan_id", "=", input.plan_id);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query
      .orderBy("id")
      .limit(input.limit + 1)
      .execute();
    return {
      items: rows
        .slice(0, input.limit)
        .map((row) => ({ ...row, payload: decodeJson<PlanItem>(row.payload) })),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.id, now(), scope)
          : null,
    };
  }
  async decisions(raw: unknown) {
    const input = planPageSchema.parse(raw);
    await this.get(input.plan_id);
    const scope = hash(
        canonical({ operation: "plan.decisions", plan_id: input.plan_id }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("plan_selection_decisions")
      .selectAll()
      .where("plan_id", "=", input.plan_id);
    if (cursor) query = query.where("standard_id", ">", cursor.last);
    const rows = await query
      .orderBy("standard_id")
      .limit(input.limit + 1)
      .execute();
    return {
      items: rows.slice(0, input.limit).map((row) => decodeJson(row.payload)),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.standard_id, now(), scope)
          : null,
    };
  }
}
