import { z } from "zod";
import type { Store, Mutation } from "../storage/database.js";
import type { Config } from "../config.js";
import { DomainError, invariant } from "../errors.js";
import {
  canonical,
  decodeJson,
  hash,
  id,
  now,
  makeCursor,
  parseCursor,
} from "../util.js";
import { redact, redactValue } from "../privacy.js";
import { EvidenceStore } from "../storage/evidence.js";
import { pageSchema, text, uuid } from "./schemas.js";
import { AcceptancePlans } from "./plans.js";
import type { PlanItem } from "./plans.js";

export const outcomeSchema = z.enum([
  "passed",
  "failed",
  "blocked",
  "not_run",
  "not_applicable",
]);
export type Outcome = z.infer<typeof outcomeSchema>;
const evidenceSchema = z
  .object({
    requirement_key: text.max(200).optional(),
    kind: z.enum(["log", "screenshot", "test_report", "observation", "other"]),
    purpose: text,
    collected_at: z.iso.datetime({ offset: true }),
    media_type: text.max(200),
    step_indexes: z.array(z.number().int().nonnegative()).max(1000).default([]),
    source: z.discriminatedUnion("storage", [
      z.object({ storage: z.literal("inbox"), path: text }).strict(),
      z.object({ storage: z.literal("inline"), text: text }).strict(),
      z.object({ storage: z.literal("external"), reference: text }).strict(),
    ]),
  })
  .strict();
export const scenarioResultSchema = z
  .object({
    scenario_id: text.max(200),
    outcome: outcomeSchema,
    reason: text.optional(),
    observations: z
      .array(
        z
          .object({
            step_index: z.number().int().nonnegative(),
            expected: text,
            actual: text,
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    evidence: z.array(evidenceSchema).max(200).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.outcome !== "passed" && !input.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Non-passed declarations require an explicit reason",
      });
    if (
      new Set(input.observations.map((o) => o.step_index)).size !==
      input.observations.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["observations"],
        message: "Observation step indexes must be unique",
      });
  });
export const resultSubmitSchema = z
  .object({
    plan_id: uuid,
    plan_item_id: uuid,
    standard_id: uuid,
    standard_revision: z.number().int().positive(),
    execution_id: uuid,
    attempt_id: uuid,
    change_id: uuid,
    environment: z
      .object({
        project_version: text,
        change_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
        platform: text,
        description: text.optional(),
        tool_versions: z.record(z.string(), text).default({}),
      })
      .strict(),
    scenarios: z.array(scenarioResultSchema).max(100),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.scenarios.map((s) => s.scenario_id)).size !==
      input.scenarios.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Scenario IDs must be unique within an attempt",
      });
  });
export interface EvidenceView {
  id: string;
  scenario_id: string;
  requirement_key?: string;
  kind: string;
  purpose: string;
  collected_at: string;
  media_type: string;
  step_indexes: number[];
  object_key: string | null;
  content_hash: string | null;
  availability: string;
  external_reference?: string;
  size_bytes?: number;
  availability_at_export?: string;
}
export interface Attempt {
  execution_id: string;
  attempt_id: string;
  submission_hash: string;
  environment: z.infer<typeof resultSubmitSchema>["environment"];
  scenarios: Array<
    Omit<z.infer<typeof scenarioResultSchema>, "evidence"> & {
      evidence: EvidenceView[];
    }
  >;
}
export function aggregate(outcomes: Outcome[]): Outcome {
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("blocked")) return "blocked";
  if (!outcomes.length || outcomes.includes("not_run")) return "not_run";
  if (outcomes.every((s) => s === "not_applicable")) return "not_applicable";
  return "passed";
}
export class AcceptanceResults {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  async submit(raw: unknown, meta: Mutation) {
    const input = resultSubmitSchema.parse(raw),
      patterns = (this.config.privacy?.patterns ?? []).map(
        (p) => new RegExp(p, "g"),
      );
    const safe = resultSubmitSchema.parse(redactValue(input, patterns)),
      request = { operation: "acceptance.result.submit", input: safe };
    const replay = await this.store.replay<{
      result_id: string;
      outcome: Outcome;
    }>(meta, request);
    if (replay.found) return replay.result;
    const plan = await new AcceptancePlans(this.store, this.config).get(
      input.plan_id,
    );
    invariant(
      plan.snapshot.change_id === input.change_id &&
        plan.snapshot.change_content_hash ===
          input.environment.change_content_hash,
      "execution_context_mismatch",
      "Execution must reference the plan's frozen change snapshot",
    );
    const row = await this.store.db
      .selectFrom("plan_items")
      .selectAll()
      .where("id", "=", input.plan_item_id)
      .where("plan_id", "=", input.plan_id)
      .executeTakeFirst();
    invariant(
      row,
      "plan_item_mismatch",
      "Plan item does not belong to the plan",
    );
    invariant(
      row.standard_id === input.standard_id &&
        row.standard_revision === input.standard_revision,
      "revision_conflict",
      "Result must use the frozen standard ID and revision",
    );
    const item = decodeJson<PlanItem>(row.payload);
    const submission_hash = hash(canonical(safe));
    const previous = await this.store.db
      .selectFrom("acceptance_results")
      .selectAll()
      .where("plan_item_id", "=", row.id)
      .where("attempt_id", "=", input.attempt_id)
      .executeTakeFirst();
    if (previous) {
      invariant(
        decodeJson<Attempt>(previous.payload).submission_hash ===
          submission_hash,
        "attempt_conflict",
        "Attempt ID already contains another submission",
      );
      return this.store.write(meta, request, async () => ({
        result_id: previous.id,
        outcome: previous.outcome as Outcome,
      }));
    }
    const evidenceStore = new EvidenceStore(
      this.config.evidence_dir,
      undefined,
      patterns,
    );
    const scenarios: Attempt["scenarios"] = [];
    for (const result of safe.scenarios) {
      const scenario = item.record.scenarios.find(
        (s) => s.scenario_id === result.scenario_id,
      );
      invariant(
        scenario,
        "unknown_scenario",
        "Result references an unknown frozen scenario",
      );
      invariant(
        result.observations.every((o) => o.step_index < scenario.steps.length),
        "unknown_step",
        "Observation references an unknown step",
      );
      if (result.outcome === "passed") {
        invariant(
          result.observations.length === scenario.steps.length,
          "missing_observations",
          "Passed declarations need observations for every frozen step",
        );
        const missing = scenario.evidence_requirements.filter(
          (requirement) =>
            requirement.required &&
            !result.evidence.some(
              (e) =>
                e.requirement_key === requirement.key &&
                e.kind === requirement.kind,
            ),
        );
        if (missing.length)
          throw new DomainError(
            "missing_evidence",
            "Passed declaration is missing required evidence references",
            false,
            {
              scenario_id: scenario.scenario_id,
              missing_keys: missing.map((r) => r.key),
            },
          );
      }
      const evidence: EvidenceView[] = [];
      for (const submitted of result.evidence) {
        invariant(
          submitted.step_indexes.every((i) => i < scenario.steps.length),
          "unknown_step",
          "Evidence references an unknown frozen step",
        );
        if (submitted.requirement_key)
          invariant(
            scenario.evidence_requirements.some(
              (r) =>
                r.key === submitted.requirement_key &&
                r.kind === submitted.kind,
            ),
            "unknown_evidence_requirement",
            "Evidence key/kind differs from the frozen requirement",
          );
        const view: EvidenceView = {
          id: id(),
          scenario_id: scenario.scenario_id,
          requirement_key: submitted.requirement_key,
          kind: submitted.kind,
          purpose: submitted.purpose,
          collected_at: submitted.collected_at,
          media_type: submitted.media_type,
          step_indexes: submitted.step_indexes,
          object_key: null,
          content_hash: null,
          availability: "unavailable",
        };
        if (submitted.source.storage === "inline") {
          const data = Buffer.from(redact(submitted.source.text, patterns)),
            object = await evidenceStore.putManaged(data);
          Object.assign(view, object, {
            availability: "available",
            size_bytes: data.length,
          });
        } else if (submitted.source.storage === "external") {
          view.external_reference = submitted.source.reference;
          view.availability = "external_unverified";
        } else {
          const source = input.scenarios.find(
            (s) => s.scenario_id === result.scenario_id,
          )!.evidence[result.evidence.indexOf(submitted)]!.source;
          invariant(
            source.storage === "inbox",
            "invalid_evidence_source",
            "Inbox source changed during redaction",
          );
          try {
            const stored = await evidenceStore.importFromInbox(
              source.path,
              submitted.kind,
            );
            Object.assign(view, stored, {
              collected_at: submitted.collected_at,
            });
          } catch (error) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ))
              throw error;
          }
        }
        evidence.push(view);
      }
      scenarios.push({ ...result, evidence });
    }
    const attempt: Attempt = {
      execution_id: input.execution_id,
      attempt_id: input.attempt_id,
      submission_hash,
      environment: safe.environment,
      scenarios,
    };
    const outcome = aggregate(
      item.record.scenarios.map(
        (s) =>
          scenarios.find((r) => r.scenario_id === s.scenario_id)?.outcome ??
          "not_run",
      ),
    );
    return this.store.write(meta, request, async (tx) => {
      const existing = await tx
        .selectFrom("acceptance_results")
        .selectAll()
        .where("plan_item_id", "=", row.id)
        .where("attempt_id", "=", input.attempt_id)
        .executeTakeFirst();
      if (existing) {
        invariant(
          decodeJson<Attempt>(existing.payload).submission_hash ===
            submission_hash,
          "attempt_conflict",
          "Attempt ID already contains another submission",
        );
        return { result_id: existing.id, outcome: existing.outcome as Outcome };
      }
      const context = await tx
        .selectFrom("acceptance_results as r")
        .innerJoin("plan_items as p", "p.id", "r.plan_item_id")
        .select(["r.payload", "p.plan_id"])
        .where("r.execution_id", "=", input.execution_id)
        .limit(1)
        .executeTakeFirst();
      if (context)
        invariant(
          context.plan_id === input.plan_id &&
            decodeJson<Attempt>(context.payload).environment.project_version ===
              safe.environment.project_version,
          "execution_context_mismatch",
          "Use a new execution ID for a different plan or project version",
        );
      const latest = await tx
        .selectFrom("acceptance_results")
        .select("created_at")
        .where("plan_item_id", "=", row.id)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      const created_at = new Date(
          Math.max(Date.now(), latest ? Date.parse(latest.created_at) + 1 : 0),
        ).toISOString(),
        result_id = id();
      await tx
        .insertInto("acceptance_results")
        .values({
          id: result_id,
          plan_item_id: row.id,
          attempt_id: input.attempt_id,
          execution_id: input.execution_id,
          outcome,
          environment_hash: hash(canonical(safe.environment)),
          payload: canonical(attempt),
          actor: meta.actor,
          created_at,
        })
        .execute();
      for (const result of scenarios)
        for (const evidence of result.evidence)
          await tx
            .insertInto("evidence")
            .values({
              id: evidence.id,
              result_id,
              kind: evidence.kind,
              object_key: evidence.object_key,
              content_hash: evidence.content_hash,
              payload: canonical(evidence),
              created_at,
            })
            .execute();
      return { result_id, outcome };
    });
  }
  async attempts(raw: unknown) {
    const input = pageSchema
        .extend({ plan_item_id: uuid, execution_id: uuid.optional() })
        .strict()
        .parse(raw),
      scope = hash(
        canonical({
          operation: "acceptance.attempts",
          plan_item_id: input.plan_item_id,
          execution_id: input.execution_id,
        }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("acceptance_results")
      .selectAll()
      .where("plan_item_id", "=", input.plan_item_id);
    if (input.execution_id)
      query = query.where("execution_id", "=", input.execution_id);
    if (cursor) query = query.where("id", ">", cursor.last);
    const rows = await query
      .orderBy("id")
      .limit(input.limit + 1)
      .execute();
    return {
      items: rows
        .slice(0, input.limit)
        .map((row) => ({ ...row, payload: decodeJson<Attempt>(row.payload) })),
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.id, now(), scope)
          : null,
    };
  }
}
