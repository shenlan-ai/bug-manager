# 历史采集与分析验证（2026-10-22）

这是实现检查记录，不是目标项目的验收报告。环境为 Windows、Node v24.21.0，SQLite 使用 better-sqlite3，PostgreSQL 使用测试专用 postgres:16-alpine 容器。所有历史、凭据和 HTTP 响应均为合成数据；未读取私人历史或账号令牌。

## 已执行

- `npm run format`、`npm run typecheck`、`npm run lint`、`npm run build` 成功。
- 设置测试专用 `BUG_MANAGER_TEST_DATABASE_URL` 后执行 `npm run test:all`：10 文件、98 测试通过，无失败/跳过。此结果为恢复请求修复前的完整快照。
- `npm run test:package`：tarball 在临时独立消费者实际安装，CLI init/doctor 成功。包 5 文件、128737 bytes，SHA `17f9fab68fdab319f6fa2b8089ee3195be262842`。这是此时包的快照，不代表后续修改后的包。
- 恢复请求与持续覆盖修复后执行 `npm run typecheck`，再运行 `npx vitest run tests/integration/history.test.ts tests/integration/model.test.ts tests/contracts/catalog.test.ts`：3 文件、78 测试通过，无失败/跳过，耗时 88.52 秒。包括两种真实数据库、1001 个缺失源会话检查、跨页发现缺口保留，以及相同 resume 请求不再次调用模型。

## requirement → scenario → check/result → evidence

| 任务 | Requirement / 场景 | 检查与结果 | 可复查证据 |
| --- | --- | --- | --- |
| 3.3 | PRJ-003 两路径保存、旧修订冲突 | 外部领域接口和本地 HTTP provider 保存同一项目配置结构，保持 reason/actor/revision；空类型拒绝 | `tests/contracts/catalog.test.ts`、`tests/integration/model.test.ts` |
| 3.4 | TAX-003/004 ANY/ALL、无范围、层级与分页 | 多类型只返回一次，ALL 交集，父子不展开，摘要有界、游标变更报错 | `tests/contracts/catalog.test.ts` |
| 5.1 | HIS-001 格式清单、未知记录、只读 | 适配器记录不支持类型/内容、未知客户端版本；源字节不变 | `tests/unit/history.test.ts`、`packages/core/src/history/adapters.ts` |
| 5.4 | HIS-003 原因跨段、超长输出 | Unicode 安全分割、父事件、有限邻接、extractive-v1 摘要依赖；引用相邻来源后 provenance 保留 | `tests/unit/history.test.ts`、`tests/integration/history.test.ts` |
| 5.5 | HIS-002/004 手动/使用时增量、三路重复 | 采集/分析进度独立，重放不重复分段或提交，无发现显式完成 | `tests/integration/history.test.ts`、`tests/integration/concurrency.test.ts` |
| 5.7 | HIS-006 半行、UTF-8、坏记录、替换移动 | 等待半行、分页超大损坏行、内部替换新代次、跨根移动不重复，问题范围可分页 | `tests/unit/history.test.ts`、`tests/integration/history.test.ts` |
| 6.1 | ANA-004/005 排除、脱敏、注入隔离 | 合成 Key 不出现在库/提示，二进制/原始 JSON 不落库；注入标记命令没有执行 | `tests/integration/history.test.ts`、`tests/integration/model.test.ts`、`tests/e2e/transports.test.ts` |
| 6.2 | ANA-001/HIS-005 无 Key claim/context/submit | owner token 续租、替换、迟到拒绝；知识/来源/完成点同事务；真实 CLI/MCP 跨接口操作 | `tests/integration/history.test.ts`、`tests/integration/concurrency.test.ts`、`tests/e2e/transports.test.ts` |
| 6.4 | ANA-001/003 同提案规则与证据分流 | 两路径都经 Analysis.submit/Catalog；未引用真实片段、矛盾、截断检索留候选，模型自评不能绕过 | `tests/integration/history.test.ts`、`tests/integration/model.test.ts` |
| 6.5 | ANA-006/007 预算与版本恢复 | 请求前持久化用量，预算耗尽暂停、段保留；显式续预算/重分析保留旧版本和摘要依赖 | `tests/integration/model.test.ts`、`tests/integration/history.test.ts` |
| 7.2 | DED-007 多语言类型过滤全文召回 | 中文共同机制词改写、英文、混合文本在两 DB 均命中且不泄漏其他类型 | `tests/contracts/catalog.test.ts` |

## 本轮新增恢复边界

物理 schema v4 添加异步请求签名保留和发现缺口表。请求签名与领取在同一短事务，最终响应与批次检查点在同一事务；相同幂等键返回原始最终响应，中断后不重放过期 owner token。发现问题按 root/path hash 持久化，完成整根扫描才清理旧问题，分页不能抹去早先缺口。未保存私人相对路径。

缺失源检查以 200 条分页遍历全部已知会话；1001 条用例在 SQLite 和 PostgreSQL 均标记 unavailable，不再只检查前 1000 条。未宣称该检查在任意规模下的性能。

## 合并与 worker 重启补充验证

- `npx vitest run tests/integration/merges.test.ts`：1 文件、8 测试通过，双后端分别验证独立标准/Bug 合并、跨项目场景、类型并集、来源链接、旧 ID 重定向、旧修订可读和覆盖关系乐观锁。评级、参数或同 ID 场景冲突保存 merge candidate；修正原知识后，可带候选 ID 和当前修订重新提交并确认。未用尚不存在的报告功能证明历史报告读取。
- `npm run typecheck`、`npm run build` 后执行 `npx vitest run tests/integration/worker.test.ts tests/integration/concurrency.test.ts`：2 文件、10 测试通过。SQLite/PostgreSQL 各自以独立 Node worker 采集 101 个合成会话，第一批完成 100 个时 SIGKILL，停机期间追加，再启动新 worker；未完成批次恢复，下一轮发现停机追加，最终只有 102 个段。另验证真实 watch、关闭 watch 后周期补扫和优雅关闭。Task 5.6 的实际 kill/restart 条件已满足。

任务 4.4 的知识及关系 expected_revision、修订历史和旧 ID 重定向已有上述证据。任务 7.1 的旧 Bug 添加新标准、新 Bug 复用旧标准，分别见 merges/history 测试；来源重放与别名归一化由 history/catalog contract 验证。任务 7.4 的“已有报告读取”仍需报告功能完成后的端到端验证，继续保留未勾选。

## 尚未证明

- Codex/Claude Code 适配器仅有合成样本；verified versions 为空。任务 5.2/5.3 不勾选。
- 模型测试为本地 HTTP contract，未配置/调用真实模型服务。官方文档请求曾返回 403，不据此声明当前端点兼容性；任务 6.3 不勾选。
- macOS/Linux、Node 22、远程 CI 尚未在本轮执行；配置文件不作为通过证据。
- 可选向量、20 万知识基准、验收计划/报告和完整 Skill 尚未完成；合并后的旧报告兼容性仍待验证。OpenSpec change 保持在途，不同步或归档。
