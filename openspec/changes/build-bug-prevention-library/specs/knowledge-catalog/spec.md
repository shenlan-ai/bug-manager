# Spec Delta

## Purpose

将历史故障转化为跨项目可复用的预防知识，分别维护 Bug 事实与可执行验收标准，通过多对多覆盖关系和来源证据解释如何避免同类问题，并保留版本而不引入修复工单生命周期。

## ADDED Requirements

### Requirement: CAT-001 Separate bugs and standards

系统 SHALL 分别存储、检索、评级和版本化 Bug 与验收标准，通过多对多关系表示预防覆盖，并在关系上说明覆盖理由和场景映射。

#### Scenario: 多 Bug 共用标准
- **WHEN** 两条不同 Bug 都能由既有幂等标准检出
- **THEN** 系统保存两个 Bug 与一个标准的两条关联，不复制标准

#### Scenario: 单 Bug 需要多项检查
- **WHEN** 一个 Bug 需权限与并发两条标准共同覆盖
- **THEN** 系统保留两条关系及各自覆盖范围，不强行合成一条标准

### Requirement: CAT-002 Preventive bug descriptions without repair state

系统 SHALL 记录 Bug 的表现、触发条件、影响、机制或原因未知标记、发现来源、角色证据及预防标准；发现来源只允许人工报告或人工明确引导检查，不得把 Agent 自写测试或自主发现伪装为 Bug，也不得维护 open/fixed/closed 等修复状态。

#### Scenario: 历史声称已修复
- **WHEN** 对话描述 Bug 后说已修复
- **THEN** 系统提炼问题和预防标准，不据此创建修复状态或抹除知识

#### Scenario: 根因未证实
- **WHEN** 有明确故障现象而根因只是猜测
- **THEN** 系统区分已知现象和待确认原因，不把猜测写成已证实机制

#### Scenario: 人工与自主发现混合
- **WHEN** 同一历史段同时包含人工问题引导、Agent 发现的故障和 Agent 另行自写测试得到的新失败
- **THEN** 系统只为人工报告或人工引导范围内的故障写入 Bug，保留来源角色以解释包含与排除范围

### Requirement: CAT-003 Shared knowledge and project contexts

系统 SHALL 允许 Bug 与标准跨项目复用，保留每个项目的触发场景、来源和差异，不以共享条目覆盖所有项目的具体事实。

#### Scenario: 同类机制跨项目发生
- **WHEN** 新项目出现与已有 Bug 相同机制、兼容表现的故障
- **THEN** 系统可关联既有 Bug 并增加该项目场景和证据，保留原场景

### Requirement: CAT-004 Executable mechanism-based standards

系统 SHALL 以故障机制与可执行场景描述标准，每个场景包含前置条件、参数约束、步骤、可观察通过条件和证据要求，允许项目变体。

#### Scenario: 跨项目参数化
- **WHEN** 相同机制在支付和权益模块中有不同业务对象
- **THEN** 标准通过参数/场景变体表达差异，且各自保留可执行步骤与预期

#### Scenario: 不可执行口号
- **WHEN** 提案只包含“检查稳定性”而无可执行场景
- **THEN** 系统不允许其成为有效标准，返回缺失字段或待完善原因

### Requirement: CAT-005 Independent justified ratings

系统 SHALL 使用 S0–S3 表示 Bug 严重程度、I0–I3 表示标准重要性，分别保存理由；不得仅按关联 Bug 的最高等级自动推导标准等级。

#### Scenario: 严重 Bug 关联一般标准
- **WHEN** S0 Bug 新关联到 I2 标准
- **THEN** 系统保留两者等级和理由，可提出重新评估建议但不自动改成 I0

### Requirement: CAT-006 Revisioned knowledge and coverage

系统 SHALL 保存 Bug、标准及覆盖关联的修订、原因、actor 和必要来源，使用期望修订防止丢失更新；合并后的旧 ID 与旧修订必须可追溯。

#### Scenario: 并发编辑
- **WHEN** 两个调用方基于同一旧修订更新标准
- **THEN** 仅首个有效更新成功，后一个收到冲突并可读取新修订

#### Scenario: 历史计划引用
- **WHEN** 标准当前内容被更新或与另一标准合并
- **THEN** 既有计划仍能读取当时的标准修订与关联来源

### Requirement: CAT-007 Atomic and evidence-backed maintenance

系统 SHALL 在一次分段提交中原子保存已确认的 Bug/标准新增或补充、关联、来源及完成点；允许复用任一已有实体。缺可执行覆盖或证据不足的 Bug 保留待确认，不伪造标准。

#### Scenario: 复用旧标准
- **WHEN** 提案新增 Bug 并关联已有标准
- **THEN** 系统只新增必要条目和关系，分别维护两个实体而不重复写标准

#### Scenario: 提交中断
- **WHEN** 标准写入成功前关系写入失败
- **THEN** 整次确认提交回滚，分段仍待处理，不出现半套来源或错误完成点
