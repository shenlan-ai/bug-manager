# Spec Delta

## Purpose

为个人中心库中的多个代码项目建立稳定身份、可追溯的目录和仓库线索，以及由智能体明确维护的类型配置，使项目搬家、多工作区和跨项目知识共享不改变验收范围的含义。

## ADDED Requirements

### Requirement: PRJ-001 Stable project identity

系统 SHALL 使用独立于目录和仓库 remote 的稳定项目 ID，支持同一项目映射多个目录、checkout 和 worktree，并保留映射依据。

#### Scenario: 移动与 worktree
- **WHEN** 已注册项目增加新路径或 worktree 映射
- **THEN** 系统保留项目 ID、既有来源与类型配置，不建立重复项目

#### Scenario: 相同 remote 不足以确认
- **WHEN** 未知目录与已有项目仅共享 remote 信息但存在归属歧义
- **THEN** 系统返回待确认建议及依据，不自动合并项目身份

### Requirement: PRJ-002 Explicit and uncertain attribution

系统 SHALL 优先使用显式映射归属历史，允许 AI 辅助解释不确定归属，并将无法确定或涉及多个项目的来源保存为待确认，不能丢弃证据或伪造唯一归属。

#### Scenario: 未识别路径
- **WHEN** 源会话指向不存在且未映射的路径
- **THEN** 系统保留必要来源和归属候选，允许后续确认后关联稳定项目

#### Scenario: 已有确定映射
- **WHEN** 历史目录命中明确注册映射
- **THEN** 系统使用该项目，不由模型无理由改归其他项目

### Requirement: PRJ-003 AI-managed project type selection

系统 SHALL 允许外部智能体经 Skill/CLI/MCP 或内置模型选择受控类型，保存完整集合、理由、操作者和配置修订；更新必须是显式操作。

#### Scenario: 两种路径保存
- **WHEN** 外部智能体或内置模型提交合法类型集合与理由
- **THEN** 系统经同一规则校验并产生可追溯配置版本

#### Scenario: 并发修改
- **WHEN** 类型配置更新基于过期 expected_revision
- **THEN** 系统返回冲突而不覆盖较新配置

### Requirement: PRJ-004 Selected types bound acceptance

系统 SHALL 仅从项目已选类型的 ANY 匹配集合生成验收项，多类型命中同一标准只出现一次；空集合不得退化为全库，项目分析和验收不得隐式扩大集合。

#### Scenario: 未选类型的最高级标准
- **WHEN** 某 I0 标准只属于项目未选择的类型
- **THEN** 该标准不进入本项目计划

#### Scenario: 尚未配置
- **WHEN** 无已选类型的项目请求生成计划
- **THEN** 系统返回需要配置类型的明确结果，不扫描全库作为替代

### Requirement: PRJ-005 Configuration snapshots

系统 SHALL 记录生成计划时的项目与类型配置快照；后续配置改变不改变既有计划和报告。

#### Scenario: 执行途中改类型
- **WHEN** 项目类型配置在计划生成后更新
- **THEN** 旧计划仍显示原配置修订与集合，新计划使用新配置
