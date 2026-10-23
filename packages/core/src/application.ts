import { z } from "zod";
import type { Config } from "./config.js";
import { loadConfig, dataHome } from "./config.js";
import { errorResponse, invariant } from "./errors.js";
import { id } from "./util.js";
import { mutationSchema, openStore } from "./storage/database.js";
import type { Mutation, Store } from "./storage/database.js";
import { Taxonomy } from "./domain/taxonomy.js";
import { Projects } from "./domain/projects.js";
import { Catalog, bundleSchema } from "./domain/catalog.js";
import { KnowledgeMerges, mergeSchema } from "./domain/merges.js";
import { Changes, changeCaptureSchema } from "./domain/changes.js";
import { AcceptanceResults, resultSubmitSchema } from "./domain/results.js";
import {
  AcceptanceReports,
  reportCreateSchema,
  reportPageSchema,
  reportExportSchema,
} from "./domain/reports.js";
import { PlanSelections, planRefineSchema } from "./domain/selection.js";
import {
  AcceptancePlans,
  planCreateSchema,
  planPageSchema,
} from "./domain/plans.js";
import { Jobs } from "./domain/jobs.js";
import {
  HistoryIngestion,
  syncStartSchema,
  syncResumeSchema,
  syncStatusSchema,
} from "./history/ingestion.js";
import {
  Analysis,
  analysisClaimSchema,
  analysisContextSchema,
  analysisSubmitSchema,
  analysisLeaseSchema,
} from "./history/analysis.js";
import {
  adapterCapabilities,
  defaultHistoryRoots,
} from "./history/adapters.js";
import { EvidenceStore } from "./storage/evidence.js";
import {
  ModelRuntime,
  analysisRunSchema,
  analysisRunResumeSchema,
} from "./model/runtime.js";
import {
  exportArchive,
  importArchive,
  backupSqlite,
} from "./storage/archive.js";
import {
  knowledgeSearchSchema,
  pageSchema,
  projectRegistrationSchema,
  typeProposalSchema,
  typeSelectionSchema,
  uuid,
} from "./domain/schemas.js";

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodObject;
  write: boolean;
  execute: (input: unknown, mutation?: Mutation) => Promise<unknown>;
}
export class Application {
  readonly taxonomy: Taxonomy;
  readonly projects: Projects;
  readonly catalog: Catalog;
  readonly jobs: Jobs;
  readonly history: HistoryIngestion;
  readonly analysis: Analysis;
  readonly models: ModelRuntime;
  readonly tools: Map<string, Tool>;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.taxonomy = new Taxonomy(store);
    this.projects = new Projects(store);
    this.catalog = new Catalog(store);
    this.jobs = new Jobs(store);
    this.history = new HistoryIngestion(store, config);
    this.analysis = new Analysis(store, config);
    this.models = new ModelRuntime(store, config);
    const tools: Tool[] = [];
    const add = (
      name: string,
      description: string,
      schema: z.ZodObject,
      execute: Tool["execute"],
      write = false,
    ) => tools.push({ name, description, schema, execute, write });
    add(
      "config_status",
      "Read non-secret database and analysis configuration",
      z.object({}).strict(),
      async () => ({
        ...(await store.health()),
        analysis_mode: config.model
          ? process.env[config.model.api_key_env]
            ? "builtin_available"
            : "builtin_key_required"
          : "external",
        model: {
          configured: Boolean(config.model),
          key_available: Boolean(
            config.model && process.env[config.model.api_key_env],
          ),
        },
        embeddings: config.embeddings
          ? {
              enabled: config.embeddings.enabled,
              model_id: config.embeddings.model_id,
              dimensions: config.embeddings.dimensions,
              normalization_version: config.embeddings.normalization_version,
              input: "externally_computed_vectors",
            }
          : { enabled: false },
        history_sources: config.history.length,
        adapters: adapterCapabilities,
        suggested_history_roots: defaultHistoryRoots(),
      }),
    );
    add(
      "sync_start",
      "Queue bounded history collection; analysis progress is independent",
      syncStartSchema,
      (v, m) => this.history.start(v, m!),
      true,
    );
    add(
      "sync_resume",
      "Process the next bounded collection batch and preserve checkpoints",
      syncResumeSchema,
      async (v, m) => {
        const input = syncResumeSchema.parse(v),
          result = await this.history.resume(v, m!),
          job = await this.jobs.get(input.job_id);
        const payload = job.payload as { analysis?: string };
        if (payload.analysis !== "builtin") return result;
        if (!config.model)
          return {
            ...result,
            builtin_analysis: {
              status: "configuration_required",
              reason:
                "Configure a compatible model or claim segments externally",
            },
          };
        const modelJob = await this.models.start(
          { max_segments: 1000 },
          {
            idempotency_key: `sync-model:${job.id}`,
            actor: "sync-scheduler",
            reason:
              "Queue the built-in analysis explicitly requested by this synchronization",
          },
        );
        if (
          modelJob.status === "completed" &&
          (await this.history.freshness()).pending_segments > 0
        ) {
          const previous = await this.jobs.get(modelJob.job_id);
          const progress = previous.result as { processed?: number } | null;
          if ((progress?.processed ?? 0) < 1000) {
            await this.models.control(
              { job_id: modelJob.job_id, action: "resume" },
              {
                idempotency_key: id(),
                actor: "sync-scheduler",
                reason:
                  "Resume the same synchronization analysis budget for newly collected segments",
              },
            );
            modelJob.status = "pending";
          }
        }
        return { ...result, builtin_analysis: modelJob };
      },
      true,
    );
    add(
      "sync_status",
      "Read collection coverage and independent analysis progress",
      syncStatusSchema,
      (v) => this.history.status(v),
    );
    add(
      "analysis_claim",
      "Lease one pending historical segment without requiring an API key",
      analysisClaimSchema,
      (v, m) => this.analysis.claim(v, m!),
      true,
    );
    add(
      "analysis_context",
      "Read bounded untrusted source data and optional type-filtered candidates",
      analysisContextSchema,
      (v) => this.analysis.context(v),
    );
    add(
      "analysis_submit",
      "Atomically submit extracted knowledge and complete a leased segment",
      analysisSubmitSchema,
      (v, m) => this.analysis.submit(v, m!),
      true,
    );
    add(
      "analysis_heartbeat",
      "Renew an analysis lease",
      analysisLeaseSchema.extend({
        lease_ms: z.number().int().min(10).max(3600000).default(60000),
      }),
      (v, m) => this.analysis.heartbeat(v, m!),
      true,
    );
    add(
      "analysis_release",
      "Release interrupted analysis for recovery",
      analysisLeaseSchema.extend({
        failed: z.boolean().default(false),
        code: z.string().min(1).max(100).default("executor_interrupted"),
      }),
      (v, m) => this.analysis.release(v, m!),
      true,
    );
    add(
      "worker_status",
      "Read foreground worker liveness without installing a system service",
      z.object({}).strict(),
      async () => {
        const workers = await store.db
          .selectFrom("jobs")
          .select(["id", "status", "lease_until", "updated_at"])
          .where("kind", "=", "history_worker")
          .orderBy("updated_at", "desc")
          .limit(20)
          .execute();
        return {
          workers: workers.map((w) => ({
            ...w,
            alive: w.status === "running" && w.lease_until > Date.now(),
          })),
          analysis: await this.history.freshness(),
        };
      },
    );
    add(
      "analysis_run",
      "Queue a budgeted built-in analysis run",
      analysisRunSchema,
      (v, m) => this.models.start(v, m!),
      true,
    );
    add(
      "analysis_run_resume",
      "Process at most one segment using the configured model",
      analysisRunResumeSchema,
      (v, m) => this.models.resume(v, m!),
      true,
    );
    add(
      "project_types_select",
      "Explicitly select and save project types with the configured model",
      z
        .object({
          project_id: uuid,
          expected_revision: z.number().int().nonnegative(),
          description: z.string().min(1).max(20000),
        })
        .strict(),
      (v, m) => this.models.selectProjectTypes(v, m!),
      true,
    );
    add(
      "types_list",
      "List controlled types with bounded pagination",
      pageSchema.extend({
        disposition: z
          .enum(["active", "candidate", "rejected"])
          .default("active"),
      }),
      (v) => this.taxonomy.list(v),
    );
    add(
      "type_propose",
      "Propose a controlled type and aliases",
      typeProposalSchema,
      (v, m) => this.taxonomy.propose(v, m!),
      true,
    );
    add(
      "type_resolve",
      "Confirm, reject or rename a controlled type",
      z.object({
        type_id: uuid,
        expected_revision: z.number().int().positive(),
        decision: z.enum(["confirm", "reject"]),
        name: z.string().optional(),
        aliases: z.array(z.string()).optional(),
      }),
      (v, m) => this.taxonomy.resolve(v, m!),
      true,
    );
    add(
      "project_register",
      "Register stable project identity and directory mapping",
      projectRegistrationSchema,
      (v, m) => this.projects.register(v, m!),
      true,
    );
    add(
      "project_resolve",
      "Resolve an explicit path; repository hints yield suggestions only",
      z.object({
        directory: z.string().min(1),
        repository_hint: z.string().optional(),
      }),
      async (v) => {
        const p = v as { directory: string; repository_hint?: string };
        return this.projects.resolve(p.directory, p.repository_hint);
      },
    );
    add(
      "project_types_get",
      "Read saved project type selection",
      z.object({ project_id: uuid }),
      (v) => this.projects.types((v as { project_id: string }).project_id),
    );
    add(
      "project_types_set",
      "Explicitly replace the project selected types",
      typeSelectionSchema,
      (v, m) => this.projects.setTypes(v, m!),
      true,
    );
    for (const kind of ["bug", "standard"] as const) {
      add(
        `${kind === "bug" ? "bugs" : "standards"}_search`,
        "Search type-filtered knowledge with bounded candidates",
        knowledgeSearchSchema,
        (v) => this.catalog.search(kind, v),
      );
      add(
        `${kind}_get`,
        "Read one entity and immutable revision",
        z.object({
          id: uuid,
          revision: z.number().int().positive().optional(),
        }),
        (v) => {
          const p = v as { id: string; revision?: number };
          return this.catalog.get(kind, p.id, p.revision);
        },
      );
    }
    add(
      "knowledge_apply",
      "Atomically maintain separate Bug and standard entities with coverage",
      bundleSchema,
      (v, m) => this.catalog.apply(v, m!),
      true,
    );
    add(
      "knowledge_merge",
      "Merge compatible active knowledge, or retain a conflict proposal",
      mergeSchema,
      (v, m) => new KnowledgeMerges(store).merge(v, m!),
      true,
    );
    add(
      "changes_capture",
      "Capture explicit or read-only Git changes without executing repository instructions",
      changeCaptureSchema,
      (v, m) => new Changes(store, config).capture(v, m!),
      true,
    );
    add(
      "changes_get",
      "Read an immutable change snapshot",
      z.object({ change_id: uuid }).strict(),
      (v) =>
        new Changes(store, config).get((v as { change_id: string }).change_id),
    );
    add(
      "acceptance_plan_create",
      "Freeze an in-scope acceptance plan with I0 coverage and explicit selection reasons",
      planCreateSchema,
      (v, m) => new AcceptancePlans(store, config).create(v, m!),
      true,
    );
    add(
      "acceptance_plan_refine",
      "Create a new frozen plan from bounded explicit relevance decisions",
      planRefineSchema,
      (v, m) => new PlanSelections(store, config).refine(v, m!),
      true,
    );
    add(
      "acceptance_selection_suggest",
      "Suggest bounded relevance decisions using the configured model; never modifies the basis plan",
      planPageSchema,
      (v, m) => new PlanSelections(store, config).suggest(v, m!),
      true,
    );
    add(
      "acceptance_plan_get",
      "Read immutable plan scope, changes and freshness",
      z.object({ plan_id: uuid }).strict(),
      (v) =>
        new AcceptancePlans(store, config).get(
          (v as { plan_id: string }).plan_id,
        ),
    );
    add(
      "acceptance_items_list",
      "Page immutable standard definitions and parameter gaps",
      planPageSchema,
      (v) => new AcceptancePlans(store, config).items(v),
    );
    add(
      "acceptance_decisions_list",
      "Page the entire in-scope selected, skipped and unresolved audit",
      planPageSchema,
      (v) => new AcceptancePlans(store, config).decisions(v),
    );
    add(
      "acceptance_result_submit",
      "Accept a structured executor declaration and evidence references without semantic review",
      resultSubmitSchema,
      (v, m) => new AcceptanceResults(store, config).submit(v, m!),
      true,
    );
    add(
      "acceptance_attempts_list",
      "Read append-only execution attempts",
      pageSchema
        .extend({ plan_item_id: uuid, execution_id: uuid.optional() })
        .strict(),
      (v) => new AcceptanceResults(store, config).attempts(v),
    );
    add(
      "acceptance_report_create",
      "Freeze a result selection for human review",
      reportCreateSchema,
      (v, m) => new AcceptanceReports(store, config).create(v, m!),
      true,
    );
    add(
      "acceptance_report_get",
      "Read a frozen report header and deterministic counts",
      z.object({ report_id: uuid }).strict(),
      (v) =>
        new AcceptanceReports(store, config).get(
          (v as { report_id: string }).report_id,
        ),
    );
    add(
      "acceptance_report_items",
      "Read bounded items from a frozen result selection",
      reportPageSchema,
      (v) => new AcceptanceReports(store, config).items(v),
    );
    add(
      "acceptance_report_export",
      "Export the same snapshot to Markdown, JSON and a managed evidence manifest",
      reportExportSchema,
      (v) => new AcceptanceReports(store, config).export(v),
    );
    add(
      "knowledge_coverage",
      "Read coverage and its immutable revisions for a known entity",
      pageSchema
        .extend({
          kind: z.enum(["bug", "standard"]),
          id: uuid,
          history: z.boolean().default(false),
        })
        .strict(),
      (v) => this.catalog.coverage(v),
    );
    add(
      "knowledge_provenance",
      "Read bounded source links for a known entity",
      pageSchema
        .extend({ kind: z.enum(["bug", "standard"]), id: uuid })
        .strict(),
      (v) => this.catalog.provenance(v),
    );
    add(
      "knowledge_candidates",
      "List uncertain proposals; this is not a repair task list",
      pageSchema.extend({
        kind: z.string().optional(),
        disposition: z
          .enum(["pending", "confirmed", "rejected"])
          .default("pending"),
      }),
      (v) => this.catalog.candidates(v),
    );
    add(
      "knowledge_resolve",
      "Confirm with evidence or reject an uncertain proposal",
      z.object({
        candidate_id: uuid,
        expected_revision: z.number().int().positive(),
        decision: z.enum(["confirm", "reject"]),
        confidence: z.unknown().optional(),
      }),
      (v, m) => this.catalog.resolveCandidate(v, m!),
      true,
    );
    add(
      "knowledge_history",
      "Read revision history for one entity",
      pageSchema.extend({ kind: z.enum(["bug", "standard"]), id: uuid }),
      (v) => {
        const p = v as { kind: "bug" | "standard"; id: string };
        return this.catalog.history(p.kind, p.id, v);
      },
    );
    const archive = z.object({ directory: z.string().min(1) }).strict();
    add(
      "storage_export",
      "Export a consistent portable archive with evidence manifest",
      archive,
      (v) =>
        exportArchive(
          store,
          new EvidenceStore(config.evidence_dir),
          (v as { directory: string }).directory,
        ),
    );
    // Import is an explicit empty-database maintenance operation, not a knowledge
    // mutation. Its archive checksum and transaction provide replay protection.
    add(
      "storage_import",
      "Restore a validated archive into an empty initialized database",
      archive,
      (v) =>
        importArchive(
          store,
          new EvidenceStore(config.evidence_dir),
          (v as { directory: string }).directory,
        ),
    );
    add(
      "storage_backup",
      "Create a non-overwriting SQLite native snapshot",
      z.object({ filename: z.string().min(1) }),
      (v) => backupSqlite(store, (v as { filename: string }).filename),
    );
    add(
      "sync_issues",
      "Page source coverage gaps without exposing raw records",
      pageSchema.extend({ source_id: uuid }).strict(),
      (v) => this.history.issues(v),
    );
    add(
      "sync_discovery_issues",
      "Page durable root discovery gaps without private paths",
      pageSchema.extend({ root_id: uuid }).strict(),
      (v) => this.history.discoveryIssues(v),
    );
    add(
      "analysis_run_control",
      "Pause or resume a bounded model run; renewing budgets is explicit",
      z
        .object({
          job_id: uuid,
          action: z.enum(["pause", "resume"]),
          renew_budget: z.boolean().default(false),
        })
        .strict(),
      (v, m) => this.models.control(v, m!),
      true,
    );
    add(
      "analysis_reanalyze",
      "Queue an explicit versioned reanalysis without replacing prior results",
      z
        .object({
          analysis_version: z.string().min(1).max(100),
          segment_id: uuid.optional(),
          cursor: z.string().max(4000).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .strict(),
      (v, m) => this.analysis.reanalyze(v, m!),
      true,
    );
    add(
      "knowledge_candidate_get",
      "Read one explicitly identified governance candidate",
      z.object({ candidate_id: uuid }).strict(),
      (v) =>
        this.catalog.candidateGet((v as { candidate_id: string }).candidate_id),
    );
    add(
      "knowledge_vector_put",
      "Index an explicitly computed optional embedding for a current knowledge revision",
      vectorPutSchema,
      (v, m) => new KnowledgeVectors(store, config).put(v, m!),
      true,
    );
    add(
      "knowledge_vectors_search",
      "Retrieve bounded cosine candidates after explicit type filtering within the configured embedding space",
      vectorSearchSchema,
      (v) => new KnowledgeVectors(store, config).search(v),
    );
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }
  async invoke(name: string, input: unknown, mutation?: Mutation) {
    const request_id = id();
    try {
      const tool = this.tools.get(name);
      invariant(tool, "unknown_tool", "Unknown operation");
      if (
        name === "bugs_search" ||
        name === "standards_search" ||
        name === "knowledge_vectors_search"
      )
        invariant(
          input &&
            typeof input === "object" &&
            "type_ids" in input &&
            Array.isArray(input.type_ids) &&
            input.type_ids.length > 0,
          "type_scope_required",
          "Knowledge searches require controlled type IDs",
        );
      const parsed = tool.schema.parse(input);
      if (tool.write) mutationSchema.parse(mutation);
      return {
        schema_version: "1",
        request_id,
        data: await tool.execute(parsed, mutation),
        warnings: [],
      };
    } catch (error) {
      return { schema_version: "1", request_id, error: errorResponse(error) };
    }
  }
  async close() {
    await this.store.close();
  }
}
export async function openApplication(home = dataHome()) {
  const config = await loadConfig(home),
    store = await openStore(config.database);
  try {
    await store.health();
    return new Application(store, config);
  } catch (error) {
    await store.close();
    throw error;
  }
}
import {
  KnowledgeVectors,
  vectorPutSchema,
  vectorSearchSchema,
} from "./domain/vectors.js";
