import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = "openspec/changes/build-bug-prevention-library/specs";
const evidence = "docs/verification/tests-windows-human-origin-2026-10-23.json";
const summary = JSON.parse(await readFile(evidence, "utf8"));
// Explicit supplemental associations where a scenario is checked by another
// requirement's shared contract. These are reviewable links, not coverage proof.
const extra = {
  "PRJ-002": [/PRJ-001/],
  "PRJ-003": [/saves project types explicitly/],
  "PRJ-004": [/PLN-002/],
  "PRJ-005": [/PLN-005\/006/],
  "TAX-001": [/CAT-001 supports several/, /PRJ-003/],
  "TAX-002": [/CAT-001/, /CAT-004 rejects/, /TAX-003/],
  "TAX-005": [/CAT-006/, /PLN-005\/006/],
  "CAT-003": [/shared prevention, Git/],
  "CAT-004": [/PLN-005\/006/],
  "CAT-005": [/CAT-001 links two/],
  "CAT-006": [/RPT-003\/005/],
  "CAT-007": [/ANA-001 atomically/],
  "CAT-002": [/CAT-002/, /ANA-008/],
  "HIS-001": [
    /HIS-006/,
    /HIS-002 recognizes archive/,
    /ANA-008 accepts direct human reports/,
  ],
  "HIS-002": [/two histories, three sync modes/],
  "HIS-003": [/HIS-003/, /derives Bug context identity/],
  "HIS-004": [/ANA-001 atomically/],
  "HIS-005": [/serializes idempotent replays/],
  "ANA-001": [/two histories, three sync modes/],
  "ANA-003": [/CAT-002/],
  "ANA-004": [/redacts known credentials/, /real HTTP client/],
  "ANA-005": [
    /initializes via CLI/,
    /redacts known credentials/,
    /never fetches external/,
  ],
  "DED-001": [/HIS-006 resumes UTF-8/, /shared prevention, Git/],
  "DED-002": [/TAX-003/, /TAX-004/],
  "DED-003": [/ANA-001 atomically/, /shared prevention, Git/, /CAT-003/],
  "DED-005": [/RPT-003\/005/],
  "PLN-002": [/PLN-005\/006/],
  "PLN-007": [/shared prevention, Git/, /semantically dubious declarations/],
  "RPT-001": [/RPT-006/],
  "RPT-004": [
    /configured inbox replaced/,
    /managed object directory replaced/,
    /truncated during a bounded read/,
  ],
  "RPT-005": [/semantically dubious declarations/, /CLI and real MCP share/],
  "RPT-007": [/CLI and real MCP share/],
  "API-001": [/CLI and real MCP share/, /initializes via CLI/],
  "API-002": [/structured errors and no-Key/, /CLI and real MCP share/],
  "API-003": [/initializes via CLI/],
  "API-004": [/HIS-004/, /HIS-005/, /DED-004/],
  "API-005": [
    /installs the canonical Skill/,
    /shared prevention, Git/,
    /initializes via CLI/,
    /ANA-008/,
  ],
  "API-006": [/installs the canonical Skill/],
  "API-007": [/CLI and real MCP share/],
  "DB-003": [/independent processes/, /CAT-007/],
  "DB-005": [
    /initializes safely/,
    /rejects traversal/,
    /archives, hashes/,
    /configured inbox replaced/,
    /managed object directory replaced/,
  ],
};
const notes = {
  "HIS-001":
    "Codex 两份真实文本样本通过；Claude 真实版本按用户选择暂未验证。图像/运行上下文/推理排除可见。",
  "ANA-002":
    "另有 deepseek-flash 配置端点真实 smoke；其他端点/协议不据此认定兼容。",
  "DED-007": "向量测试用确定性合成表示；不证明真实 embedding 语义质量。",
  "DB-004": "双向逻辑互导含旧计划/报告；SQLite 原生备份不替代证据归档。",
  "DB-005": "另见独立 npm tarball 安装/白名单记录。",
  "DB-006":
    "另见两后端各 10 万 Bug＋10 万标准真实合成基准；磁盘不足为 ENOSPC 注入。证据读取期间文件缩短会被拒绝，较短的旧内容不会冒充完整对象。",
  "API-005":
    "另经 Codex CLI 0.163.0-alpha.10.2 model-visible prompt 验证产品 Skill 发现；不冒充 Claude Code、交互选择行为或其他版本加载。",
  "API-006":
    "临时用户/项目目录四组合及符号链接/冲突测试；未修改实际客户端配置。",
  "ANA-008":
    "合成夹具覆盖人工报告、人工引导、长工具输出邻接、Agent 自写测试拒绝及伪造角色/反向引导；真实 Codex 脱敏会话清空重跑见 human-origin-real-run 记录。",
};
function tags(name) {
  return [...name.matchAll(/\b([A-Z]{2,3})-(\d{3}(?:\/\d{3})*)/g)].flatMap(
    (m) => m[2].split("/").map((n) => `${m[1]}-${n}`),
  );
}
const rows = [];
let scenarios = 0;
for (const capability of (await readdir(root)).sort()) {
  const content = await readFile(
    path.join(root, capability, "spec.md"),
    "utf8",
  );
  const groups = content.split(/^### Requirement: /m).slice(1);
  for (const group of groups) {
    const requirement = group.split(/\s/)[0];
    const names = [...group.matchAll(/^#### Scenario: (.+)$/gm)].map((m) =>
      m[1].trim(),
    );
    scenarios += names.length;
    const checks = summary.checks.filter(
      (check) =>
        tags(check.name).includes(requirement) ||
        (extra[requirement] ?? []).some((pattern) => pattern.test(check.name)),
    );
    const passed =
      checks.length > 0 && checks.every((check) => check.status === "passed");
    const files = [...new Set(checks.map((check) => check.file))];
    rows.push(
      `| ${capability} / ${requirement} | ${names.join("；")} | ${files.map((file) => `[${file.replace("tests/", "")}](../../${file})`).join("、")} | ${passed ? `${checks.length} 关联检查通过` : "存在未通过/未关联检查"} | ${checks.map((check) => check.check_id).join(", ")}。${notes[requirement] ?? ""} |`,
    );
  }
}
const text = `# 规范场景与验证对照

日期：2026-10-23。共 ${rows.length} 条 requirement、${scenarios} 个 scenario。每行列出原规范场景、可重跑检查文件、实际结果和脱敏证据中的 check_id；同一检查可覆盖多个相关场景。这是人工可核对的关联索引，不从检查数量计算覆盖率，也不把实现的辅助逻辑当成外部兼容性证明。

本表的自动结果来自 [Windows 双数据库全量断言记录](tests-windows-2026-10-23.json)。T 编号可在该文件中找到完整测试名、后端、状态及耗时。重跑命令为 npm run build 后 npm run test:all，PostgreSQL 需配置合成专用 BUG_MANAGER_TEST_DATABASE_URL。命令退出状态与原生/未捕获错误另见 [交付验证](2026-10-23-delivery.md)；JSON reporter success 不能独自证明整个进程成功。

真实客户端/模型范围见 [真实兼容性](2026-10-22-real-compatibility.md)；检索容量与原始计数见 [检索及恢复](2026-10-22-retrieval-and-recovery.md)。macOS、远程 CI 和 Claude 真实客户端尚无通过记录；Windows、Debian Linux 与 Alpine Linux 的具体 Node 版本、运行结果以交付验证为准。

| Requirement | Scenario | Check | Result | Evidence / 限制 |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

再生：先用 scripts/verification-summary.mjs 从最新 Vitest JSON 生成脱敏断言记录，再运行 node scripts/traceability.mjs。表的 supplemental associations 是脚本中明确维护的映射，规范新增场景后需要重新人工核对，不能仅因为存在同 requirement 标签就宣称新场景已经验证。
`;
await writeFile("docs/verification/2026-10-23-traceability.md", text);
process.stdout.write(
  JSON.stringify({ requirements: rows.length, scenarios }) + "\n",
);
