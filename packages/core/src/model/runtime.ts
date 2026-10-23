import { z } from "zod";
import type { Config } from "../config.js";
import type { Mutation, Store } from "../storage/database.js";
import { Analysis, analysisLeaseSchema } from "../history/analysis.js";
import { bundleSchema } from "../domain/catalog.js";
import { uuid, text } from "../domain/schemas.js";
import { Jobs } from "../domain/jobs.js";
import { Projects } from "../domain/projects.js";
import { Taxonomy } from "../domain/taxonomy.js";
import { CompatibleModel } from "./provider.js";
import type { ModelUsage } from "./provider.js";
import { canonical, decodeJson, id } from "../util.js";
import { DomainError, invariant } from "../errors.js";

export const analysisRunSchema = z
  .object({
    max_segments: z.number().int().min(1).max(1000).default(10),
    trigger: z.enum(["manual", "background"]).default("manual"),
  })
  .strict();
export const analysisRunResumeSchema = z.object({ job_id: uuid }).strict();
export const classificationSchema = z
  .object({
    type_ids: z.array(uuid).max(50),
    no_findings: z.boolean(),
    reason: text,
    new_types: z
      .array(z.object({ name: text.max(200), definition: text, reason: text }))
      .max(10)
      .default([]),
  })
  .strict();
const proposalSchema = z
  .object({
    outcome: z.enum(["no_findings", "proposal"]),
    reason: text,
    proposal: bundleSchema.optional(),
  })
  .strict();
interface RunProgress {
  processed: number;
  usage: ModelUsage;
  last_error?: string;
  last_submission?: unknown;
}
interface RunResponse extends Partial<RunProgress> {
  job_id: string;
  status: string;
  result?: unknown;
}

export class ModelRuntime {
  readonly analysis: Analysis;
  readonly jobs: Jobs;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.analysis = new Analysis(store, config);
    this.jobs = new Jobs(store);
  }
  private meta(reason: string): Mutation {
    return { idempotency_key: id(), actor: "builtin-model", reason };
  }
  async start(raw: unknown, meta: Mutation) {
    const input = analysisRunSchema.parse(raw);
    invariant(
      this.config.model,
      "model_not_configured",
      "Configure a compatible model or use external analysis",
    );
    const job = await this.jobs.enqueue(
      {
        kind: "builtin_analysis",
        payload: {
          ...input,
          strategy_version: this.config.model.strategy_version,
        },
      },
      meta,
    );
    return { job_id: job.id, status: (await this.jobs.get(job.id)).status };
  }
  async resume(
    raw: unknown,
    meta: Mutation,
    signal?: AbortSignal,
  ): Promise<RunResponse> {
    const input = analysisRunResumeSchema.parse(raw),
      config = this.config.model;
    invariant(
      config,
      "model_not_configured",
      "No compatible model is configured",
    );
    const request = { operation: "model.resume", input };
    const begun = await this.store.begin(meta, request, async (tx) => {
      const current = await tx
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", input.job_id)
        .where("kind", "=", "builtin_analysis")
        .executeTakeFirst();
      invariant(current, "not_found", "Built-in analysis job not found");
      invariant(
        current.status !== "running" || current.lease_until <= Date.now(),
        "job_busy",
        "Built-in analysis is owned by another worker",
      );
      return this.jobs.claimTransaction(tx, {
        kind: "builtin_analysis",
        job_id: input.job_id,
        lease_ms: 60000,
      });
    });
    if (begun.replayed) return begun.result as RunResponse;
    const job = begun.claim;
    if (!job) {
      const current = await this.jobs.get(input.job_id);
      return this.store.write(meta, request, async () => ({
        job_id: current.id,
        status: current.status,
        result: current.result,
      }));
    }
    const payload = z
      .object({ max_segments: z.number(), strategy_version: z.string() })
      .parse(job.payload);
    const previous = job.result
      ? decodeJson<RunProgress>(job.result)
      : undefined;
    const progress: RunProgress = {
      processed: previous?.processed ?? 0,
      usage: previous?.usage ?? {
        requests: 0,
        reserved_tokens: 0,
        reported_input_tokens: 0,
        reported_output_tokens: 0,
      },
    };
    const client = new CompatibleModel(
      config,
      (this.config.privacy?.patterns ?? []).map((p) => new RegExp(p, "g")),
      async (usage) => {
        progress.usage = usage;
        await this.store.write(
          this.meta("Persist model reservations before network calls"),
          { operation: "model.usage", job_id: job.id, usage },
          async (tx) => {
            const current = await tx
              .selectFrom("jobs")
              .selectAll()
              .where("id", "=", job.id)
              .executeTakeFirstOrThrow();
            invariant(
              current.owner_token === job.owner_token &&
                current.lease_until > Date.now(),
              "lease_lost",
              "Built-in analysis lease was lost",
            );
            await tx
              .updateTable("jobs")
              .set({ result: canonical(progress) })
              .where("id", "=", job.id)
              .execute();
            return { saved: true };
          },
        );
      },
    );
    Object.assign(client.usage, progress.usage);
    let active: z.infer<typeof analysisLeaseSchema> | undefined,
      status = "pending";
    const heartbeat = setInterval(() => {
      void this.jobs
        .heartbeat(
          { job_id: job.id, owner_token: job.owner_token },
          this.meta("Renew model job lease"),
        )
        .catch(() => undefined);
      if (active)
        void this.analysis
          .heartbeat(active, this.meta("Renew model segment lease"))
          .catch(() => undefined);
    }, 20000);
    try {
      invariant(
        payload.strategy_version === config.strategy_version,
        "model_strategy_changed",
        "Resume using the original strategy configuration or start explicit reanalysis",
      );
      const claim = await this.analysis.claim(
        {},
        this.meta("Claim source for built-in extraction"),
      );
      if (!claim) {
        status = "completed";
      } else {
        active = { task_id: claim.task_id, owner_token: claim.owner_token };
        const source = await this.analysis.context(active);
        const types = await new Taxonomy(this.store).list({
          limit: 200,
          disposition: "active",
        });
        const dictionary = types.items.map((t) => ({
          id: t.id,
          name: t.name,
          definition: t.definition.slice(0, 300),
        }));
        const classification = await client.request(
          classificationSchema,
          "classify_history",
          "Identify all applicable controlled types for eligible concrete Bug or prevention knowledge. A Bug is eligible only when the source contains a user-authored problem report, or user-authored guidance to inspect a stated scope followed by an assistant/tool finding within that scope. Exclude failures discovered only through tests the agent wrote or selected on its own, and exclude unattributed autonomous audit findings. Agent-authored test failures can inform a prevention standard only when a human-origin Bug in the same evidence scope independently calls for that standard. No keyword-only selection. If none exists, propose new types; do not invent UUIDs.",
          {
            source,
            types: dictionary,
            type_dictionary_truncated: !!types.next_cursor,
          },
          signal,
        );
        for (const suggestion of classification.new_types)
          await new Taxonomy(this.store).propose(
            { name: suggestion.name, definition: suggestion.definition },
            this.meta(suggestion.reason),
          );
        if (classification.no_findings)
          progress.last_submission = await this.analysis.submit(
            {
              ...active,
              outcome: "no_findings",
              reason: classification.reason,
            },
            this.meta("Record explicit no-findings model result"),
          );
        else {
          invariant(
            classification.type_ids.length > 0,
            "classification_pending",
            "No confirmed types identified; proposed types need confirmation",
          );
          const context = await this.analysis.context({
            ...active,
            type_ids: classification.type_ids,
          });
          const retrieval = context.retrieval as { retrieval_id: string };
          const proposal = await client.request(
            proposalSchema,
            "extract_knowledge",
            "Independently maintain Bugs and acceptance standards. Every Bug requires discovery.origin=human_reported with user-authored human_report evidence, or discovery.origin=human_guided_review with both user-authored human_guidance and assistant/tool agent_finding evidence for the same human-directed scope. Never include a Bug found only by tests the agent wrote or selected itself, or by an unattributed autonomous audit. Reuse compatible existing standards through IDs. Provide executable scenarios and independent S0-S3 / I0-I3 reasons. Quote actual source excerpts as evidence and make discovery excerpt role exact. Missing or ambiguous evidence must be uncertain. No repair status, release decision or acceptance execution. Use new/enrich/link through the bundle contract; existing edits require expected_revision.",
            {
              context,
              classified_type_ids: classification.type_ids,
              proposal_contract:
                "bugs and standards are independent arrays; refs identify new entities; links can reference existing IDs",
            },
            signal,
          );
          progress.last_submission = await this.analysis.submit(
            { ...active, ...proposal, retrieval_id: retrieval.retrieval_id },
            this.meta(
              "Commit built-in proposal through shared external-analysis validation",
            ),
          );
        }
        active = undefined;
        progress.processed++;
        if (progress.processed >= payload.max_segments) status = "completed";
      }
    } catch (error) {
      progress.last_error =
        error instanceof DomainError ? error.code : "model_operation_failed";
      if (active)
        await this.analysis
          .release(
            {
              ...active,
              failed: progress.last_error !== "model_budget_exhausted",
              code: progress.last_error,
            },
            this.meta("Keep failed or budget-limited analysis resumable"),
          )
          .catch(() => undefined);
      status =
        progress.last_error === "model_budget_exhausted" ? "paused" : "pending";
    } finally {
      clearInterval(heartbeat);
    }
    return this.store.write(meta, request, async (tx) => {
      const saved = await tx
        .updateTable("jobs")
        .set({
          status,
          result: canonical(progress),
          owner_token: null,
          lease_until: 0,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", job.id)
        .where("status", "=", "running")
        .where("owner_token", "=", job.owner_token)
        .where("lease_until", ">", Date.now())
        .executeTakeFirst();
      invariant(
        Number(saved.numUpdatedRows) === 1,
        "lease_lost",
        "Built-in analysis lease was lost",
      );
      return { job_id: job.id, status, ...progress };
    });
  }
  async control(raw: unknown, meta: Mutation) {
    const input = z
      .object({
        job_id: uuid,
        action: z.enum(["pause", "resume"]),
        renew_budget: z.boolean().default(false),
      })
      .strict()
      .parse(raw);
    return this.store.write(
      meta,
      { operation: "analysis.run.control", input },
      async (tx) => {
        const job = await tx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", input.job_id)
          .where("kind", "=", "builtin_analysis")
          .executeTakeFirst();
        invariant(job, "not_found", "Built-in analysis job not found");
        invariant(
          job.status !== "running" || job.lease_until <= Date.now(),
          "job_busy",
          "Wait for the bounded model batch before changing its state",
        );
        const result = job.result
          ? decodeJson<RunProgress>(job.result)
          : undefined;
        if (input.renew_budget && result)
          result.usage = {
            requests: 0,
            reserved_tokens: 0,
            reported_input_tokens: 0,
            reported_output_tokens: 0,
          };
        await tx
          .updateTable("jobs")
          .set({
            status: input.action === "pause" ? "paused" : "pending",
            owner_token: null,
            lease_until: 0,
            result: result ? canonical(result) : null,
          })
          .where("id", "=", job.id)
          .execute();
        return {
          job_id: job.id,
          status: input.action === "pause" ? "paused" : "pending",
          budget_renewed: input.renew_budget,
        };
      },
    );
  }
  async selectProjectTypes(raw: unknown, meta: Mutation, signal?: AbortSignal) {
    const input = z
        .object({
          project_id: uuid,
          expected_revision: z.number().int().nonnegative(),
          description: text,
        })
        .strict()
        .parse(raw),
      config = this.config.model;
    invariant(
      config,
      "model_not_configured",
      "No compatible model is configured",
    );
    const request = { operation: "project.types.select", input };
    const replay = await this.store.replay<
      Awaited<ReturnType<Projects["setTypes"]>>
    >(meta, request);
    if (replay.found) return replay.result;
    const projects = new Projects(this.store),
      current = await projects.types(input.project_id),
      types = await new Taxonomy(this.store).list({
        limit: 200,
        disposition: "active",
      });
    invariant(
      current.revision === input.expected_revision,
      "revision_conflict",
      "Project type configuration changed",
    );
    const client = new CompatibleModel(
      config,
      (this.config.privacy?.patterns ?? []).map((p) => new RegExp(p, "g")),
    );
    const selection = await client.request(
      z
        .object({ type_ids: z.array(uuid).min(1).max(200), reason: text })
        .strict(),
      "select_project_types",
      "Select the complete controlled type set relevant to the described project. These are explicit saved acceptance boundaries, with no implicit parent/child expansion.",
      {
        project_description: input.description,
        current,
        types: types.items.map((t) => ({
          id: t.id,
          name: t.name,
          definition: t.definition.slice(0, 300),
        })),
        dictionary_truncated: !!types.next_cursor,
      },
      signal,
    );
    return this.store.write(meta, request, (tx) =>
      projects.setTypesTransaction(
        tx,
        {
          project_id: input.project_id,
          type_ids: selection.type_ids,
          expected_revision: input.expected_revision,
        },
        {
          ...meta,
          reason: `${meta.reason}; ${selection.reason}`.slice(0, 4000),
        },
      ),
    );
  }
}
