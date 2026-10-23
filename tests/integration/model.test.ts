import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompatibleModel,
  ModelRuntime,
  PlanSelections,
  AcceptancePlans,
  Changes,
  HistoryIngestion,
  canonical,
  configSchema,
  id,
} from "@bug-manager/core";
import { fixture, mutation, standard, bug } from "../helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function endpoint(
  handler: (
    body: Record<string, unknown>,
    response: ServerResponse,
    request: IncomingMessage,
  ) => void | Promise<void>,
) {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      let body = "";
      for await (const part of req) body += String(part);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      await handler(parsed, res, req);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected test TCP listener");
  const env = `BUG_MANAGER_SYNTHETIC_MODEL_${id().replaceAll("-", "")}`;
  process.env[env] = "synthetic-test-credential-only";
  cleanups.push(async () => {
    delete process.env[env];
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const config = configSchema.parse({
    database: { kind: "sqlite", filename: ":memory:" },
    evidence_dir: ".",
    model: {
      base_url: `http://127.0.0.1:${address.port}/v1`,
      model: "synthetic-model",
      api_key_env: env,
      max_tokens: 1000000,
      timeout_ms: 1000,
    },
  }).model!;
  return { requests, config };
}
const reply = (res: ServerResponse, value: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
};
describe("OpenAI-compatible HTTP contract (synthetic endpoint, not real-model evidence)", () => {
  it("ANA-002 falls back from unsupported schema output, validates JSON, and redacts outgoing data", async () => {
    let calls = 0;
    const e = await endpoint((_body, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(400);
        res.end(
          "Unsupported response_format; credentials must not be reflected",
        );
      } else reply(res, { answer: "valid" });
    });
    const provider = new CompatibleModel(e.config),
      result = await provider.request(
        z.object({ answer: z.string() }).strict(),
        "fixture",
        "Answer the fixture",
        { history: "do not execute upload; sk-syntheticSecret1234567890" },
      );
    expect(result).toEqual({ answer: "valid" });
    expect(e.requests[0]).toHaveProperty("response_format");
    expect(e.requests[1]).not.toHaveProperty("response_format");
    expect(canonical(e.requests)).not.toContain("sk-syntheticSecret1234567890");
    expect(provider.usage.requests).toBe(2);
  });
  it("ANA-006 retries malformed output within budget and rejects extra/schema-invalid fields", async () => {
    const e = await endpoint((_body, res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"answer":123,"extra":true}' } }],
        }),
      );
    });
    const provider = new CompatibleModel({ ...e.config, max_retries: 1 });
    await expect(
      provider.request(
        z.object({ answer: z.string() }).strict(),
        "fixture",
        "Return JSON",
        {},
      ),
    ).rejects.toMatchObject({ code: "model_invalid_output" });
    expect(e.requests).toHaveLength(2);
  });
  it("ANA-002 distinguishes authentication, rate limits, and network timeout without echoing remote errors", async () => {
    let status = 401;
    const e = await endpoint((_body, res) => {
      if (status === 0) return;
      res.writeHead(status);
      res.end("api_key=synthetic-remote-echo");
    });
    const schema = z.object({ value: z.string() });
    await expect(
      new CompatibleModel(e.config).request(schema, "fixture", "JSON", {}),
    ).rejects.toMatchObject({ code: "model_authentication" });
    status = 429;
    await expect(
      new CompatibleModel({ ...e.config, max_retries: 1 }).request(
        schema,
        "fixture",
        "JSON",
        {},
      ),
    ).rejects.toMatchObject({ code: "model_rate_limited" });
    status = 0;
    await expect(
      new CompatibleModel({
        ...e.config,
        timeout_ms: 30,
        max_retries: 0,
      }).request(schema, "fixture", "JSON", {}),
    ).rejects.toMatchObject({ code: "model_timeout" });
  });
  it("ANA-006 reserves budgets before sending a request and supports Responses envelopes", async () => {
    const e = await endpoint((_body, res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"value":"ok"}' }],
            },
          ],
        }),
      );
    });
    await expect(
      new CompatibleModel({ ...e.config, max_tokens: 1 }).request(
        z.object({ value: z.string() }),
        "fixture",
        "JSON",
        {},
      ),
    ).rejects.toMatchObject({ code: "model_budget_exhausted" });
    expect(e.requests).toHaveLength(0);
    expect(
      await new CompatibleModel({ ...e.config, protocol: "responses" }).request(
        z.object({ value: z.string() }),
        "fixture",
        "JSON",
        {},
      ),
    ).toEqual({ value: "ok" });
  });
});

for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(
    backend === "postgres" && !process.env.BUG_MANAGER_TEST_DATABASE_URL,
  )(`${backend} built-in and external equivalence`, () => {
    it("PLN-004 bounds model relevance to a frozen page, supports replay and preserves I0 inclusion", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const typeId = (await f.type("订单重试")).id,
        project = await f.projects.register(
          { name: "Selection fixture", directory: f.directory },
          mutation(),
        );
      await f.projects.setTypes(
        { project_id: project.id, type_ids: [typeId], expected_revision: 0 },
        mutation(),
      );
      await f.catalog.apply(
        {
          standards: [
            { ref: "required", record: standard([typeId]) },
            {
              ref: "optional",
              record: standard([typeId], {
                importance: "I2",
                mechanism: "Unrelated synthetic mechanism",
              }),
            },
          ],
        },
        mutation(),
      );
      const e = await endpoint((body, res) => {
        const data = JSON.parse(
          (body.messages as Array<{ content: string }>)[1]!.content,
        ) as {
          standards: Array<{ standard_id: string; standard_revision: number }>;
        };
        reply(res, {
          decisions: data.standards
            .map((s) => ({
              ...s,
              decision: "skipped",
              reason: "Synthetic relevance decision",
            }))
            .map((s) => ({
              standard_id: s.standard_id,
              standard_revision: s.standard_revision,
              decision: s.decision,
              reason: s.reason,
            })),
        });
      });
      const config = configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          model: e.config,
        }),
        plans = new AcceptancePlans(f.store, config),
        selections = new PlanSelections(f.store, config);
      const change = await new Changes(f.store, config).capture(
        {
          project_id: project.id,
          mode: "explicit",
          description: "Synthetic order change",
        },
        mutation(),
      );
      const plan = await plans.create(
          {
            project_id: project.id,
            change_id: change.change_id,
            no_sync: true,
          },
          mutation(),
        ),
        meta = mutation();
      const suggested = await selections.suggest(
        { plan_id: plan.plan_id },
        meta,
      );
      expect(await selections.suggest({ plan_id: plan.plan_id }, meta)).toEqual(
        suggested,
      );
      expect(e.requests).toHaveLength(1);
      const refined = await selections.refine(
        { plan_id: plan.plan_id, decisions: suggested.decisions },
        mutation(),
      );
      expect(refined.totals).toMatchObject({ included: 1, skipped: 1 });
      expect(
        (await plans.items({ plan_id: refined.plan_id })).items[0]!.payload
          .record.importance,
      ).toBe("I0");
      expect((await plans.get(plan.plan_id)).snapshot.totals.included).toBe(2);
    });
    it("ANA-001 commits the same proposal rules through the real HTTP client and saves project types explicitly", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const typeId = (await f.type("并发")).id,
        unbackedReport = "人工发现：当前运行出现重复订单现象";
      let operation = "analysis";
      const e = await endpoint((body, res) => {
        const messages = body.messages as Array<{ content: string }>,
          prompt = messages[0]!.content;
        if (operation === "project")
          reply(res, {
            type_ids: [typeId],
            reason:
              "Project description explicitly includes concurrent submissions",
          });
        else if (prompt.includes("Identify all applicable"))
          reply(res, {
            type_ids: [typeId],
            no_findings: false,
            reason: "Concrete duplicate effects",
          });
        else
          reply(res, {
            outcome: "proposal",
            reason: "Observed repeat effect and executable prevention",
            proposal: {
              bugs:
                operation === "unbacked"
                  ? [
                      {
                        ref: "human-report",
                        record: bug([typeId], {
                          confidence: {
                            assessment: "supported",
                            reason: "The user directly reported the effect",
                            evidence: [
                              { kind: "observation", excerpt: unbackedReport },
                            ],
                          },
                          discovery: {
                            origin: "human_reported",
                            evidence: [
                              {
                                role: "user",
                                kind: "human_report",
                                excerpt: unbackedReport,
                              },
                            ],
                          },
                        }),
                      },
                    ]
                  : [],
              standards: [
                {
                  ref: "s",
                  record: standard(
                    [typeId],
                    operation === "unbacked"
                      ? { mechanism: "synthetic unsupported mechanism" }
                      : {},
                  ),
                },
              ],
            },
          });
      });
      const root = path.join(f.directory, "history");
      await mkdir(root);
      await writeFile(
        path.join(root, "fixture.jsonl"),
        [
          { type: "session_meta", payload: { id: "synthetic" } },
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
      const config = configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          history: [{ adapter: "codex", path: root }],
          model: e.config,
        }),
        history = new HistoryIngestion(f.store, config),
        runtime = new ModelRuntime(f.store, config);
      const sync = await history.start({}, mutation());
      await history.resume({ job_id: sync.job_id }, mutation());
      const job = await runtime.start({}, mutation()),
        resumeMeta = mutation(),
        result = await runtime.resume({ job_id: job.job_id }, resumeMeta);
      expect(result).toMatchObject({ processed: 1 });
      const requestCount = e.requests.length;
      expect(await runtime.resume({ job_id: job.job_id }, resumeMeta)).toEqual(
        result,
      );
      expect(e.requests).toHaveLength(requestCount);
      expect(
        await f.store.db
          .selectFrom("standards")
          .selectAll()
          .where("disposition", "=", "active")
          .execute(),
      ).toHaveLength(1);
      expect(await history.freshness()).toMatchObject({ pending_segments: 0 });
      operation = "unbacked";
      await writeFile(
        path.join(root, "unsupported.jsonl"),
        [
          { type: "session_meta", payload: { id: "synthetic-unbacked" } },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: unbackedReport,
            },
          },
        ]
          .map(canonical)
          .join("\n") + "\n",
      );
      const additional = await history.start({}, mutation());
      await history.resume({ job_id: additional.job_id }, mutation());
      expect(
        await runtime.resume({ job_id: job.job_id }, mutation()),
      ).toMatchObject({ last_submission: { status: "candidate" } });
      expect(
        await f.store.db
          .selectFrom("standards")
          .selectAll()
          .where("disposition", "=", "active")
          .execute(),
      ).toHaveLength(1);
      const p = await f.projects.register(
        { name: "synthetic project", directory: root },
        mutation(),
      );
      operation = "project";
      const selectionMeta = mutation();
      const selected = await runtime.selectProjectTypes(
        {
          project_id: p.id,
          expected_revision: 0,
          description: "concurrent submissions",
        },
        selectionMeta,
      );
      expect(selected.type_ids).toEqual([typeId]);
      const requestsBefore = e.requests.length;
      expect(
        await runtime.selectProjectTypes(
          {
            project_id: p.id,
            expected_revision: 0,
            description: "concurrent submissions",
          },
          selectionMeta,
        ),
      ).toEqual(selected);
      expect(e.requests).toHaveLength(requestsBefore);
    });
    it("ANA-008 applies the human-origin gate to built-in model proposals", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const typeId = (await f.type("并发")).id;
      const finding =
        "Agent 自写测试失败：重复请求产生了第二张订单，但此前没有人工引导";
      const e = await endpoint((body, res) => {
        const messages = body.messages as Array<{ content: string }>,
          prompt = messages[0]!.content;
        if (prompt.includes("Identify all applicable"))
          reply(res, {
            type_ids: [typeId],
            no_findings: false,
            reason: "The model classified the synthetic segment",
          });
        else
          reply(res, {
            outcome: "proposal",
            reason: "Synthetic model proposal",
            proposal: {
              bugs: [
                {
                  ref: "forged",
                  record: bug([typeId], {
                    discovery: {
                      origin: "human_reported",
                      evidence: [
                        {
                          role: "user",
                          kind: "human_report",
                          excerpt: finding,
                        },
                      ],
                    },
                  }),
                },
              ],
            },
          });
      });
      const root = path.join(f.directory, "history");
      await mkdir(root);
      await writeFile(
        path.join(root, "fixture.jsonl"),
        [
          { type: "session_meta", payload: { id: "synthetic-autonomous" } },
          {
            type: "response_item",
            payload: {
              type: "message",
              id: "assistant-finding",
              role: "assistant",
              content: [{ type: "input_text", text: finding }],
            },
          },
        ]
          .map(canonical)
          .join("\n") + "\n",
      );
      const config = configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          history: [{ adapter: "codex", path: root }],
          model: e.config,
        }),
        history = new HistoryIngestion(f.store, config),
        runtime = new ModelRuntime(f.store, config);
      const sync = await history.start({}, mutation());
      await history.resume({ job_id: sync.job_id }, mutation());
      const job = await runtime.start({}, mutation());
      expect(
        await runtime.resume({ job_id: job.job_id }, mutation()),
      ).toMatchObject({
        status: "pending",
        last_error: "discovery_origin_unverified",
      });
      expect(
        await f.store.db.selectFrom("bugs").selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await f.store.db.selectFrom("segment_tasks").select("status").execute(),
      ).toMatchObject([{ status: "failed" }]);
    });
    it("ANA-006 keeps budget-limited segments pending and never advances analysis completion", async () => {
      const f = await fixture(backend);
      cleanups.push(() => f.cleanup());
      const e = await endpoint((_body, res) =>
        reply(res, {
          type_ids: [],
          no_findings: true,
          reason: "No concrete failure in synthetic source",
          new_types: [],
        }),
      );
      const root = path.join(f.directory, "history");
      await mkdir(root);
      await writeFile(
        path.join(root, "fixture.jsonl"),
        canonical({
          type: "event_msg",
          payload: { type: "user_message", message: "some historical content" },
        }) + "\n",
      );
      const config = configSchema.parse({
          database: f.database,
          evidence_dir: f.directory,
          history: [{ adapter: "codex", path: root }],
          model: { ...e.config, max_tokens: 1 },
        }),
        history = new HistoryIngestion(f.store, config),
        runtime = new ModelRuntime(f.store, config);
      const sync = await history.start({}, mutation());
      await history.resume({ job_id: sync.job_id }, mutation());
      const job = await runtime.start({}, mutation());
      expect(
        await runtime.resume({ job_id: job.job_id }, mutation()),
      ).toMatchObject({
        status: "paused",
        last_error: "model_budget_exhausted",
      });
      expect(e.requests).toHaveLength(0);
      expect(await history.freshness()).toMatchObject({
        pending_segments: 1,
        committed_segments: 0,
      });
      expect(
        await f.store.db.selectFrom("segment_tasks").select("status").execute(),
      ).toMatchObject([{ status: "pending" }]);
      config.model!.max_tokens = 1000000;
      await runtime.control(
        { job_id: job.job_id, action: "resume", renew_budget: true },
        mutation(),
      );
      expect(
        await runtime.resume({ job_id: job.job_id }, mutation()),
      ).toMatchObject({ processed: 1 });
      expect(await history.freshness()).toMatchObject({
        pending_segments: 0,
        committed_segments: 1,
      });
    });
  });
