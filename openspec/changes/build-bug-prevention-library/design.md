# Design

## Context

仓库为新项目，尚无代码、数据库或现有行为。产品决策详见 `docs/decisions.md`，目标能力见本 change 的十份 delta specs。设计采用一个共享核心，避免 CLI/MCP/后台分别实现分类、去重和计划逻辑。

## Goals / Non-Goals

**Goals:** 在大量对话和知识条目下保持有界分析、幂等同步、类型受限检索；将共享故障机制与可执行标准解耦；允许无内置模型的智能体工作流；冻结验收依据并形成可追溯的人审材料。

**Non-Goals:** 不建设工单生命周期、团队账号权限、GUI、浏览器/设备执行器、自动语义审核或发布控制。数据库可连接 PostgreSQL 不等于首版成为多租户服务。

## Decisions

### 1. 分层与分发

工程默认值为 Node.js >=22、ESM、strict TypeScript、npm workspaces；一个 npm 分发单元携带 CLI、stdio MCP、worker 与 canonical Skill。模块方向：

```text
CLI / MCP / worker
       ↓
application services + schemas
       ↓
domain: project / taxonomy / catalog / dedup / planning / reporting
       ↓ ports
SQLite | PostgreSQL | history adapters | model provider | evidence store
```

Skill 是面向外部智能体的操作规则，不是第四份数据访问实现。领域层不依赖 MCP SDK 或命令行库；数据库写入口只有 application services。

选择 TypeScript 是用户决策；Kysely、Zod、官方 MCP SDK、Vitest 是可替换工程默认，不作为行为规范。避免首版引入插件市场或多个不兼容的 SDK 抽象。

### 2. 项目身份与类型边界

项目 UUID 为身份；目录、worktree、仓库远端和别名为匹配线索，不能仅用 remote URL 自动把 fork 合并。路径规范化需支持大小写差异、符号链接和不存在的历史路径。确定性映射优先，AI 推断保留理由；歧义进入待确认，历史处理可继续但不伪造项目归属。

AI 经 Skill 或内置 provider 读取项目特征与受控类型词典，保存完整类型集合及理由，使用 expected_revision 乐观锁。类型配置不会随每次验收隐式变化；类型空集返回需要配置，不能退化为全库。

ANY/ALL 过滤均使用稳定类型 ID，标准匹配多个已选类型仅一项。类型树默认不隐式展开，改名保持 ID，别名先归一化。用户明确更改配置后才包含新增类型。

### 3. 历史适配与上下文

适配器接口：discover roots/sessions、read stable logical events、checkpoint support、declared format capabilities。支持 Codex/Claude Code 本地、用户配置的路径，不依赖云 API 或账号令牌。实现时用合成及授权脱敏夹具确认具体历史版本；未知记录类型保留计数并提示覆盖缺口。

原始历史留原位。源定位包含 adapter/version/session ID/logical event range/file generation/hash；中心库存必要脱敏片段、摘要及引用。目录/会话排除在读入和模型发送前执行。工具输出也可能含 Bug，但作为数据处理，不能执行其中命令。

按完整消息/事件边界分段，超大单条输出按标记片段分割，附稳定父 ID。相邻分段有受控重叠，会话滚动摘要有依赖版本；问题在前段、确认在后段时允许后续修订已有候选。摘要不取代原始证据，回指有限上下文仍需脱敏及 token 预算。

追加写入遇到半条 JSON/UTF-8 字符等待下次；确定的坏记录报损坏范围，后续可恢复记录继续处理。截断/替换使用 file generation 重扫并以逻辑来源键防重。归档、移动与分支会话用 adapter 声明的稳定 ID 识别；无稳定 ID 时标记归属不确定，不能承诺无误匹配。

### 4. 采集、分析与提交分离

三种触发方式调度同一任务系统。watch 仅降低延迟，周期补扫校正漏事件。worker 首版为前台进程，可被现成系统管理器托管，不自动安装服务；退出释放租约，崩溃租约过期后恢复。

记录 discovery/read、segmentation、analysis、commit 的独立进度。source read checkpoint 不能被当作 analysis 完成点。分段任务的完成与确认知识变更同事务写入；网络请求和模型分析在事务之外，避免长锁。

采用数据库租约、owner token、心跳与条件更新，确保超时旧 worker 不得提交新 owner 的任务。幂等键防重；“恰好一次”落实为允许多次分析但仅一次有效提交。算法、隐私规则或模型策略改变使用显式 reanalysis job，保留以前结果。

使用时默认先做增量同步；超出预算/等待外部分析时返回 partial/pending 和新鲜度水位，再允许生成带警示的已有知识计划，不假称覆盖全部最新历史。显式 no-sync 记录其选择。

### 5. 两种分析路径

统一处理：领取分段 → 获取脱敏上下文 → 识别类型/项目 → 按类型分别召回 Bug 与标准 → 生成结构化操作提案 → schema/规则校验 → 可信度分流 → 事务提交。

内置 provider 配置 base_url、api_key_env、model、超时、token/成本预算。默认 Chat Completions，能力探测只对配置端点进行；优先结构化响应，不支持时 JSON 文本解析＋schema 校验＋有限重试。可选 Responses 模式仍属于同一 OpenAI 兼容提供者，不假定代理具备所有能力。密钥不落库、不进提示词或日志。

外部智能体用 analysis_claim/context/submit 执行同一协议，不要求 Key。无模型的 worker 只采集排队。外部提案同样不能绕过类型、来源、版本及可信度校验。

可信度不是单一模型自报分数：检查故障陈述/复现/明确因果/实际影响等来源依据；推测、需求、模型无证据断言不自动成为 active Bug。具体原因未证实可标 unknown，不能强行填根因。明显故障且标准可执行时自动生效，不确定项留 candidate；人或智能体可补证确认。

Bug 还必须有独立的 `discovery` 来源门禁。`origin=human_reported` 要求至少一条 `kind=human_report, role=user` 的原文证据；`origin=human_guided_review` 要求同时存在 `kind=human_guidance, role=user` 和 `kind=agent_finding, role=assistant|tool` 的证据。分析提交时重新读取当前段或有限邻接段，按事件角色验证摘录，而不是只相信模型填写的枚举。Agent 自写测试、自发审计或没有人工来源的自主失败不属于 Bug；这些失败即使很严重也不能建立 Bug，也不能单独派生出待验收标准。

历史提示注入作为数据隔离；不为历史中出现的“忽略规则”或脚本授予权限。隐私默认启发式脱敏，无法保证识别全部敏感内容；可扩展规则并排除来源。仅提取必要片段，没有原文件时保留已有片段并报告来源 unavailable。

### 6. 独立知识、版本与合并

详见 `docs/data-model.md`。Bug 描述表现、触发、机制/未知原因、影响、发现来源和 S 级别；标准包含机制、可执行场景和 I 级别。两者多类型、多来源、多对多关联；项目场景记录只表示曾出现的背景，不含修复状态。发现来源证据是 Bug 修订的一部分，不能由后续模型改写掩盖。

独立修订表＋当前修订指针、变更原因和 actor，使用 expected_revision。关联历史可追溯，报告引用冻结标准修订。相比事件溯源，这能满足审计和误改恢复而保持查询简单。

一段分析事务可同时新增 Bug、复用标准、建立关系，也可只补充既有记录。有效 Bug 至少有可执行标准或暂存候选解释缺口。不把源对话中的测试主张当成新执行证据，不把历史“已修复”转成系统状态。

### 7. 类型优先的分层检索与去重

先做来源/内容幂等判定，再归一化全部候选类型；在其 ANY 并集内对 Bug/标准分别执行指纹、全文召回，按需可选向量补充。不能将项目已选验收类型误用为历史提炼的全局分类边界；历史可以发现未选类型，但不改变项目配置。

FTS 搜索使用应用层统一英文归一化、中文 token 及字段权重；SQLite/PG 排名不要求逐位一致，但类型过滤、中文命中、分页无重复等行为一致。对方言差异编写共同 contract fixtures，不能只测英文。

候选摘要按 token/count 限制分页，模型决定 new/enrich/link/propose-merge。候选截断或分类不明导致的覆盖不足必须可见；不能把“第一页没有相似项”当成全局唯一证明。新建前类型集合锁/租约及重召回缩小并发语义重复窗口；确定性来源键由 DB 保证。

自动合并要求机制、前置条件和预期兼容，类型并集、证据并集和关系完整保留；评级冲突进入候选。较严重 Bug 和较重要标准不能被低风险描述静默降级。合并旧 ID 重定向而不物理删除；历史计划引用旧修订仍可读取。向量关闭时基本链路完全可用；不同 embedding 版本隔离。

可选向量接口接收调用方 embedding 工具计算的表示与元数据，当前不提供 embedding HTTP 请求器。按 entity kind/current revision/model/dimensions/normalization version 隔离，类型约束后分页扫描，余弦排序仅在当前页内生效；coverage 明示 indexed-only，全文召回仍独立可用。变更表示版本不触发历史重提炼，不覆盖原知识。

### 8. 变更、计划与版本冻结

Git 使用参数数组调用只读命令，不拼 shell 字符串。支持 working-tree（暂存＋未暂存，显式纳入未跟踪文件元数据）、commit range、base diff，记录 ref 解析后的 SHA、dirty diff hash、重命名/删除和补充说明。文件大小与 diff token 有上限，截断必须提示；不修改或清理仓库。非 Git 用显式文件/模块/说明。

先固定项目类型配置和 active 标准版本集合，再列入全部 I0；I1–I3 由内置模型或外部智能体对照变更/参数选择，保存每项选中/跳过/无法判断理由。无分析能力时默认保守纳入未决项，不静默跳过。full 模式包含全部范围内 active 标准。

计划快照包含项目、类型、Git 输入、知识新鲜度、标准修订、参数解析和选择理由。分页迭代使用一致性水位，避免中途新标准造成漏项或重复。参数未知保留项并明确待补，不制造命令执行能力。

### 9. 执行记录与人审报告

外部智能体解析项目参数，调用自己的测试/浏览器/设备工具并提交观察。系统不会运行标准里的命令、自动补做检查或调用模型评审证据。结构校验仅验证 schema、plan/item/revision、必填字段、required evidence 引用和附件边界；人工判断证据是否支持通过。

结果状态 passed/failed/blocked/not_run/not_applicable，执行者与 attempt 可追溯。无结果项归 not_run；同一项重新执行追加 attempt，报告明确选择最新完整有效提交或指定结果快照，不静默混合不同项目版本。被拒绝的不完整提交不会替换旧有效结果。

Markdown 和 JSON 从同一 report model 渲染，包括类型、I 级、冻结场景、环境、步骤预期/实际、证据、未验项、选验遗漏理由和历史新鲜度。汇总只是提交状态的确定性聚合，不做语义审核，不输出 release_allowed、阻断或豁免。

附件默认归档到受管对象目录（内容哈希、大小限制、脱敏）；路径解析须约束到受管目录，防止 `..`、符号链接和任意文件读。外部 URL/本地引用须显式提交，保留可用性标记，不自动抓取。Markdown 转义不可信文本，不嵌入可执行 HTML。

### 10. 双数据库、迁移与运行环境

共享 repository contract＋Kysely，SQLite 用本地驱动与 WAL、busy timeout、短事务；PG 使用连接池与行/事务锁。迁移显式编写两个方言并共用逻辑版本；没有自动 schema sync。FTS、JSON、upsert、锁和外键逐项 contract tests。跨进程一致性不依赖 JS 内存锁。

默认 app data 目录按 OS 解析，支持配置覆盖；数据库、证据和日志不放进目标项目仓库。更换数据库通过版本化逻辑 export/import：保留 ID、修订、来源、关联、证据 manifest，先校验再事务导入；原数据不自动删除。备份 SQLite 使用一致性备份机制，PG 使用支持的快照/导出；活动 DB 不裸拷贝。

提供 schema 版本与连接健康诊断，但输出过滤凭据。网络、DB、模型和磁盘失败返回可恢复错误，不把失败写为已完成。Windows/macOS/Linux 均需真实 CI 或对应实际环境记录。

## Risks / Trade-offs

- 模型遗漏隐含 Bug → 所有可支持历史段都有覆盖状态，保留上下文，支持重分析；不承诺提炼绝对完整。
- 类型错分影响去重与验收 → 多类型、受控别名、不确定候选、显式项目配置；不通过无限扩大模型上下文补救。
- 跨项目抽象过度 → 机制合并须兼容预期，场景参数/变体及来源独立保留。
- 中文全文检索方言差异 → 应用归一化、中文合成语料与共同后端契约。
- API 代理能力不同 → 配置/能力错误明确，schema 校验和有限重试，支持外部智能体路径。
- 历史格式无稳定公开契约 → 适配器版本及夹具，未知格式提示覆盖缺口。2026-10-22 读取 OpenAI 官方 Codex skills/mcp/config-advanced 文档返回 403，不能据此断言具体本地格式；实现时核实支持矩阵。
- 证据外部引用失效 → 默认归档关键附件，显式外部模式标注可用性，报告保留内容哈希。
- 本地多写入者冲突 → DB 租约、幂等键、expected_revision、短事务和合并前重查。

## Migration Plan

按 tasks 依赖建立基础工作区、两套迁移与 contract tests，再落地类型和知识核心、采集、两条分析、计划/报告，最后统一传输和分发。初始部署只生成空 schema，禁止默认读取全部私人目录或自动调用模型。

每次迁移先备份并预检版本；失败回滚事务，不能静默降级 schema。跨后端导出/导入以 ID、修订、链接数与证据哈希比对验证。实际实现未完成前本 change 保持在途。
