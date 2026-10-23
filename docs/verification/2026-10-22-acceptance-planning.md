# 变更与验收计划验证（2026-10-22）

环境：Windows、Node v24.21.0；SQLite 与测试专用 PostgreSQL 16。项目仓库、提交、历史和参数均为临时合成数据。产品只生成计划，不执行计划中的测试或设备操作。

## 已验证

- `npm run typecheck` 后，`npx vitest run tests/integration/changes.test.ts`：1 文件、6 测试通过，两种数据库分别运行 Git working-tree、range、base 和 explicit 输入。
- 初次计划验证发现 SQLite 同进程两个连接竞争写锁时，同步 busy wait 阻止拥有锁的异步事务提交。已改为 BEGIN IMMEDIATE 的有时限异步退避；原始失败没有记为通过。
- 修复后 `npm run typecheck` 及 `npx vitest run tests/integration/plans.test.ts`：1 文件、10 测试通过。后续新增的模型建议/新计划细化用例须以新的完整测试结果为准。

| Task | Requirement / scenario | Check / result | Evidence |
| --- | --- | --- | --- |
| 8.1 | PLN-001 Git/显式快照 | 暂存重命名、未暂存删除、中文未跟踪文件及 hash；SHA、merge-base、无效 ref；上限可见；Git index 字节及状态不变 | `tests/integration/changes.test.ts` |
| 8.2 | PLN-002/003 范围与 I0 | 类型 ANY、标准 ID 唯一；排除候选/未选子类型；I0 skip 提议不生效，必要参数未解仍保留 | `tests/integration/plans.test.ts` |
| 8.4 | HIS-007/PLN-002 新鲜度 | 默认 lazy；内置无 Key 保留 pending，预算到期 partial；no-sync 明示；fresh_through、未分析段和覆盖状态可见 | `tests/integration/plans.test.ts` |
| 8.5 | PLN-006 冻结集合 | 同事务分批冻结 209 条标准，多连接并发批量更新不产生跨页混合修订；后续更改标准/类型不改变旧计划；参数类型错误回滚 | `tests/integration/plans.test.ts` |

物理数据库版本 v5 增加 `change_snapshots`，配置及逻辑归档格式版本仍为 1。变更快照不可变，计划保存其内容、hash 及项目归属。模型只接收分页摘要。209 条检查不是十万级性能声明。

`PlanSelections` 支持按页模型建议及外部判断细化。细化创建新计划，沿用原冻结变更、类型及修订，不表示重新同步；I0 保留、未决保守纳入。Task 8.3 的新增测试已包含在下列完整测试快照中。

后续完整验证：`npm run format/typecheck/lint/build` 成功，配置测试 PostgreSQL 后 `npm run test:all`：13 文件、136 测试通过，无失败/跳过，耗时 133.33 秒。覆盖双数据库模型 HTTP 选验建议、幂等重放、外部判断细化及 I0 skip 不生效。`npm run test:package` 独立安装成功，5 文件、161784 bytes，SHA `68bd7b9692fd7944c2e9bafb99a5eab392000f1f`。这是执行记录/报告实现前、物理 schema v5 的完整快照。

真实模型端点、真实客户端版本、macOS/Linux 尚未验证。结果/双报告仍待实现，计划生成不代表完整验收交付。
