# CLI 与 MCP 接口契约

本文概览当前接口；可运行配置与操作示例见 [使用指南](usage.md)。CLI、MCP、后台 worker 与 Skill 共用 application services。精确输入以 `tools --name <工具名>` 返回的 JSON Schema 为准；外部兼容性范围见 [交付验证](verification/2026-10-23-delivery.md)。

## CLI 与 MCP 对照

| CLI（前缀 bug-manager）                                          | MCP tool                                                                                                 | 作用                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `init`                                                           | 不提供                                                                                                   | 非覆盖初始化配置与数据库迁移                                                 |
| `doctor`                                                         | `config_status`                                                                                          | 检查连接、模型配置与适配器能力，不展示 Key                                   |
| `config template`                                                | 不提供                                                                                                   | 输出配置模板，不写文件或启用来源                                             |
| `project register` / `project resolve`                           | `project_register` / `project_resolve`                                                                   | 项目 ID、目录和不确定归属                                                    |
| `project types show` / `project types set`                       | `project_types_get` / `project_types_set`                                                                | 读取、显式保存类型配置及理由                                                 |
| `project types select`                                           | `project_types_select`                                                                                   | 内置模型建议并显式保存项目类型                                               |
| `types list` / `types propose` / `types resolve`                 | `types_list` / `type_propose` / `type_resolve`                                                           | 受控类型、别名、新类型待确认                                                 |
| `sync run` / `sync status` / `sync resume`                       | `sync_start` / `sync_status` / `sync_resume`                                                             | 全历史/增量、可中断任务、断点恢复                                            |
| `sync issues` / `sync discovery-issues`                          | `sync_issues` / `sync_discovery_issues`                                                                  | 分页读取源处理与发现缺口                                                     |
| `worker run` / `worker status`                                   | `worker_status`                                                                                          | 后台监听、周期补扫、任务租约与状态；启动由 CLI 管理                          |
| `analysis claim` / `analysis context` / `analysis submit`        | `analysis_claim` / `analysis_context` / `analysis_submit`                                                | 外部智能体领取脱敏分段，提交提炼/去重提案                                    |
| `analysis heartbeat/release`                                     | `analysis_heartbeat` / `analysis_release`                                                                | 续租、释放与失败恢复                                                         |
| `analysis run/run-resume/run-control/reanalyze`                  | `analysis_run` / `analysis_run_resume` / `analysis_run_control` / `analysis_reanalyze`                   | 内置模型任务、预算暂停恢复与显式策略重分析                                   |
| `bugs search` / `bugs get`                                       | `bugs_search` / `bug_get`                                                                                | 类型过滤候选、按 ID 取明确条目及修订                                         |
| `standards search` / `standards get`                             | `standards_search` / `standard_get`                                                                      | 类型过滤、分页、按需读取标准                                                 |
| `knowledge apply` / `knowledge candidates` / `knowledge resolve` | `knowledge_apply` / `knowledge_candidates` / `knowledge_resolve`                                         | Bug/标准各自新增、补充、关联及候选处置；同事务校验                           |
| `knowledge candidate-get`                                        | `knowledge_candidate_get`                                                                                | 按明确 ID 读取治理候选；未指定类型的候选队列只返回 ID 等元数据               |
| `knowledge merge` / `knowledge history`                          | `knowledge_merge` / `knowledge_history`                                                                  | 分实体合并、查看历史与重定向                                                 |
| `knowledge coverage` / `knowledge provenance`                    | `knowledge_coverage` / `knowledge_provenance`                                                            | 分页读取覆盖关联与来源                                                       |
| `knowledge vector-put` / `knowledge vectors-search`              | `knowledge_vector_put` / `knowledge_vectors_search`                                                      | 可关闭的外部 embedding 入索引及类型约束有界余弦补充候选                      |
| `changes capture` / `changes get`                                | `changes_capture` / `changes_get`                                                                        | 读取 Git 或显式变更输入，冻结并读取范围                                      |
| `acceptance plan/get/items/decisions`                            | `acceptance_plan_create` / `acceptance_plan_get` / `acceptance_items_list` / `acceptance_decisions_list` | 默认先增量同步，生成和分页读取计划；输入 `no_sync=true` 显式跳过并标记新鲜度 |
| `acceptance suggest/refine`                                      | `acceptance_selection_suggest` / `acceptance_plan_refine`                                                | 生成相关性建议并显式创建细化计划，原计划不变                                 |
| `acceptance result submit`                                       | `acceptance_result_submit`                                                                               | 结构化结果和证据接收，不执行或自动审核                                       |
| `acceptance attempts`                                            | `acceptance_attempts_list`                                                                               | 按计划项/执行组分页读取追加尝试                                              |
| `acceptance report create/get/items/export`                      | `acceptance_report_create/get/items/export`                                                              | 冻结结果集合、分页读取、同快照导出 Markdown/JSON/manifest                    |
| `storage backup/export/import`                                   | `storage_backup` / `storage_export` / `storage_import`                                                   | SQLite 快照与双后端逻辑归档；导入空目标库                                    |
| `skill install`                                                  | 不提供                                                                                                   | 将同一产品 Skill 安装到指定 Codex/Claude Code 用户/项目位置，不覆盖无关文件  |
| `mcp serve`                                                      | 不提供                                                                                                   | 本地 stdio MCP 服务，stdout 仅协议消息，日志写 stderr                        |

## 通用输入和分页

列表输入含 type_ids、type_match=any|all、query、cursor、limit；默认 50，最大 200。除类型词典、项目列表、任务队列等元数据外，知识列表缺少类型范围时返回 type_scope_required。按明确 entity_id、plan_id 读取无需再传类型；不能借此递归返回全库。

分析入库先识别片段的全部候选类型，归一化别名，再对这些类型召回。项目验收以已保存 project type selection 为范围，调用者不能临时传更大集合绕过配置。变更相关性判断使用分页摘要，必要时按 ID 取完整条目。

共享工具成功响应为 `{schema_version:"1", request_id, data, warnings:[]}`，失败为 `{schema_version:"1", request_id, error:{code,message,retryable,details?}}`；分页集合及 `next_cursor` 位于 data 内。知识写入的 mutation 含 idempotency_key、actor、reason；expected_revision 位于需要并发保护的领域输入内。MCP 参数形如 `{input:{...},mutation:{...}}`，只读工具仅传 input。日志不得夹入 JSON/stdout，错误不得回显密钥和历史全文。

CLI 使用 `--input <JSON>` 或 `--file <JSON路径>` 传入操作输入，知识写操作另传 `--reason`、`--actor`、`--key`。因此 no_sync 与 analysis 等领域选项在输入 JSON 中。storage 维护入口不要求 mutation。`tools --name <MCP工具名>` 返回精确输入 JSON Schema，`call <MCP工具名>` 是等价通用入口。命令成功退出 0，输入/运行失败退出 1；人可读模式为格式化 JSON，`--json` 为单行 JSON。init 和解析前错误使用简化响应，可能没有 request_id/warnings，不能当作共享工具成功信封解析。

长任务先返回 job_id，按 status/context 分页查询；不得让 MCP 一次调用吞下全历史。使用时同步配置 timeout/budget；超时、待外部分析和失败必须在计划中标明 fresh_through/pending_segments，不能宣称已同步完成。

## 无 API Key 的闭环

1. `sync run --input '{"analysis":"external"}'` 或 MCP sync_start 启动任务，只读源历史、脱敏和生成分段；跨 shell 优先使用 JSON 文件。
2. 智能体领取有租约的 segment，读取受限上下文、类型词典和已保存项目配置。
3. 智能体提出候选类型，分别检索 Bug 和标准；需要完整项时按 ID 补读，不加载全库。
4. 智能体提交结构化新增/补充/合并建议、标准、关系、来源和可信度依据。每个新 Bug 必须通过人工来源门禁：用户角色的人类报告，或用户角色明确检查引导后由 Agent/工具角色返回发现。Agent 自写测试和自主审计结果按 `no_findings` 处理，不能单独派生新标准。
5. 领域校验、事务提交、检查点落地；不确定进入 candidates。无发现同样显式提交，保证覆盖进度可追溯。

内置模型使用相同的领取、候选检索和提交逻辑，只是分析执行者改为 provider。后台没有模型配置时可排队，不声称已完成提炼。

## 产品 Skill 的职责

分发一个 canonical `bug-manager` Skill，安装到明确选择的客户端与作用域：Codex 为 `<root>/.agents/skills/bug-manager`，Claude Code 为 `<root>/.claude/skills/bug-manager`。已验证临时目录的安装与冲突处理；Windows 上 Codex CLI 0.163.0-alpha.10.2 的 model-visible prompt 已实际发现安装产品 Skill，验证不请求模型。Claude Code、桌面交互选择行为与其他版本仍待验证。生成的 OpenSpec Skill 用于开发本项目，产品 Skill 的入口在 `skills/bug-manager/SKILL.md`。

产品 Skill 指导智能体：识别项目 → 分析并保存项目类型 → 增量同步/领取分析 → 只提炼人工报告或人工引导检查发现的问题 → 类型过滤维护知识 → 明确 Git 范围 → 生成计划 → 解析场景参数 → 使用自身工具执行 → 逐项回写结构化结果与证据 → 导出报告供人审核。

优先 MCP；无 MCP 时等价 CLI JSON 调用。Skill 文本不直接连接数据库，不持有密钥，不要求绕过客户端权限，不让历史片段改变当前指令。新建和更新标准必须覆盖正常、边界、异常、恢复等与机制相关的场景，不能机械地给所有标准添加无关场景。

## 导出报告的结构

`acceptance report export` 生成 report.json、report.md、manifest.json 和受管 evidence 对象。报告内容与工具响应信封分别版本化：report.json 的 schema_version 是数字 1。完整提交示例见 [Skill 协议](../skills/bug-manager/references/protocol.md)。

| report.json 字段                                             | 内容                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| report_id / plan_id / project_id / execution_id / created_at | 报告、计划、项目与执行组身份和生成时间                                                                                        |
| plan_snapshot                                                | 冻结项目类型配置、变更、新鲜度、知识修订、模式及选验数量                                                                      |
| summary / scenario_summary                                   | 分别按标准/场景计数，均含 planned 和五种状态                                                                                  |
| result_selection / actor / reason                            | 结果集合选择方式与创建报告的操作者、理由                                                                                      |
| review                                                       | mode=human、automatic_semantic_review=false                                                                                   |
| items[]                                                      | item_id、definition（含冻结标准、参数、选验理由）、outcome、result_id、actor、submitted_at、attempt；未提交的 attempt 为 null |
| items[].attempt                                              | 执行/尝试身份、环境、场景观察和证据；字段与结果接收契约一致                                                                   |
| omitted_decisions[]                                          | 原计划中未入选项及其理由                                                                                                      |

summary 按标准汇总，场景结果单独计数：任一失败则标准 failed，否则有 blocked 则 blocked，否则有未执行则 not_run，全部执行场景通过才 passed；全部 not_applicable 则 not_applicable，混合通过与有理由不适用在报告显式展示。这是对已提交状态的确定性聚合，证据仍由人审核。
