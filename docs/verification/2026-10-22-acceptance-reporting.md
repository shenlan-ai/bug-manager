# 执行结果、报告与产品 Skill 验证

日期：2026-10-22；Windows、Node v24.21.0，SQLite 与专用 PostgreSQL 16 隔离合成 schema；物理数据库 v6。未读取真实历史、客户端凭据或调用真实模型。

## 命令与结果

- `npm run format`、`npm run typecheck`、`npm run lint`：通过（报告实现）。后续 Skill/接口改动纳入最终回归。
- `BUG_MANAGER_TEST_DATABASE_URL=<专用合成库> npx vitest run tests/integration/reports.test.ts tests/integration/archive.test.ts`：2 文件、14 测试通过，两种数据库均实际运行。
- `npm run build` 后 `npx vitest run tests/e2e/transports.test.ts`（同上 PG 环境）：3 测试通过，含真实 stdio MCP 子进程和 CLI，非 MCP mock。
- `npm run typecheck`、`npm run build`、`npx vitest run tests/e2e/skill.test.ts`：通过，1 项测试覆盖四种安装组合及冲突/越界。

首次报告测试的两项失败为 Markdown 正确转义 not_run，而断言期待未转义源字符串；已改为转义断言。首次 PostgreSQL MCP E2E 失败为测试未把隔离 PG URL 环境变量传入子进程；显式传递后通过。未改变领域校验。

## requirement / scenario / check / result / evidence

| Requirement | 场景与检查 | 结果与代码证据 |
| --- | --- | --- |
| RPT-001/002 | 缺 required evidence、错误归属/修订、步骤越界、无理由 N/A、附件遍历 | reports.test.ts：两后端拒绝非法输入，不写入有效结果 |
| RPT-003/006 | 同 attempt 重试、冲突 attempt、不同版本执行组、失败优先/缺场景 not_run | reports.test.ts：追加/冻结明确执行组，旧报告不变 |
| DED-005/CAT-006/RPT-005 | 报告生成后合并原标准 | reports.test.ts：旧报告仍读取冻结定义，旧 ID 重定向可用 |
| RPT-004/005 | 同快照双报告/manifest、脱敏对象复制、导出时对象丢失、外部 URL、不覆盖旧目录 | reports.test.ts：两种可用性独立；无网络请求；HTML/Markdown 转义 |
| RPT-002/007/API-007 | 结构完整但不能证明结论的文本；failed 和 I0-not_run 导出 | reports.test.ts + transports.test.ts：不调用模型审核，无 release_allowed，CLI 退出 0 |
| API-001/002/003 | CLI 写知识，真实 MCP 读计划/提交结果/冻结报告，CLI 导出；非法输入一致 | transports.test.ts：两种数据库完整写读，missing_evidence 一致 |
| API-005/006 | Codex/Claude × 用户/项目安装，重复安装、同名定制冲突、无关 Skill、junction 越界 | skill.test.ts：相同内容 unchanged、冲突保留、越界不写 |

这是合成执行者提交和运行协议证据，不等同于系统替用户执行或审核验收。真实客户端自动加载 Skill、macOS/Linux、真实源格式及模型端点仍未验证。没有发布或归档 change。
