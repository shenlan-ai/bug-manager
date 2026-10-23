import { z } from "zod";

export const uuid = z.uuid();
export const text = z.string().trim().min(1).max(20_000);
export const pageSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(4000).optional(),
});
export const typeProposalSchema = z
  .object({
    name: text.max(200),
    definition: text,
    parent_id: uuid.optional(),
    aliases: z.array(text.max(200)).max(100).default([]),
  })
  .strict();
export const typeSelectionSchema = z
  .object({
    project_id: uuid,
    type_ids: z.array(uuid).min(1).max(1000),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export const projectRegistrationSchema = z
  .object({
    name: text.max(200),
    directory: text,
    project_id: uuid.optional(),
    repository_hint: text.optional(),
  })
  .strict();
export const confidenceSchema = z
  .object({
    assessment: z.enum(["supported", "uncertain"]),
    reason: text,
    evidence: z
      .array(
        z
          .object({
            segment_id: uuid.optional(),
            excerpt: text.max(8000),
            kind: z.enum([
              "observation",
              "reproduction",
              "mechanism",
              "impact",
              "speculation",
            ]),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const bugDiscoveryEvidenceSchema = z
  .object({
    segment_id: uuid.optional(),
    role: z.enum(["user", "assistant", "tool"]),
    kind: z.enum(["human_report", "human_guidance", "agent_finding"]),
    excerpt: text.max(8000),
  })
  .strict();
export const bugDiscoverySchema = z
  .object({
    origin: z.enum(["human_reported", "human_guided_review"]),
    evidence: z.array(bugDiscoveryEvidenceSchema).min(1).max(100),
  })
  .strict()
  .superRefine((discovery, ctx) => {
    if (
      discovery.origin === "human_reported" &&
      !discovery.evidence.some(
        (evidence) =>
          evidence.kind === "human_report" && evidence.role === "user",
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Human-reported Bugs require user-authored human_report evidence",
      });
    if (discovery.origin === "human_guided_review") {
      if (
        !discovery.evidence.some(
          (evidence) =>
            evidence.kind === "human_guidance" && evidence.role === "user",
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Human-guided review requires user-authored human_guidance evidence",
        });
      if (
        !discovery.evidence.some(
          (evidence) =>
            evidence.kind === "agent_finding" &&
            ["assistant", "tool"].includes(evidence.role),
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Human-guided review requires assistant/tool agent_finding evidence",
        });
    }
  });
export const parameterSchema = z
  .object({
    name: text.max(200),
    description: text,
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().default(true),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();
export const scenarioSchema = z
  .object({
    scenario_id: text.max(200),
    title: text,
    preconditions: z.array(text).min(1),
    steps: z.array(text).min(1),
    expected_results: z.array(text).min(1),
    evidence_requirements: z
      .array(
        z
          .object({
            key: text.max(200),
            kind: z.enum([
              "log",
              "screenshot",
              "test_report",
              "observation",
              "other",
            ]),
            description: text,
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1),
    variant: z.string().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.evidence_requirements.map((e) => e.key)).size !==
      s.evidence_requirements.length
    )
      ctx.addIssue({ code: "custom", message: "Evidence keys must be unique" });
  });
const baseKnowledge = {
  title: text.max(500),
  mechanism: text,
  type_ids: z.array(uuid).min(1).max(1000),
  tags: z.array(text.max(200)).max(100).default([]),
  confidence: confidenceSchema,
};
export const bugSchema = z
  .object({
    ...baseKnowledge,
    symptoms: z.array(text).min(1),
    trigger_conditions: z.array(text).min(1),
    impact: text,
    discovery: bugDiscoverySchema,
    severity: z.enum(["S0", "S1", "S2", "S3"]),
    severity_reason: text,
    mechanism_confirmed: z.boolean().default(false),
  })
  .strict();
export const standardSchema = z
  .object({
    ...baseKnowledge,
    objective: text,
    importance: z.enum(["I0", "I1", "I2", "I3"]),
    importance_reason: text,
    parameters: z.array(parameterSchema).max(100).default([]),
    scenarios: z.array(scenarioSchema).min(1).max(100),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.scenarios.map((v) => v.scenario_id)).size !== s.scenarios.length
    )
      ctx.addIssue({ code: "custom", message: "Scenario IDs must be unique" });
    if (new Set(s.parameters.map((v) => v.name)).size !== s.parameters.length)
      ctx.addIssue({
        code: "custom",
        message: "Parameter names must be unique",
      });
  });
export const knowledgeSearchSchema = pageSchema
  .extend({
    type_ids: z.array(uuid).min(1).max(1000),
    type_match: z.enum(["any", "all"]).default("any"),
    query: z.string().max(2000).optional(),
    disposition: z
      .enum(["active", "candidate", "superseded", "rejected"])
      .default("active"),
  })
  .strict();
export type Bug = z.infer<typeof bugSchema>;
export type Standard = z.infer<typeof standardSchema>;
export type Knowledge = Bug | Standard;
export type EntityKind = "bug" | "standard";
export type KnowledgeSearch = z.input<typeof knowledgeSearchSchema>;
export function isSupported(
  confidence: z.infer<typeof confidenceSchema>,
): boolean {
  return (
    confidence.assessment === "supported" &&
    confidence.evidence.some((e) =>
      ["observation", "reproduction"].includes(e.kind),
    ) &&
    confidence.evidence.every((e) => e.kind !== "speculation")
  );
}
