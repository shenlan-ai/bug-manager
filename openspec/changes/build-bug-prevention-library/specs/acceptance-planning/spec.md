# Spec Delta

## Purpose

根据项目明确选择的类型、标准重要性及本次代码或业务变更，形成有理由、有版本依据的分级验收计划，减少无关重复检查并保留所有必验项，指导编程智能体执行而不决定发布。

## ADDED Requirements

### Requirement: PLN-001 Explicit change snapshots

系统 SHALL 支持 Git 未提交修改、指定提交区间、相对基准差异及补充说明，并支持非 Git 项目的显式输入，保存最终使用的变更快照和截断限制。

#### Scenario: 未提交变更
- **WHEN** 调用方选择工作区变更
- **THEN** 快照标明暂存、未暂存及显式纳入的未跟踪文件，保存基准身份和差异标识，不修改仓库

#### Scenario: 非 Git 或缺少 ref
- **WHEN** 项目无 Git 元数据或提供的 ref 无法解析
- **THEN** 系统要求合法显式范围或返回明确错误，不假定无变更

### Requirement: PLN-002 Eligible versioned standard set

系统 SHALL 从项目已选类型中取得 active 标准的一致集合，按标准 ID 去重，排除候选标准；记录配置修订与知识新鲜度。

#### Scenario: 一个标准命中多个类型
- **WHEN** 标准同时匹配三个项目已选类型
- **THEN** 计划只包含一个对应标准项，并保留多类型信息

#### Scenario: 新类型标准不在配置
- **WHEN** 历史分析发现项目尚未选择的新类型
- **THEN** 其标准不会自动扩大本次计划范围，项目配置保持不变

### Requirement: PLN-003 I0 always included within scope

系统 SHALL 在普通与全量计划中包含范围内全部 I0 标准，不因变更无关、参数未解或缺执行环境而跳过；这些限制必须显式留在项中。

#### Scenario: 无相关变更但 I0
- **WHEN** I0 标准属于项目所选类型，而变更只涉及另一模块
- **THEN** 标准仍被列为必验，选择理由明确

#### Scenario: I0 环境缺失
- **WHEN** I0 场景需要当前不可用设备或测试账号
- **THEN** 该项保留，参数/环境缺口可见，不从计划删除

### Requirement: PLN-004 Change-aware lower-importance selection

系统 SHALL 允许内置模型或外部智能体结合变更判断 I1–I3 相关性，保存每个候选的选中、跳过或无法判断理由；无法判断且无后续分析时保守纳入，不静默漏掉。

#### Scenario: 相关与不相关标准
- **WHEN** 变更涉及订单重试，存在相关幂等标准及无关排版标准
- **THEN** 系统可选中前者、跳过后者，报告可查询两者理由

#### Scenario: 缺少分析能力
- **WHEN** 没有可用内置模型且外部智能体未提供选择判断
- **THEN** 未决范围内标准被保守纳入并标明理由，不自动猜测为不适用

### Requirement: PLN-005 Full mode and auditable coverage

系统 SHALL 提供全量计划，包含所选类型内全部 active 标准，并提供可分页的完整选择记录；全量不扩大项目类型边界。

#### Scenario: 全量验收
- **WHEN** 调用方指定 full 模式
- **THEN** I0–I3 范围内标准全部入选，未选类型仍排除，执行项数量与去重候选集合一致

### Requirement: PLN-006 Immutable plan bindings

系统 SHALL 冻结计划中的标准修订、场景、参数、类型配置、变更输入及选择理由；后续知识变更不改变该计划，刷新必须显式形成新快照。

#### Scenario: 计划生成后标准更新
- **WHEN** 执行期间标准通过条件被修改
- **THEN** 已有计划与结果仍依据原修订，不自动变成新通过条件

#### Scenario: 生成时并发变化
- **WHEN** 分页选取标准期间其他写入者更新类型或标准
- **THEN** 计划使用一致版本边界，不在页之间混入不一致集合

### Requirement: PLN-007 Agent execution boundary

系统 SHALL 将计划作为智能体执行输入，仅接收其后续结果，不运行场景命令、不操作浏览器或设备、不根据计划给出发布许可。

#### Scenario: 标准包含测试操作说明
- **WHEN** 计划中包含启动测试或打开页面的步骤
- **THEN** 系统原样提供结构化操作要求，由外部智能体执行，不自动启动对应工具
