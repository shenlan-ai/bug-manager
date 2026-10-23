import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Store, Mutation } from "../storage/database.js";
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
import { EvidenceStore } from "../storage/evidence.js";
import { pageSchema, uuid, text } from "./schemas.js";
import { AcceptancePlans } from "./plans.js";
import type { PlanItem, PlanSnapshot } from "./plans.js";
import { aggregate } from "./results.js";
import type { Attempt, Outcome } from "./results.js";

export const reportCreateSchema = z
  .object({
    plan_id: uuid,
    execution_id: uuid,
    result_ids: z.array(uuid).max(5000).optional(),
  })
  .strict();
export const reportPageSchema = pageSchema.extend({ report_id: uuid }).strict();
export const reportExportSchema = z
  .object({ report_id: uuid, directory: text })
  .strict();
const counts = () => ({
  passed: 0,
  failed: 0,
  blocked: 0,
  not_run: 0,
  not_applicable: 0,
});
interface ReportHeader {
  schema_version: 1;
  report_id: string;
  plan_id: string;
  project_id: string;
  execution_id: string;
  created_at: string;
  plan_snapshot: PlanSnapshot;
  summary: ReturnType<typeof counts> & { planned: number };
  scenario_summary: ReturnType<typeof counts> & { planned: number };
  result_selection: string;
  review: { mode: "human"; automatic_semantic_review: false };
  actor: string;
  reason: string;
}
interface ReportItem {
  item_id: string;
  definition: PlanItem;
  outcome: Outcome;
  result_id: string | null;
  actor: string | null;
  submitted_at: string | null;
  attempt: Attempt | null;
}
const md = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~>-]/g, "\\$&");
function renderItem(item: ReportItem) {
  const definition = item.definition,
    record = definition.record;
  let output = `\n## ${md(record.importance)} · ${md(record.title)} · ${md(item.outcome)}\n\n`;
  output += `标准：${md(definition.standard_id)}，修订 ${definition.standard_revision}；类型：${record.type_ids.map(md).join("、")}\n\n选择依据：${md(definition.selection.reason)}\n\n机制：${md(record.mechanism)}\n\n目标：${md(record.objective)}\n\n参数：${md(canonical(definition.resolved_parameters))}\n\n待补参数：${definition.unresolved_parameters.map(md).join("、") || "无"}\n\n`;
  output += item.attempt
    ? `执行者：${md(item.actor)}；尝试：${md(item.attempt.attempt_id)}；结果记录：${md(item.result_id)}\n\n环境声明：${md(canonical(item.attempt.environment))}\n\n`
    : "未提交执行结果。\n\n";
  for (const scenario of record.scenarios) {
    const result = item.attempt?.scenarios.find(
      (s) => s.scenario_id === scenario.scenario_id,
    );
    output += `### ${md(scenario.title)} · ${md(result?.outcome ?? "not_run")}\n\n场景：${md(scenario.scenario_id)}；变体：${md(scenario.variant ?? "默认")}\n\n前置条件：${scenario.preconditions.map(md).join("；")}\n\n`;
    scenario.steps.forEach((step, index) => {
      const observation = result?.observations.find(
        (o) => o.step_index === index,
      );
      output += `${index + 1}. ${md(step)}\n\n   提交的预期：${md(observation?.expected ?? "未提交")}\n\n   实际观察：${md(observation?.actual ?? "未提交")}\n\n`;
    });
    output += `冻结通过条件：${scenario.expected_results.map(md).join("；")}\n\n执行者说明：${md(result?.reason ?? "无")}\n\n`;
    for (const evidence of result?.evidence ?? [])
      output += `- 证据 ${md(evidence.requirement_key ?? evidence.id)}（${md(evidence.kind)}）：${md(evidence.purpose)}；采集 ${md(evidence.collected_at)}；提交时可用性 ${md(evidence.availability)}；导出时可用性 ${md(evidence.availability_at_export ?? "未检查")}；${md(evidence.object_key ? `evidence/${evidence.object_key}` : (evidence.external_reference ?? "无附件"))}；hash ${md(evidence.content_hash ?? "未提供")}\n`;
    output += "\n";
  }
  return output;
}
export class AcceptanceReports {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  async create(raw: unknown, meta: Mutation) {
    const input = reportCreateSchema.parse(raw);
    invariant(
      !input.result_ids ||
        new Set(input.result_ids).size === input.result_ids.length,
      "duplicate_result",
      "Explicit result IDs must be unique",
    );
    return this.store.write(
      meta,
      { operation: "acceptance.report.create", input },
      async (tx) => {
        const plan = await tx
          .selectFrom("acceptance_plans")
          .selectAll()
          .where("id", "=", input.plan_id)
          .executeTakeFirst();
        invariant(plan, "not_found", "Plan not found");
        const snapshot = decodeJson<PlanSnapshot>(plan.snapshot),
          report_id = id();
        const header: ReportHeader = {
          schema_version: 1,
          report_id,
          plan_id: plan.id,
          project_id: plan.project_id,
          execution_id: input.execution_id,
          created_at: now(),
          plan_snapshot: snapshot,
          summary: { planned: 0, ...counts() },
          scenario_summary: { planned: 0, ...counts() },
          result_selection: input.result_ids
            ? "explicit_result_ids"
            : "latest_valid_submission_in_execution",
          review: { mode: "human", automatic_semantic_review: false },
          actor: meta.actor,
          reason: meta.reason,
        };
        await tx
          .insertInto("report_exports")
          .values({
            id: report_id,
            plan_id: plan.id,
            payload: "{}",
            content_hash: "pending",
            created_at: header.created_at,
          })
          .execute();
        const requested = input.result_ids
            ? new Set(input.result_ids)
            : undefined,
          digest = createHash("sha256");
        let after = "";
        while (true) {
          const items = await tx
            .selectFrom("plan_items")
            .selectAll()
            .where("plan_id", "=", plan.id)
            .where("id", ">", after)
            .orderBy("id")
            .limit(200)
            .execute();
          for (const item of items) {
            let query = tx
              .selectFrom("acceptance_results")
              .selectAll()
              .where("plan_item_id", "=", item.id)
              .where("execution_id", "=", input.execution_id);
            if (input.result_ids) {
              if (input.result_ids.length)
                query = query.where("id", "in", input.result_ids);
              else query = query.where("id", "=", "");
            }
            const results = await query
              .orderBy("created_at", "desc")
              .orderBy("id", "desc")
              .limit(input.result_ids ? 2 : 1)
              .execute();
            invariant(
              !input.result_ids || results.length <= 1,
              "ambiguous_result_selection",
              "Select at most one attempt per plan item",
            );
            const result = results[0],
              definition = decodeJson<PlanItem>(item.payload),
              attempt = result
                ? decodeJson<Attempt>(result.payload)
                : undefined;
            const outcomes = definition.record.scenarios.map(
              (s) =>
                attempt?.scenarios.find((r) => r.scenario_id === s.scenario_id)
                  ?.outcome ?? "not_run",
            );
            header.summary.planned++;
            header.summary[aggregate(outcomes)]++;
            for (const outcome of outcomes) {
              header.scenario_summary.planned++;
              header.scenario_summary[outcome]++;
            }
            await tx
              .insertInto("report_result_links")
              .values({
                report_id,
                plan_item_id: item.id,
                result_id: result?.id ?? null,
              })
              .execute();
            if (result) requested?.delete(result.id);
            digest.update(
              canonical({ item_id: item.id, result_id: result?.id ?? null }),
            );
          }
          if (items.length < 200) break;
          after = items.at(-1)!.id;
        }
        invariant(
          !requested?.size,
          "result_selection_mismatch",
          "A selected result belongs to another plan, execution, or excluded item",
        );
        const content_hash = hash(canonical(header) + digest.digest("hex"));
        await tx
          .updateTable("report_exports")
          .set({ payload: canonical(header), content_hash })
          .where("id", "=", report_id)
          .execute();
        return {
          report_id,
          plan_id: plan.id,
          summary: header.summary,
          scenario_summary: header.scenario_summary,
          content_hash,
        };
      },
    );
  }
  async get(report_id: string) {
    uuid.parse(report_id);
    const row = await this.store.db
      .selectFrom("report_exports")
      .selectAll()
      .where("id", "=", report_id)
      .executeTakeFirst();
    invariant(row, "not_found", "Report snapshot not found");
    const header = decodeJson<ReportHeader>(row.payload);
    invariant(
      header.schema_version === 1 && header.report_id === row.id,
      "report_format_unavailable",
      "This record does not contain a supported frozen report",
    );
    return { ...header, content_hash: row.content_hash };
  }
  async items(raw: unknown) {
    const input = reportPageSchema.parse(raw);
    await this.get(input.report_id);
    const scope = hash(
        canonical({ operation: "report.items", report_id: input.report_id }),
      ),
      cursor = parseCursor(input.cursor, scope);
    let query = this.store.db
      .selectFrom("report_result_links as l")
      .innerJoin("plan_items as i", "i.id", "l.plan_item_id")
      .leftJoin("acceptance_results as r", "r.id", "l.result_id")
      .select([
        "i.id as item_id",
        "i.payload as item_payload",
        "r.id as result_id",
        "r.payload as result_payload",
        "r.actor",
        "r.created_at",
      ])
      .where("l.report_id", "=", input.report_id);
    if (cursor) query = query.where("i.id", ">", cursor.last);
    const rows = await query
      .orderBy("i.id")
      .limit(input.limit + 1)
      .execute();
    const items: ReportItem[] = rows.slice(0, input.limit).map((row) => {
      const definition = decodeJson<PlanItem>(row.item_payload),
        attempt = row.result_payload
          ? decodeJson<Attempt>(row.result_payload)
          : null;
      return {
        item_id: row.item_id,
        definition,
        outcome: aggregate(
          definition.record.scenarios.map(
            (s) =>
              attempt?.scenarios.find((r) => r.scenario_id === s.scenario_id)
                ?.outcome ?? "not_run",
          ),
        ),
        result_id: row.result_id,
        actor: row.actor,
        submitted_at: row.created_at,
        attempt,
      };
    });
    return {
      items,
      next_cursor:
        rows.length > input.limit
          ? makeCursor(rows[input.limit - 1]!.item_id, now(), scope)
          : null,
    };
  }
  async export(raw: unknown) {
    const input = reportExportSchema.parse(raw),
      header = await this.get(input.report_id),
      destination = path.resolve(input.directory);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const handles: Array<Awaited<ReturnType<typeof open>>> = [];
    const create = async (filename: string) => {
      const handle = await open(path.join(destination, filename), "wx", 0o600);
      handles.push(handle);
      return handle;
    };
    const originalEvidence = new EvidenceStore(this.config.evidence_dir),
      copyEvidence = new EvidenceStore(path.join(destination, "evidence"));
    let itemCount = 0,
      evidenceCount = 0,
      unavailableEvidence = 0;
    try {
      const json = await create("report.json"),
        markdown = await create("report.md"),
        manifest = await create("manifest.json");
      await json.writeFile(canonical(header).slice(0, -1) + ',"items":[');
      await markdown.writeFile(
        `# 验收执行报告\n\n报告：${md(header.report_id)}\n\n项目：${md(header.plan_snapshot.project_name)}\n\n执行组：${md(header.execution_id)}\n\n提交状态汇总：${md(canonical(header.summary))}\n\n人工审核：执行者声明和证据留待人审核；未做自动语义审核。\n\n已选类型：${header.plan_snapshot.selected_type_ids.map(md).join("、")}；配置修订 ${header.plan_snapshot.project_types_revision}\n\n历史新鲜度：${md(canonical(header.plan_snapshot.history_freshness))}\n\n变更快照：${md(canonical(header.plan_snapshot.change_snapshot))}\n\n`,
      );
      await manifest.writeFile(
        `{"schema_version":1,"report_id":${JSON.stringify(header.report_id)},"evidence":[`,
      );
      let cursor: string | undefined;
      do {
        const page = await this.items({
          report_id: header.report_id,
          cursor,
          limit: 100,
        });
        for (const item of page.items) {
          for (const scenario of item.attempt?.scenarios ?? [])
            for (const evidence of scenario.evidence) {
              if (evidence.object_key) {
                try {
                  const data = await originalEvidence.read(evidence.object_key);
                  await copyEvidence.putManaged(
                    data,
                    evidence.content_hash ?? undefined,
                  );
                  evidence.availability_at_export = "available";
                } catch (error) {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    ["ENOENT", "evidence_corrupt"].includes(String(error.code))
                  ) {
                    evidence.availability_at_export = "unavailable";
                  } else throw error;
                }
              } else evidence.availability_at_export = evidence.availability;
              if (evidence.availability_at_export === "unavailable")
                unavailableEvidence++;
              await manifest.writeFile(
                (evidenceCount++ ? "," : "") +
                  canonical({
                    ...evidence,
                    item_id: item.item_id,
                    result_id: item.result_id,
                  }),
              );
            }
          await json.writeFile((itemCount++ ? "," : "") + canonical(item));
          await markdown.writeFile(renderItem(item));
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      await json.writeFile('],"omitted_decisions":[');
      await markdown.writeFile("\n## 未纳入执行的标准\n\n");
      let omitted = 0,
        decisionCursor: string | undefined;
      const plans = new AcceptancePlans(this.store, this.config);
      do {
        const page = await plans.decisions({
          plan_id: header.plan_id,
          cursor: decisionCursor,
          limit: 200,
        });
        for (const raw of page.items) {
          const decision = raw as {
            included: boolean;
            title: string;
            reason: string;
            importance: string;
          };
          if (decision.included) continue;
          await json.writeFile((omitted++ ? "," : "") + canonical(decision));
          await markdown.writeFile(
            `- ${md(decision.importance)} · ${md(decision.title)}：${md(decision.reason)}\n`,
          );
        }
        decisionCursor = page.next_cursor ?? undefined;
      } while (decisionCursor);
      await json.writeFile("]}");
      await manifest.writeFile("]}");
      if (!omitted) await markdown.writeFile("无。\n");
      return {
        report_id: header.report_id,
        directory: destination,
        json: path.join(destination, "report.json"),
        markdown: path.join(destination, "report.md"),
        manifest: path.join(destination, "manifest.json"),
        items: itemCount,
        evidence: evidenceCount,
        unavailable_evidence: unavailableEvidence,
      };
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    }
  }
}
