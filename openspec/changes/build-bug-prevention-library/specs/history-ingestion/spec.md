# Spec Delta

## Purpose

以可追溯且只读的方式发现 Codex 与 Claude Code 本地开发历史，在手动、使用时与后台三种触发条件下共用可靠的增量处理协议，支持大量长对话和中断恢复并透明表达未覆盖范围。

## ADDED Requirements

### Requirement: HIS-001 Versioned local source adapters

系统 SHALL 支持 Codex、Claude Code 本地历史适配器及自定义源路径，声明支持的格式版本和记录类型，不依赖客户端登录令牌，不修改源历史。

#### Scenario: 两类本地来源
- **WHEN** 用户配置受支持版本的 Codex 与 Claude Code 历史目录
- **THEN** 系统按统一事件契约读取并保留来源身份，源文件内容不变

#### Scenario: 保留发现来源角色
- **WHEN** 一段历史包含用户问题报告、用户检查引导、Agent 回复和工具测试输出
- **THEN** 统一事件保留可验证的角色与顺序，使提炼能够区分人工来源和 Agent 自主测试发现

#### Scenario: 未知格式
- **WHEN** 来源包含未知格式或无法解析的记录
- **THEN** 系统报告范围和覆盖缺口，不将跳过内容计为成功分析

### Requirement: HIS-002 Shared manual lazy and background sync

系统 SHALL 同时支持手动同步、使用时增量同步、后台持续同步，并共用任务、幂等键与检查点。

#### Scenario: 三路同时触发
- **WHEN** 三种方式同时发现同一新增片段
- **THEN** 系统允许可恢复调度且最终仅有一份有效知识提交和来源关联

#### Scenario: 后台没有模型
- **WHEN** worker 无可用内置模型且没有外部智能体领取
- **THEN** 系统可完成采集并排队，明确分析 pending，不宣称提炼已完成

### Requirement: HIS-003 Context-preserving segmentation

系统 SHALL 按消息或逻辑事件边界分段，支持有限邻接上下文、可追溯摘要和超大事件拆分，使跨段问题/原因/预防信息可关联；不得仅筛查关键词命中段。

#### Scenario: 原因在下一段
- **WHEN** 故障现象与后续原因或预防讨论分处相邻段
- **THEN** 分析可获得必要受限上下文并补充同一知识，不因边界自动当作独立 Bug

#### Scenario: 超长工具输出
- **WHEN** 单条工具输出超出分段预算
- **THEN** 系统分割并保留父事件和逻辑范围，不无限扩大单次上下文

### Requirement: HIS-004 Independent collection and analysis progress

系统 SHALL 区分已读取、已分段、已分析和已提交进度，每个段显式记录无发现、已提交、待确认或失败等处理结果；只有有效事务提交才推进分析完成点。

#### Scenario: 读完但未分析
- **WHEN** 文件已读取而部分段尚未获得模型结果
- **THEN** 同步状态显示 pending 数量，后续运行继续处理这些段

#### Scenario: 无 Bug 片段
- **WHEN** 分析明确未发现 Bug 或新标准
- **THEN** 系统记录无发现完成结果，不伪造知识，也不每次重复分析同一段

### Requirement: HIS-005 Resume with fenced leases

系统 SHALL 为处理中段提供有时效、可续期的归属标识，支持崩溃后恢复，并拒绝失去归属的旧执行者提交。

#### Scenario: 崩溃恢复
- **WHEN** worker 在分析后、提交前退出且租约过期
- **THEN** 新执行者可领取重做，来源幂等保证重试不重复

#### Scenario: 旧 worker 回来
- **WHEN** 已被重新分配的段收到原 owner 的迟到提交
- **THEN** 系统拒绝该提交，不覆盖新 owner 的结果

### Requirement: HIS-006 Handle mutable source files

系统 SHALL 安全处理追加中的不完整记录、损坏范围、截断、替换和移动，保持稳定来源定位并报告无法确定的连续性。

#### Scenario: 半条记录
- **WHEN** 文件末尾为未写完的 JSON 或 UTF-8 字符
- **THEN** 系统等待后续追加，不把半条数据当完整内容或永久成功跳过

#### Scenario: 截断与替换
- **WHEN** 已处理文件的长度或内容身份表明它被替换
- **THEN** 系统识别新代次并重新定位，保留已提交知识且防止逻辑来源重放

### Requirement: HIS-007 Coverage and freshness transparency

系统 SHALL 暴露源、会话、段和分析版本的覆盖水位、待处理与失败范围；使用时同步超时或被跳过时必须在计划/报告中说明新鲜度限制。

#### Scenario: 预算到期生成计划
- **WHEN** 使用时同步未完成但调用方继续基于已有知识生成计划
- **THEN** 计划记录 pending 范围和水位，不声称已覆盖全部最新历史

### Requirement: HIS-008 Periodic recovery of missed notifications

系统 SHALL 在后台监听外提供周期校对和可控制退出，不因文件监听漏事件而永久遗漏新增历史，且不自动安装系统服务。

#### Scenario: 漏失 watch 事件
- **WHEN** 文件追加未触发监听事件
- **THEN** 后续周期校对发现新增范围并按相同检查点协议处理
