# 人工来源门禁与 Codex 真实历史运行

日期：2026-10-23。本记录验证 ANA-008 的来源门禁，并证明授权 Codex 历史可以通过外部智能体路径完成清空、重建、采集、分段、分析、关系提交和 SQLite 查询闭环。它是实现验证记录，不是被提炼项目的验收报告，也不判断能否发布。

## 输入与范围

| 项目                 | 实际值                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 操作系统             | Windows 10.0.26200 x64                                                                                              |
| Node.js / npm        | v24.21.0 / 11.19.0                                                                                                  |
| SQLite               | better-sqlite3 3.53.4                                                                                               |
| 历史适配器           | Codex                                                                                                               |
| Codex 客户端声明版本 | 0.163.0-alpha.10.2                                                                                                  |
| 源覆盖               | partial                                                                                                             |
| 源文件               | `.bug-manager-local/cua-codex-run-20261023/source-human-origin/frontend-skill-session.jsonl`，475 行、3154363 bytes |
| SHA-256              | `FE1B7FD918E4ADCB9E84BF0043C1DDB434C8750EA902DEC5DBA56FE009901A46`                                                  |
| 分析版本             | 4                                                                                                                   |
| 分段                 | 66                                                                                                                  |
| 解析缺口             | 7，全部为 `unknown_event_type:thread_settings_applied`                                                              |

样本是只读受管副本，原始会话留在原位。本记录不包含完整会话、私有绝对路径、账号令牌或模型 Key。`.bug-manager-local/` 不进入 Git、npm 包或公开测试夹具。

## 来源门禁

实现和测试要求：

- `human_reported`：Bug 必须引用 `role=user, kind=human_report` 的精确用户原文。
- `human_guided_review`：必须同时引用在先的 `role=user, kind=human_guidance` 和其后的 `role=assistant|tool, kind=agent_finding`。
- 服务从当前段或有限邻接段重新读取事件角色和摘录，不接受模型伪造角色或只修改来源枚举。
- Agent 自写测试、自主审计、工具自身失败和没有人工来源的发现不能创建 Bug，也不能单独派生新标准。
- 长工具输出可以跨越多个分段；分段器保留最近的用户引导锚点，使后续 Agent 发现仍能追溯到人工检查范围。

合成回归覆盖人工直接报告、人工引导检查、Agent 自写测试拒绝、来源角色伪造、引导晚于发现，以及长工具输出后的邻接证据。内置模型和外部 `Analysis.submit` 共用同一领域门禁。

## 清空重建与运行结果

受管 SQLite 库先删除并重新由显式迁移 `001_initial` 至 `006_acceptance_execution` 建立，然后通过外部分析 CLI 处理受管副本；本轮没有使用模型 API Key。

| 检查           | 结果                                                       |
| -------------- | ---------------------------------------------------------- |
| 分段任务       | `committed=3`、`no_findings=63`、pending/failed 合计 0     |
| 采集任务       | `completed`                                                |
| 解析缺口       | 7；成功读取的 66 段全部有分析结果                          |
| Bug            | 7 个 active，均有至少一个类型和覆盖标准                    |
| 验收标准       | 6 个 active，均有至少一个类型和可执行场景                  |
| Bug ↔ 标准关系 | 7                                                          |
| 来源链         | 14                                                         |
| Bug 来源       | 3 个 `human_reported`、4 个 `human_guided_review`          |
| 重复与完整性   | Bug 指纹重复 0、标准指纹重复 0、无标准 Bug 0、无类型实体 0 |

数据库位于 `.bug-manager-local/cua-codex-run-20261023/library.sqlite`。它是本地运行数据，不是可提交证据。只读查询确认 `bugs` 表没有 open/fixed/closed 等修复状态字段；库中只有知识治理用 `disposition=active`。

一条“复杂页面的语义标题顺序在桌面与移动视口均保持有效”标准同时关联“标题字号弱于正文”和“固定级差跨设备失稳”两个 Bug，验证了一标准多 Bug、Bug 与标准独立存储和独立去重。

## 人工发现与排除边界

保留的四类人工引导检查结果来自用户明确要求阅读前端历史并分析 Skill 还需要优化什么；之后的 Agent 回复分别报告复杂编辑职责混杂、查看/编辑入口重复、内部标识暴露和折叠表格不可读。四条 Bug 均保存用户引导和 Agent 发现两侧证据。

未保留的内容包括：

- Agent 自主读取、检查或运行工具时产生的 `exit_code=1`；
- Agent 未获人工引导时自行新增或选择测试得到的失败；
- 一般功能需求、环境上下文、安装/重启说明和最终概括；
- 没有可执行故障或人工来源的消息。

其余 63 个分段以 `no_findings` 完成，reason 明确记录不属于人工报告或人工引导检查范围。`no_findings` 是分析完成状态，不是“整份会话没有对话”。

## 自动验证

当前源码在 Windows 上执行：

| 命令                       | 结果                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `npm run lint`             | 通过，0 warnings                                              |
| `npm run typecheck`        | 通过                                                          |
| `npm test`                 | 3 files，40 passed，20 PostgreSQL-only skipped                |
| `npm run test:integration` | 13 files，62 passed，57 PostgreSQL-only skipped               |
| `npm run test:e2e`         | 4 files，5 passed，2 PostgreSQL-only skipped                  |
| `npm run build`            | 通过                                                          |
| `npm run test:pg`          | 20 files，186 passed，0 failed，0 skipped；真实 PostgreSQL 16 |

`npm run test:pg` 启动临时 PostgreSQL 16 容器，完成后删除容器。SQLite split 命令中的 skip 不会替代 PostgreSQL 结果；两类数据库分别在本次运行中执行。

## 未验证范围

- Claude Code 真实历史兼容性未验证；已有适配器只覆盖合成和格式边界。
- 本样本有 7 个未知事件类型，因此源覆盖是 partial，不能声称整份历史 100% 可解析。
- 未为本样本建立项目归属映射，也未执行项目验收计划、智能体验收、结果报告或人工审核。
- Claude Code 真实客户端及其他客户端版本仍未验证；npm 包尚未发布。
- 解析成功和知识入库不代表证据真实性已经由系统审核，也不产生发布许可。
