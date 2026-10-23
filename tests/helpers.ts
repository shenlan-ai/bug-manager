import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { Catalog, Projects, Taxonomy, id, openStore } from "@bug-manager/core";
import type { Store, Standard, Bug, Config } from "@bug-manager/core";

export const mutation = (reason = "Synthetic fixture operation") => ({
  idempotency_key: id(),
  actor: "test-fixture",
  reason,
});
export const supported = {
  assessment: "supported" as const,
  reason: "Observed in synthetic fixture",
  evidence: [
    {
      kind: "observation" as const,
      excerpt: "Repeated request produced two business effects",
    },
  ],
};
export function standard(
  type_ids: string[],
  overrides: Partial<Standard> = {},
): Standard {
  return {
    title: "重复提交只能产生一次效果",
    mechanism: "重复请求与并发回调缺乏幂等保护",
    type_ids,
    tags: [],
    confidence: supported,
    objective: "避免重复业务副作用",
    importance: "I0",
    importance_reason: "业务完整性的每次必验项",
    parameters: [],
    scenarios: [
      {
        scenario_id: "repeat",
        title: "重复同一请求",
        preconditions: ["存在可重复提交的业务操作"],
        steps: ["连续两次提交同一操作"],
        expected_results: ["只有一次业务效果"],
        evidence_requirements: [
          {
            key: "effects",
            kind: "log",
            description: "业务结果与请求记录",
            required: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}
export function bug(type_ids: string[], overrides: Partial<Bug> = {}): Bug {
  return {
    title: "重复请求创建重复订单",
    mechanism: "重复请求缺乏幂等保护",
    type_ids,
    tags: [],
    confidence: supported,
    symptoms: ["同一订单出现两次"],
    trigger_conditions: ["重试同一请求"],
    impact: "产生重复业务副作用",
    discovery: {
      origin: "human_reported",
      evidence: [
        {
          role: "user",
          kind: "human_report",
          excerpt: "Repeated request produced two business effects",
        },
      ],
    },
    severity: "S0",
    severity_reason: "可能造成资金与数据错误",
    mechanism_confirmed: true,
    ...overrides,
  };
}
export async function fixture(backend: "sqlite" | "postgres") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bug-manager-test-"));
  let store: Store | undefined,
    database: Config["database"],
    admin: pg.Pool | undefined,
    schema: string | undefined,
    envKey: string | undefined;
  try {
    if (backend === "postgres") {
      const source = process.env.BUG_MANAGER_TEST_DATABASE_URL;
      if (!source)
        throw new Error(
          "BUG_MANAGER_TEST_DATABASE_URL is required for real PostgreSQL tests",
        );
      admin = new pg.Pool({ connectionString: source });
      schema = `bm_test_${id().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(source);
      url.searchParams.set("options", `-c search_path=${schema}`);
      envKey = `BUG_MANAGER_TEST_${id().replaceAll("-", "")}`;
      process.env[envKey] = url.toString();
      database = { kind: "postgres", url_env: envKey };
      store = await openStore(database);
    } else {
      database = {
        kind: "sqlite",
        filename: path.join(directory, "test.sqlite"),
      };
      store = await openStore(database);
    }
    await store.initialize();
  } catch (error) {
    await store?.close();
    if (admin) {
      if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
    if (envKey) delete process.env[envKey];
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  if (!store) throw new Error("Fixture database did not open");
  const activeStore = store;
  let cleaned = false;
  const taxonomy = new Taxonomy(store),
    projects = new Projects(store),
    catalog = new Catalog(store);
  return {
    store,
    database,
    directory,
    taxonomy,
    projects,
    catalog,
    async type(name: string, parent_id?: string) {
      const proposal = await taxonomy.propose(
        { name, definition: `Synthetic definition for ${name}`, parent_id },
        mutation(),
      );
      return taxonomy.resolve(
        { type_id: proposal.id, expected_revision: 1, decision: "confirm" },
        mutation(),
      );
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await activeStore.close();
      if (admin) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
      if (envKey) delete process.env[envKey];
      await rm(directory, { recursive: true, force: true });
    },
  };
}
