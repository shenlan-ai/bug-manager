# Spec Delta

## Purpose

以命令行、MCP 和可安装 Skill 为编程智能体提供一致、有界且可恢复的知识维护与验收协作接口，使同一领域约束在不同客户端和调用方式下保持一致，并避免安装或协议污染用户环境。

## ADDED Requirements

### Requirement: API-001 Shared CLI and MCP semantics

系统 SHALL 为项目、类型、同步、分析、知识、计划、结果与报告提供 CLI 与 MCP 等价能力，共享验证、版本冲突、幂等和类型范围规则。

#### Scenario: 跨接口写读
- **WHEN** CLI 合法写入知识后 MCP 按同 ID/类型读取
- **THEN** 返回一致修订、类型和来源，不能出现另一套独立数据

#### Scenario: 非法写入跨接口一致
- **WHEN** 两种接口提交同一不满足领域约束的操作
- **THEN** 都返回同类错误，不允许某接口绕过规则

### Requirement: API-002 Machine-readable contracts

系统 SHALL 提供版本化 JSON、请求 ID、稳定错误码、可重试性、分页和可追溯写入 actor；CLI 同时提供人可读输出，不将日志混入机器响应。

#### Scenario: JSON 模式
- **WHEN** CLI 使用 JSON 输出并发生可恢复冲突
- **THEN** 响应仍为合法版本化 JSON，包含冲突及后续所需信息，密钥不被回显

### Requirement: API-003 Local stdio MCP

系统 SHALL 提供可由客户端启动的本地 stdio MCP 服务，完成协议握手、工具 schema 和生命周期管理；stdout 只用于协议，日志写 stderr。

#### Scenario: 真实客户端连接
- **WHEN** MCP 客户端启动服务并列出工具
- **THEN** 握手成功且工具 schema 可读取，无启动文案或调试日志污染协议流

### Requirement: API-004 Bounded long-running jobs

系统 SHALL 用任务 ID、状态、租约及有限上下文处理长历史分析，不要求一次 CLI/MCP 请求携带全部历史或知识；支持中断与恢复。

#### Scenario: 大批历史启动
- **WHEN** 调用方触发超过单请求预算的历史同步
- **THEN** 系统返回任务身份和进度查询方式，后续分页取上下文，不阻塞到全库完成

### Requirement: API-005 Canonical product Skill

系统 SHALL 提供一个可安装的产品 Skill，指导项目识别、类型选择、增量提炼、分层去重、计划、智能体执行、结果回写与报告；支持 MCP 优先或等价 CLI，不能直接绕过领域服务写库。Skill MUST 指导调用方只为人工报告或人工明确引导检查发现的 Bug 提交候选，并忽略 Agent 自写测试或自主审计发现的新问题。

#### Scenario: 未配内置模型
- **WHEN** Codex 或 Claude Code 按 Skill 维护知识
- **THEN** 可使用外部分析协议完成流程，不要求把其内部凭据交给本项目

#### Scenario: Agent 自主测试出现失败
- **WHEN** 产品 Skill 运行中的智能体自行新增测试并得到失败，而用户未报告该问题且未明确要求该范围检查
- **THEN** Skill 指示调用方提交 `no_findings` 或排除该 Bug，不能通过 `analysis_submit` 作为人工来源写入

#### Scenario: 验收执行
- **WHEN** Skill 获取计划后进入验收
- **THEN** 智能体用自身工具执行并提交关键证据，最后导出报告供人审，不要求自动发布判定

### Requirement: API-006 Explicit non-destructive installation

系统 SHALL 按明确客户端和用户/项目作用域安装产品 Skill，检测冲突并可重复运行；不覆盖无关配置、登录令牌或其他 Skill，不自动安装系统服务。

#### Scenario: 已有同名或无关文件
- **WHEN** 安装位置存在内容不同的同名 Skill 或其他文件
- **THEN** 系统报告冲突或按明确更新方式处理，不静默破坏已有内容，无关文件保持不变

### Requirement: API-007 Operational exit codes are not release gates

系统 SHALL 以退出码表达请求成功、输入错误或运行故障，不把报告中的 failed/blocked/not_run 等验收事实当作发布拒绝。

#### Scenario: 成功导出失败报告
- **WHEN** CLI 成功生成含 failed 结果的报告
- **THEN** 导出命令表示操作成功，报告中保留失败事实，无发布门禁含义
