#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { installSkill } from "./skill-install.js";
import { z } from "zod";
import {
  dataHome,
  initializeConfig,
  openApplication,
  openStore,
  id,
  errorResponse,
  DomainError,
  configSchema,
} from "@bug-manager/core";
import { serve } from "@bug-manager/mcp";
import { runHistoryWorker } from "@bug-manager/worker";

const program = new Command()
  .name("bug-manager")
  .description("Bug prevention knowledge and agent acceptance reports")
  .version("0.1.0")
  .option("--home <directory>", "Application data directory")
  .option("--json", "Machine-readable output");
function emit(value: unknown) {
  process.stdout.write(
    JSON.stringify(value, null, program.opts().json ? 0 : 2) + "\n",
  );
}
const home = () => program.opts<{ home?: string }>().home ?? dataHome();
program
  .command("config")
  .command("template")
  .description("Print a validated configuration template without writing files")
  .option("--database <backend>", "sqlite or postgres", "sqlite")
  .option("--model", "Include an OpenAI-compatible provider template")
  .action((options: { database: string; model?: boolean }) => {
    if (!["sqlite", "postgres"].includes(options.database))
      throw new DomainError(
        "validation_error",
        "Database must be sqlite or postgres",
      );
    const config = configSchema.parse({
      database:
        options.database === "postgres"
          ? { kind: "postgres", url_env: "BUG_MANAGER_DATABASE_URL" }
          : { kind: "sqlite", filename: `${home()}/library.sqlite` },
      evidence_dir: `${home()}/evidence`,
      history: [],
      ...(options.model
        ? {
            model: {
              base_url: "https://api.example.invalid/v1",
              model: "configure-model-name",
              api_key_env: "BUG_MANAGER_MODEL_KEY",
            },
          }
        : {}),
    });
    emit({ schema_version: "1", request_id: id(), data: config, warnings: [] });
  });
program
  .command("skill")
  .command("install")
  .description(
    "Install the packaged Skill into an explicit client and user/project root",
  )
  .requiredOption("--client <client>", "codex or claude")
  .requiredOption("--scope <scope>", "user or project")
  .requiredOption(
    "--root <directory>",
    "Explicit user home or project root; no default writes",
  )
  .action(async (options) => {
    let source = fileURLToPath(
      new URL("../skills/bug-manager", import.meta.url),
    );
    try {
      await readFile(
        new URL("../skills/bug-manager/SKILL.md", import.meta.url),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      source = fileURLToPath(
        new URL("../../../skills/bug-manager", import.meta.url),
      );
    }
    emit({
      schema_version: "1",
      request_id: id(),
      data: await installSkill(options, source),
      warnings: [],
    });
  });
program
  .command("init")
  .description("Initialize config and migrate the default database")
  .action(async () => {
    const config = await initializeConfig(home()),
      store = await openStore(config.database);
    try {
      const migrations = await store.initialize();
      emit({
        schema_version: "1",
        data: { home: home(), migrations, ...(await store.health()) },
      });
    } finally {
      await store.close();
    }
  });
program
  .command("doctor")
  .description("Check configuration and database without displaying secrets")
  .action(async () => {
    const app = await openApplication(home());
    try {
      const result = await app.invoke("config_status", {});
      emit(result);
      if ("error" in result) process.exitCode = 1;
    } finally {
      await app.close();
    }
  });
program
  .command("tools")
  .description("List implemented tool contracts")
  .option("--name <tool>", "Read the JSON input schema for one tool")
  .action(async (options: { name?: string }) => {
    const app = await openApplication(home());
    try {
      const selected = options.name ? app.tools.get(options.name) : undefined;
      if (options.name && !selected)
        throw new DomainError("unknown_tool", "Unknown operation");
      emit({
        schema_version: "1",
        request_id: id(),
        data: selected
          ? {
              name: selected.name,
              write: selected.write,
              input_schema: z.toJSONSchema(selected.schema, { io: "input" }),
            }
          : [...app.tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              write: t.write,
            })),
        warnings: [],
      });
    } finally {
      await app.close();
    }
  });
const paths: Record<string, string[]> = {
  knowledge_vector_put: ["knowledge", "vector-put"],
  knowledge_vectors_search: ["knowledge", "vectors-search"],
  knowledge_candidate_get: ["knowledge", "candidate-get"],
  analysis_run_control: ["analysis", "run-control"],
  analysis_reanalyze: ["analysis", "reanalyze"],
  sync_issues: ["sync", "issues"],
  sync_discovery_issues: ["sync", "discovery-issues"],
  knowledge_merge: ["knowledge", "merge"],
  changes_capture: ["changes", "capture"],
  changes_get: ["changes", "get"],
  acceptance_plan_create: ["acceptance", "plan"],
  acceptance_result_submit: ["acceptance", "result", "submit"],
  acceptance_attempts_list: ["acceptance", "attempts"],
  acceptance_report_create: ["acceptance", "report", "create"],
  acceptance_report_get: ["acceptance", "report", "get"],
  acceptance_report_items: ["acceptance", "report", "items"],
  acceptance_report_export: ["acceptance", "report", "export"],
  acceptance_plan_refine: ["acceptance", "refine"],
  acceptance_selection_suggest: ["acceptance", "suggest"],
  acceptance_plan_get: ["acceptance", "get"],
  acceptance_items_list: ["acceptance", "items"],
  acceptance_decisions_list: ["acceptance", "decisions"],
  knowledge_coverage: ["knowledge", "coverage"],
  knowledge_provenance: ["knowledge", "provenance"],
  analysis_run: ["analysis", "run"],
  analysis_run_resume: ["analysis", "run-resume"],
  project_types_select: ["project", "types", "select"],
  sync_start: ["sync", "run"],
  sync_resume: ["sync", "resume"],
  sync_status: ["sync", "status"],
  analysis_claim: ["analysis", "claim"],
  analysis_context: ["analysis", "context"],
  analysis_submit: ["analysis", "submit"],
  analysis_heartbeat: ["analysis", "heartbeat"],
  analysis_release: ["analysis", "release"],
  worker_status: ["worker", "status"],
  project_register: ["project", "register"],
  project_resolve: ["project", "resolve"],
  project_types_get: ["project", "types", "show"],
  project_types_set: ["project", "types", "set"],
  types_list: ["types", "list"],
  type_propose: ["types", "propose"],
  type_resolve: ["types", "resolve"],
  bugs_search: ["bugs", "search"],
  bug_get: ["bugs", "get"],
  standards_search: ["standards", "search"],
  standard_get: ["standards", "get"],
  knowledge_apply: ["knowledge", "apply"],
  knowledge_candidates: ["knowledge", "candidates"],
  knowledge_resolve: ["knowledge", "resolve"],
  knowledge_history: ["knowledge", "history"],
  storage_export: ["storage", "export"],
  storage_import: ["storage", "import"],
  storage_backup: ["storage", "backup"],
};
async function call(
  name: string,
  options: {
    input?: string;
    file?: string;
    actor: string;
    reason?: string;
    key?: string;
  },
) {
  const app = await openApplication(home());
  try {
    const source = options.file
      ? await readFile(options.file, "utf8")
      : (options.input ?? "{}");
    let input: unknown;
    try {
      input = JSON.parse(source) as unknown;
    } catch {
      throw new DomainError("invalid_json", "Input is not valid JSON");
    }
    const meta = options.reason
      ? {
          idempotency_key: options.key ?? id(),
          actor: options.actor,
          reason: options.reason,
        }
      : undefined;
    const result = await app.invoke(name, input, meta);
    emit(result);
    if ("error" in result) process.exitCode = 1;
  } finally {
    await app.close();
  }
}
for (const [tool, segments] of Object.entries(paths)) {
  let parent = program;
  for (const segment of segments.slice(0, -1)) {
    let child = parent.commands.find((c) => c.name() === segment);
    if (!child) child = parent.command(segment);
    parent = child;
  }
  parent
    .command(segments.at(-1)!)
    .option("--input <json>", "JSON input")
    .option("--file <path>", "Read JSON input from a file")
    .option("--actor <name>", "Mutation actor", "cli")
    .option("--reason <text>", "Required reason for writes")
    .option("--key <key>", "Idempotency key for safe retries")
    .action((options) => call(tool, options));
}
program
  .command("call <tool>")
  .option("--input <json>")
  .option("--file <path>")
  .option("--actor <name>", "Mutation actor", "cli")
  .option("--reason <text>")
  .option("--key <key>")
  .action((tool, options) => call(tool, options));
const worker = program.commands.find((c) => c.name() === "worker")!;
worker
  .command("run")
  .option("--interval-ms <milliseconds>", "Periodic scan interval", "30000")
  .action(async (options) => {
    const intervalMs = Number(options.intervalMs);
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 3600000
    )
      throw new Error("Invalid worker interval");
    const app = await openApplication(home()),
      controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runHistoryWorker(app, controller.signal, {
        interval_ms: intervalMs,
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await app.close();
    }
  });
program
  .command("mcp")
  .command("serve")
  .action(async () => {
    await serve(home());
  });
try {
  await program.parseAsync();
} catch (error) {
  emit({ schema_version: "1", error: errorResponse(error) });
  process.exitCode = 1;
}
