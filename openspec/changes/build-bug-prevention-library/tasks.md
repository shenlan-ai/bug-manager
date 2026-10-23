# Tasks

每项完成时记录对应 requirement/scenario、真实命令/操作、环境、结果和证据路径；证据写入 `docs/verification/`（不纳入私人原始数据）。依赖顺序按章节；未勾选项尚未满足全部实现或验证条件。

## 1. 工作区与测试基础

- [x] 1.1 建立 Node.js >=22、strict TypeScript、ESM、npm workspaces 和共享 core/CLI/MCP/worker 模块；验证干净安装、lint、typecheck、build 全部成功。
- [x] 1.2 建立 Vitest、双数据库 contract suite、集成/E2E 入口及合成夹具目录；验证无真实历史/Key 即可运行基础测试，外部条件缺失明确 skip 原因。
- [ ] 1.3 建立 Windows/macOS/Linux CI、SQLite/PG 集成矩阵；验证每个 job 输出环境和工件，PG 不用 SQLite stub 替代。

## 2. 存储与事务（storage-portability）

- [x] 2.1 按 docs/data-model.md 建立双后端显式迁移、外键及唯一约束；验证两种空库升级到同逻辑版本，失败迁移可恢复。
- [x] 2.2 实现 repository contract、乐观锁、幂等写与 job 租约；验证两个独立进程重放/争抢/租约过期时只产生一份有效提交。
- [x] 2.3 建立证据对象目录、路径约束、hash 和可用性元数据；验证路径穿越、符号链接越界、缺失和超限附件处理。
- [x] 2.4 实现一致性备份与版本化逻辑 export/import；用两后端互导验证 ID、修订、关联、来源和证据 hash 保留，失败不破坏源库。

## 3. 项目与类型（project-registry / taxonomy）

- [x] 3.1 实现稳定项目 ID、多目录/worktree 映射和冲突候选；验证搬家保留 ID、同 remote 不误合 fork、未知路径不自动造归属。
- [x] 3.2 实现受控类型、别名、新类型候选和标签；验证改名不改 ID、别名归一化、候选类型未确认不能进入有效类型筛选。
- [x] 3.3 实现项目类型选择、reason、actor、配置修订；验证外部智能体与 provider 都可保存，空配置不退化全库，并发旧修订被拒绝。
- [x] 3.4 实现多类型 ANY/ALL、游标分页、范围必填及 bounded summaries；验证 OR 去重、ALL 交集、无类型报错、项目配置不隐式扩展父子类型。

## 4. 知识模型（knowledge-catalog）

- [x] 4.1 实现 Bug/标准独立表、修订、场景与多对多覆盖关系；验证一个标准连多个 Bug/反向多关联，来源场景跨项目保留且不存在修复状态字段。
- [x] 4.2 实现 S0–S3、I0–I3 独立理由和可执行场景 schema；验证关联 S0 不自动升 I0，缺步骤/通过条件/证据要求的标准不能生效。
- [x] 4.3 实现知识候选、确认/拒绝、补证与审计；验证明确故障可生效、推测不自动生效，缺关联标准的 Bug 保留候选而非伪造标准。
- [x] 4.4 实现 expected_revision、关系修订和旧 ID 重定向；验证并发修改冲突、来源和旧修订完整可读。

## 5. 历史采集（history-ingestion）

- [x] 5.1 建立 normalized event contract 与适配器格式/能力清单；验证未知格式和记录类型能报告覆盖缺口，读取不会修改源文件。
- [x] 5.2 实现 Codex 本地适配器；以合成及授权脱敏样本验证消息、工具输出、会话身份和可支持版本，不接触账号令牌。
- [ ] 5.3 实现 Claude Code 本地适配器；验证默认/自定义路径、会话追加、可支持分支/子会话及归档，未知版本不静默跳过。
- [x] 5.4 实现上下文分段、超长事件、有限重叠及版本化摘要；验证跨分段故障/原因链可被关联，同一逻辑来源不重复附着。
- [x] 5.5 实现手动与使用时增量任务，共用采集/分析检查点；验证重复触发不重复提交，未分析段不会被报告成完成。
- [x] 5.6 实现后台 watch＋周期补扫、租约心跳和优雅退出；验证与另外两种同步同时运行、漏 watch 事件、崩溃/重启后恢复。
- [x] 5.7 实现半条写入、UTF-8 边界、坏记录、截断/替换和文件移动处理；验证等待未完成行、报告损坏范围、保留已确认来源并恢复后续处理。

## 6. 分析运行时（analysis-runtime）

- [x] 6.1 实现来源排除、必要片段持久化、发送前脱敏及提示注入隔离；验证合成 Key 不进 DB/提示/日志，源历史含命令不会被执行。
- [x] 6.2 实现 analysis claim/context/submit、租约 owner token 和外部智能体闭环；在没有 Key 的环境完成提炼、关联、候选处置并验证审计。
- [x] 6.3 实现 OpenAI 兼容 base_url/model/api_key_env、结构化输出和 JSON 校验退路；mock contract 验证格式错误/超时/429/能力不支持，另记录真实配置端点的脱敏 smoke 结果。
- [x] 6.4 实现证据依据驱动的可信度分流和双路径共享提案校验；同一 fixture 分别走内置与外部路径，验证一致的字段/候选规则，不把模型自评分当充分证据。
- [x] 6.5 实现 token/数量/请求预算、退避、暂停/恢复、模型策略重分析；验证预算耗尽留 pending、失败不推进完成点、摘要改变可追踪依赖版本。
- [x] 6.6 实现 Bug 发现来源门禁：只接受人工报告或人工明确引导 Agent 检查发现，按来源角色验证原文证据，忽略 Agent 自写测试与自主审计发现；用人工报告、人工引导、Agent 自主测试和错误标注四类夹具验证内置/外部分析一致拒绝不合法 Bug，并真实读取一条授权 Codex 会话完成清空重跑。

## 7. 分层去重（deduplication）

- [x] 7.1 实现来源/内容重放幂等、类型归一化、Bug 和标准分别召回；验证同片段重放不重复，新 Bug 能关联旧标准，旧 Bug 能补充新标准。
- [x] 7.2 实现 SQLite/PG 全文候选与共同中文 token 规则；用中文改写、英文、混合文本和多类型语料验证候选命中与无范围泄漏。
- [x] 7.3 实现候选摘要预算、游标补查和提交前并发重召回；验证第一页未命中不能冒充全局唯一，两个进程提交同类知识可被重查/候选机制识别。
- [x] 7.4 实现 new/enrich/link/propose-merge、类型/来源/关系并集与重定向；验证评级冲突/相反预期不自动合并，已有报告仍能读取旧修订。
- [x] 7.5 实现可关闭的向量补充与模型/维度隔离；验证未配 embedding 时基础链路通过，换模型不混比、不重提炼或丢失知识。
- [x] 7.6 建立可复现实验脚本和数据集；在至少 10 万 Bug＋10 万标准、每项多类型的合成规模记录类型过滤前后候选量、查询耗时和峰值内存，两种 DB 分别输出结果，不声称未测容量。

## 8. 验收计划（acceptance-planning）

- [x] 8.1 实现只读 Git working-tree/range/base snapshot 与显式输入；用含重命名/删除/未跟踪文件/中文路径的仓库验证 SHA、dirty hash、截断提示及源仓库未被修改。
- [x] 8.2 实现项目已选类型内 active 标准集合与 I0 必验；验证跨类型命中仅一项，未选类型的 I0 不进入计划，候选标准不执行。
- [x] 8.3 实现 I1–I3 变更相关性判断、全量模式和逐项 selection reasons；验证选中/跳过/未决覆盖集合完整，缺分析能力的未决项保守纳入。
- [x] 8.4 实现同步新鲜度、预算超时/无 Key pending、显式 no-sync 标记；验证部分同步计划显示未分析段，不错误宣称历史已全部处理。
- [x] 8.5 实现一致性快照、标准版本冻结、参数绑定与场景变体；验证计划生成中修改类型/标准不改变已定集合，必要参数缺失保留必验项并显式待补。

## 9. 结果与报告（acceptance-reporting）

- [x] 9.1 实现结构化环境/步骤/预期实际/证据/attempt 接收；验证 schema、归属和冻结修订错误拒绝，passed 缺 required evidence 返回字段错误，不调用模型审证。
- [x] 9.2 实现多次执行追加、快照选择和结果状态聚合；验证重复提交幂等、旧有效结果不被无效尝试覆盖、缺结果项为 not_run，not_applicable 带理由。
- [x] 9.3 实现同快照 Markdown/JSON 导出和附件 manifest；验证数量一致、类型/I 级/选择理由/未验项/新鲜度齐全，Markdown 转义不可信文本且本地证据可定位。
- [x] 9.4 验证审核与发布边界：给出失败/I0 未执行/假证据示例，报告如实呈现执行者提交内容且不自动审核、不输出发布许可、不调用外部测试或复验。

## 10. CLI、MCP 与产品 Skill（agent-interfaces）

- [x] 10.1 实现 docs/interfaces.md 的 CLI 与版本化 JSON、错误码、退出码；同 fixture 检查可读/JSON 输出，无 Key 可走 external，验收 failed 不作为发布拒绝退出码。
- [x] 10.2 实现 stdio MCP 工具与长任务 job_id/分页；通过真实 MCP 客户端握手及完整写读验证 schema、stdout 无日志、与 CLI 结果一致。
- [x] 10.3 编写 canonical 产品 Skill 和显式客户端/作用域安装；用临时 Codex/Claude Code 配置验证安装幂等、不覆盖已有无关 Skill、工作流可走 MCP 或 CLI。
- [x] 10.4 实现 doctor、worker 状态及配置模板；验证连接错误可诊断且 URL 凭据/Key 不外泄，不自动改用户系统服务。

## 11. 完整闭环与交付证据

- [x] 11.1 在两种数据库上运行“合成历史→三种同步→分段→双路径提炼→跨项目去重→类型选择→Git 计划→模拟智能体真实提交→双报告”E2E，验证同源不重复且标准多 Bug 复用。
- [x] 11.2 故障注入验证模型/DB 断连、磁盘不足、进程 kill、写入冲突、丢失源文件与证据缺失；记录恢复后无部分提交/来源丢失，未完成覆盖透明可见。
- [ ] 11.3 完成 lint/typecheck/unit/integration/E2E/build 和 npm pack 内容检查；在支持的 OS 核实 CLI、MCP、worker/Skill 安装，排除真实历史、Key、DB 和私人证据。
- [x] 11.4 形成 requirement→scenario→check→result→evidence 对照，列出真实模型、客户端版本及 OS 未验证项；不以 mock 代替真实端点或客户端兼容性声明。
- [x] 11.5 确认许可证/最终包名的发布决策入口，补齐安装/模型配置/隐私/备份/升级文档；验证新用户按文档可完成本地闭环，未经明确指令不发布。
- [ ] 11.6 运行 OpenSpec 严格全量校验并逐项核对实现证据；所有必要任务和验证满足后才归档到 openspec/specs，未完成项不得批量勾选。

## 2026-10-23 收尾证据

当前 49/53 项完成。完整环境、命令退出结果和限制以 [交付验证](../../../docs/verification/2026-10-23-delivery.md) 和 [人工来源真实运行](../../../docs/verification/2026-10-23-human-origin-real-run.md) 为准。

| 任务        | Requirement / 检查与证据                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.2         | HIS-001；history.test.ts 合成回归及 verify-history.mjs 两份实际授权样本，生产者 0.162.0-alpha.17.2、源 hash 不变；[真实兼容性](../../../docs/verification/2026-10-22-real-compatibility.md)                                                           |
| 6.6         | ANA-008、HIS-001、CAT-002、API-005；合成夹具覆盖人工报告、人工引导、Agent 自写测试拒绝与伪造角色；Codex 0.163.0-alpha.10.2 脱敏会话完成清空重跑，66/66 分段有结果；[人工来源真实运行](../../../docs/verification/2026-10-23-human-origin-real-run.md) |
| 6.3         | ANA-002；model.test.ts 错误/退路契约及指定 deepseek-flash 的 9 次有界实际请求；同上模型计数和格式退路记录                                                                                                                                             |
| 10.1 / 10.2 | API-001/002/003/004/007；transports.test.ts 真正 SDK stdio 握手、双后端 CLI/MCP 交叉写读、分页、错误、含失败报告退出 0；Windows 全量逐项断言见交付验证                                                                                                |
| 10.4        | API-002、DB-006、HIS-008；doctor.test.ts、worker.test.ts、worker-watch-error.test.ts 验证模板、实际不可达连接、watch 故障后的周期补扫、状态和无凭据输出                                                                                               |
| 11.2        | ANA-006、HIS-005/006/008、CAT-007、DB-003/006、RPT-002/004；failures/concurrency/history/worker/reports 测试，包含真实 PG own-connection 终止、worker kill/restart、watcher error 故障注入；ENOSPC 为注入而非填满磁盘                                 |
| 11.4        | [66 requirement / 115 scenario 对照](../../../docs/verification/2026-10-23-traceability.md)，关联 Windows 173 个通过断言及稳定 T001–T173；T170–T172 覆盖场景身份与受管证据目录链接越界，T173 覆盖证据读取期间截短；外部兼容性限制单独列明             |
| 11.5        | [安装/运行/备份/升级/发布决策入口](../../../docs/operations.md)、usage 和 Skill 协议；独立 tarball 消费者初始化/安装及 workflow E2E；源码选择 MIT 并允许公开协作，npm 发布仍保持独立决定和 `private=true`                                             |

11.3 的部分进展：当前人工来源门禁源码已在 Windows Node 24.21.0 上以真实 SQLite＋PostgreSQL 跑完 20 个文件、186 项测试，0 失败、0 跳过、进程退出 0，见 [人工来源真实运行](../../../docs/verification/2026-10-23-human-origin-real-run.md)。较早的 Windows/Debian 173 项记录、Alpine 172 项记录和包烟测仍是历史快照，不能单独替代这次源码验证；两平台 tarball 曾在独立消费者实际启动 CLI、MCP、worker 合成历史扫描及 Skill 安装，但需要针对来源门禁变更重新核验后才可作为当前包证据。另以 Debian Node 22.23.4 干净容器重放较早工作流，39/56/5 项检查通过，0 失败；该本地重放不冒充远程 GitHub Actions。Windows Codex CLI 0.163.0-alpha.10.2 的 `debug prompt-input` 曾将临时项目安装的产品 Skill 列入 model-visible Skills，安装内容 hash 与 canonical 源一致，见 [Codex Skill 客户端证据](../../../docs/verification/codex-skill-client-2026-10-22.json)。这仍不足以完成 11.3。

保留未完成：1.3 的远程三 OS CI 尚未运行；5.3 的 Claude Code 真实兼容性按用户选择暂未验证；11.3 缺 macOS、Claude Code 真实客户端和桌面客户端/其他版本加载；11.6 的 strict 校验可以通过，但必要外部验证尚未齐全，因此不归档、不同步为正式基线。
