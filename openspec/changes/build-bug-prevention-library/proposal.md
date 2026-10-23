# Proposal

## Why

开发对话中存在大量可复用的故障经验，但它们分散、重复，无法稳定转化为后续项目可执行的验收要求。建立以类型检索的 Bug 预防知识库，让智能体沉淀经验、按变更执行标准，并提交可人工审核的报告。

## What Changes

- 建立个人多项目中心库，SQLite 默认、PostgreSQL 可选，统一 CLI、MCP、Skill 与 worker 核心逻辑。
- 只读采集 Codex、Claude Code 本地历史，支持手动、使用时增量、后台持续同步，带上下文分段与断点续跑。
- 支持内置 OpenAI 兼容模型与外部智能体分析；Bug 只统计人工发现或人工明确引导 Agent 检查发现的问题，忽略 Agent 自写测试或自发审计发现的问题；提炼时分别维护 Bug、独立标准和多对多关联，按可信度分流。
- 建立受控多类型词典和扩展标签；先类型过滤，再分层召回、分别去重，跨项目保留场景证据。
- 通过稳定项目 ID、多目录映射和保存的项目类型配置约束后续验收范围。
- 按 I0 必验、I1–I3 结合 Git/显式变更选验生成版本冻结的计划，由智能体实际执行。
- 接收结构化结果和关键证据，导出 Markdown＋JSON 供人审核。

不加入 Bug 修复状态、内置验收执行器、结果自动审核、发布判定、HTML 报告或 Web 管理台。确认决策见 `docs/decisions.md`。

## Capabilities

### New Capabilities

- `project-registry`: 稳定项目身份、目录映射、类型选择与配置快照。
- `taxonomy`: 受控多类型、别名、扩展标签、过滤与分页语义。
- `knowledge-catalog`: 独立 Bug/标准、多对多关联、场景证据、等级与版本。
- `history-ingestion`: 两类历史适配器、三种同步、上下文分段、检查点与恢复。
- `analysis-runtime`: 双分析路径、模型兼容配置、可信度分流、脱敏与预算。
- `deduplication`: 分实体、类型约束的来源/指纹/全文/可选向量召回及安全合并。
- `acceptance-planning`: Git/显式变更、类型约束、分级选择和不可变验收计划。
- `acceptance-reporting`: 结构化执行记录、关键证据、Markdown/JSON 与人工审核边界。
- `agent-interfaces`: CLI、stdio MCP、产品 Skill 和长任务一致契约。
- `storage-portability`: SQLite/PostgreSQL、迁移、并发事务、备份和可携带证据。

### Modified Capabilities

无。当前仓库没有已有能力基线，本 change 描述首版待实现范围。

## Impact

后续新增 TypeScript 工作区、双后端迁移、适配器与模型配置、npm CLI/MCP 分发和 Skill。原始会话只读，不修改客户端历史、登录凭据或目标项目代码。包含对外模型调用的运行方式只在用户配置后启用。

规范阶段只交付文档与 OpenSpec 工作流。正式包名与开源许可证在实际发布前确认；本次不发布，不把规范就绪记为产品交付。
