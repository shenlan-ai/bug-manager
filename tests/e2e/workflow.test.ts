import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { runHistoryWorker } from "@bug-manager/worker";
import {
  Application,
  Analysis,
  AcceptancePlans,
  AcceptanceResults,
  AcceptanceReports,
  Changes,
  HistoryIngestion,
  ModelRuntime,
  configSchema,
  id,
  canonical,
} from "@bug-manager/core";
import { fixture, mutation, bug, standard } from "../helpers.js";

const exec = promisify(execFile);
for (const backend of ["sqlite", "postgres"] as const)
  it.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(
    `${backend}: two histories, three sync modes, both extraction paths, shared prevention, Git and executed evidence reach one human report`,
    async () => {
      const f = await fixture(backend),
        env = `BUG_MANAGER_SYNTHETIC_${id().replaceAll("-", "")}`;
      let server: ReturnType<typeof createServer> | undefined;
      try {
        const repo = path.join(f.directory, "repo"),
          codexRoot = path.join(f.directory, "codex"),
          claudeRoot = path.join(f.directory, "claude");
        await Promise.all([repo, codexRoot, claudeRoot].map((p) => mkdir(p)));
        const git = (args: string[]) =>
          exec("git", args, { cwd: repo, windowsHide: true });
        await git(["init"]);
        await writeFile(
          path.join(repo, "effect.mjs"),
          "process.stdout.write('baseline');\n",
        );
        await git(["add", "."]);
        await git([
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.invalid",
          "commit",
          "-m",
          "Synthetic baseline",
        ]);
        const projectA = await f.projects.register(
            { name: "Synthetic orders", directory: repo },
            mutation(),
          ),
          projectB = await f.projects.register(
            {
              name: "Synthetic entitlements",
              directory: path.join(f.directory, "other-project"),
            },
            mutation(),
          ),
          type_id = (await f.type("业务幂等")).id,
          config = configSchema.parse({
            database: f.database,
            evidence_dir: path.join(f.directory, "evidence"),
            history: [
              { adapter: "codex", path: codexRoot },
              { adapter: "claude", path: claudeRoot },
            ],
          }),
          history = new HistoryIngestion(f.store, config),
          analysis = new Analysis(f.store, config);
        await writeFile(
          path.join(codexRoot, "first.jsonl"),
          [
            {
              type: "session_meta",
              payload: { id: "synthetic-orders", cwd: repo },
            },
            {
              type: "event_msg",
              payload: {
                type: "user_message",
                message: "Repeated request produced two business effects",
              },
            },
          ]
            .map(canonical)
            .join("\n") + "\n",
        );
        const manual = await history.start({ trigger: "manual" }, mutation());
        await history.resume({ job_id: manual.job_id }, mutation());
        const claim = await analysis.claim({}, mutation());
        expect(claim).toBeTruthy();
        const lease = {
            task_id: claim!.task_id,
            owner_token: claim!.owner_token,
          },
          context = await analysis.context({ ...lease, type_ids: [type_id] }),
          submitted = await analysis.submit(
            {
              ...lease,
              outcome: "proposal",
              reason: "Observed order duplication",
              retrieval_id: (context.retrieval as { retrieval_id: string })
                .retrieval_id,
              proposal: {
                bugs: [{ ref: "order", record: bug([type_id]) }],
                standards: [{ ref: "once", record: standard([type_id]) }],
                links: [
                  {
                    bug_ref: "order",
                    standard_ref: "once",
                    coverage_reason:
                      "Repeat scenario detects duplicate effects",
                    scenario_ids: ["repeat"],
                  },
                ],
                contexts: [
                  {
                    bug_ref: "order",
                    project_id: projectA.id,
                    description: "Synthetic orders context",
                  },
                ],
              },
            },
            mutation(),
          );
        expect(submitted.status).toBe("committed");
        const canonicalStandard = (
          await f.catalog.search("standard", { type_ids: [type_id] })
        ).items[0]!;
        await writeFile(
          path.join(claudeRoot, "second.jsonl"),
          canonical({
            type: "user",
            uuid: "synthetic-message",
            sessionId: "synthetic-entitlements",
            cwd: path.join(f.directory, "other-project"),
            message: {
              role: "user",
              content: "Repeated request produced two business effects",
            },
          }) + "\n",
        );
        const app = new Application(f.store, config),
          stop = new AbortController();
        await runHistoryWorker(app, stop.signal, {
          interval_ms: 100,
          on_scan: () => stop.abort(),
        });
        expect((await history.freshness()).pending_segments).toBe(1);
        let modelRequests = 0;
        server = createServer((req, res) => {
          void (async () => {
            let body = "";
            for await (const chunk of req) body += String(chunk);
            const request = JSON.parse(body);
            modelRequests++;
            const name = request.response_format?.json_schema?.name;
            let answer: unknown;
            if (name === "classify_history")
              answer = {
                type_ids: [type_id],
                no_findings: false,
                reason: "Observed duplicate entitlement effects",
              };
            else if (name === "select_project_types")
              answer = {
                type_ids: [type_id],
                reason: "Project has retryable business operations",
              };
            else
              answer = {
                outcome: "proposal",
                reason:
                  "New affected business object reuses the existing standard",
                proposal: {
                  bugs: [
                    {
                      ref: "entitlement",
                      record: bug([type_id], {
                        title: "Repeated entitlement callback grants twice",
                        mechanism: "Entitlement callback deduplication omitted",
                      }),
                    },
                  ],
                  links: [
                    {
                      bug_ref: "entitlement",
                      standard_ref: canonicalStandard.id,
                      coverage_reason:
                        "Same repeated-operation scenario covers entitlement effects",
                      scenario_ids: ["repeat"],
                    },
                  ],
                  contexts: [
                    {
                      bug_ref: "entitlement",
                      project_id: projectB.id,
                      description: "Synthetic entitlements context",
                    },
                  ],
                },
              };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: { content: JSON.stringify(answer) },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 5 },
              }),
            );
          })().catch(() => res.destroy());
        });
        await new Promise<void>((resolve) =>
          server!.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Expected synthetic model endpoint");
        process.env[env] = "synthetic-key-only";
        const builtinConfig = configSchema.parse({
            ...config,
            model: {
              base_url: `http://127.0.0.1:${address.port}/v1`,
              model: "synthetic-contract",
              api_key_env: env,
              max_tokens: 1000000,
            },
          }),
          runtime = new ModelRuntime(f.store, builtinConfig),
          run = await runtime.start({ max_segments: 1 }, mutation());
        expect(
          await runtime.resume({ job_id: run.job_id }, mutation()),
        ).toMatchObject({
          processed: 1,
          last_submission: { status: "committed" },
        });
        await runtime.selectProjectTypes(
          {
            project_id: projectA.id,
            expected_revision: 0,
            description: "Retryable orders",
          },
          mutation(),
        );
        expect(modelRequests).toBe(3);
        expect(
          (await f.catalog.search("bug", { type_ids: [type_id] })).items,
        ).toHaveLength(2);
        expect(
          (await f.catalog.search("standard", { type_ids: [type_id] })).items,
        ).toHaveLength(1);
        expect(
          (
            await f.catalog.coverage({
              kind: "standard",
              id: canonicalStandard.id,
            })
          ).items,
        ).toHaveLength(2);
        expect(await history.freshness()).toMatchObject({
          pending_segments: 0,
          committed_segments: 2,
        });
        // The synthetic executor, not the product, runs this actual command.
        await writeFile(
          path.join(repo, "effect.mjs"),
          "let effects=0; const seen=new Set(); for(const key of ['request-1','request-1']) { if(!seen.has(key)){seen.add(key); effects++;}} process.stdout.write(JSON.stringify({effects}));\n",
        );
        const observed = await exec(
          process.execPath,
          [path.join(repo, "effect.mjs")],
          { cwd: repo, windowsHide: true },
        );
        expect(JSON.parse(observed.stdout).effects).toBe(1);
        const changes = new Changes(f.store, config),
          change = await changes.capture(
            {
              project_id: projectA.id,
              mode: "working-tree",
              directory: repo,
              description: "Add repeated request deduplication",
            },
            mutation(),
          ),
          plans = new AcceptancePlans(f.store, config),
          plan = await plans.create(
            { project_id: projectA.id, change_id: change.change_id },
            mutation(),
          ),
          item = (await plans.items({ plan_id: plan.plan_id })).items[0]!,
          execution_id = id();
        expect((await history.freshness()).pending_segments).toBe(0);
        expect(
          await f.store.db.selectFrom("source_segments").select("id").execute(),
        ).toHaveLength(2);
        expect(
          (await plans.get(plan.plan_id)).snapshot.history_freshness
            .synchronization,
        ).toBeTruthy();
        const triggers = (
          await f.store.db
            .selectFrom("jobs")
            .select("payload")
            .where("kind", "=", "history_sync")
            .execute()
        ).map((j) => JSON.parse(j.payload).trigger);
        expect(triggers).toEqual(
          expect.arrayContaining(["manual", "lazy", "background"]),
        );
        const result = await new AcceptanceResults(f.store, config).submit(
          {
            plan_id: plan.plan_id,
            plan_item_id: item.id,
            standard_id: item.standard_id,
            standard_revision: item.standard_revision,
            change_id: change.change_id,
            execution_id,
            attempt_id: id(),
            environment: {
              project_version: change.content_hash,
              change_content_hash: change.content_hash,
              platform: process.platform,
              tool_versions: { node: process.version },
            },
            scenarios: [
              {
                scenario_id: "repeat",
                outcome: "passed",
                observations: [
                  {
                    step_index: 0,
                    expected: "One effect",
                    actual: observed.stdout,
                  },
                ],
                evidence: [
                  {
                    requirement_key: "effects",
                    kind: "log",
                    purpose:
                      "Actual stdout of the synthetic executor's repeated operation",
                    collected_at: new Date().toISOString(),
                    media_type: "text/plain",
                    step_indexes: [0],
                    source: { storage: "inline", text: observed.stdout },
                  },
                ],
              },
            ],
          },
          mutation(),
        );
        expect(result.outcome).toBe("passed");
        const reports = new AcceptanceReports(f.store, config),
          report = await reports.create(
            { plan_id: plan.plan_id, execution_id },
            mutation(),
          ),
          exported = await reports.export({
            report_id: report.report_id,
            directory: path.join(f.directory, "report"),
          }),
          json = JSON.parse(await readFile(exported.json, "utf8"));
        expect(json.summary).toMatchObject({ planned: 1, passed: 1 });
        expect(json.review.automatic_semantic_review).toBe(false);
        expect(await readFile(exported.markdown, "utf8")).toContain("人工审核");
      } finally {
        delete process.env[env];
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        await f.cleanup();
      }
    },
    60000,
  );
