# Spec Delta

## Purpose

将编程智能体执行验收的观察、环境、逐项结论与关键证据组织为可追溯的 Markdown 和 JSON 报告，为人工审核提供完整依据，明确区分结构合法、执行者声明与人对证据真实性和充分性的判断。

## ADDED Requirements

### Requirement: RPT-001 Structured executor submissions

系统 SHALL 接收绑定 plan/item/standard revision 的执行环境、步骤、预期与实际、actor、attempt 和关键证据，允许 passed、failed、blocked、not_run、not_applicable 状态，后者必须有理由。

#### Scenario: 正常提交
- **WHEN** 智能体为冻结计划项提交完整观察与合法状态
- **THEN** 系统保存与该版本对应的执行记录，不把历史提炼来源替代本次执行证据

#### Scenario: 不适用声明
- **WHEN** 智能体提交 not_applicable
- **THEN** 系统要求理由并原样标明其为执行者声明，不自动判断该理由正确

### Requirement: RPT-002 Structural validation without semantic review

系统 SHALL 仅校验格式、归属、冻结版本、必填字段、证据引用和附件边界，不用模型或复验判断材料是否证明结论；passed 缺 required evidence 引用时返回明确字段错误。

#### Scenario: 缺必需引用
- **WHEN** passed 提交遗漏冻结场景要求的证据引用
- **THEN** 系统返回 missing_evidence，不替执行者补造材料或默认为通过

#### Scenario: 材料存在但结论可疑
- **WHEN** 结构完整的提交包含可能不支持结论的截图/日志
- **THEN** 系统保留执行者声明和材料供人审，不发起自动语义审核或独立复验

### Requirement: RPT-003 Append-only execution attempts

系统 SHALL 幂等接收重试并保留不同执行尝试，报告须绑定明确结果集合；无效提交不能覆盖旧有效结果，也不能静默混合不匹配环境或项目版本。

#### Scenario: 重试同一次提交
- **WHEN** 调用方以同一幂等键重复提交相同结果
- **THEN** 返回同一有效记录，不重复增加通过/失败数量

#### Scenario: 再次验收
- **WHEN** 智能体以新 attempt 对同一计划项重新执行
- **THEN** 旧尝试仍可查，报告显示所采用尝试及其环境

### Requirement: RPT-004 Key evidence management

系统 SHALL 关联日志、截图或测试报告等关键证据的用途、内容标识与可用性，支持受管归档和显式外部引用，不自动下载任意 URL 或读取未授权路径。

#### Scenario: 关键附件归档
- **WHEN** 智能体提交合法本地关键附件
- **THEN** 系统将必要附件放入受管目录并保存 hash 与关联步骤，报告可定位该材料

#### Scenario: 引用不可用或越界
- **WHEN** 附件丢失、路径越界或外部引用不可获取
- **THEN** 系统拒绝越界读取或显式标注不可用，不伪造已归档证据

### Requirement: RPT-005 Consistent Markdown and JSON reports

系统 SHALL 从相同冻结数据生成 Markdown 与版本化 JSON，包含类型、重要性、标准版本、环境、步骤、预期/实际、结果、证据、选择理由和同步新鲜度；不输出 HTML 报告或 Web 页面。

#### Scenario: 双格式导出
- **WHEN** 对同一计划及结果快照导出两种格式
- **THEN** 项目、执行数量、状态与证据对应一致，JSON 可供工具消费，Markdown 可供人阅读

#### Scenario: 未完成验收
- **WHEN** 部分计划项没有任何执行记录
- **THEN** 报告将它们列为 not_run，并保留其重要性与未验范围，不只展示成功项

### Requirement: RPT-006 Deterministic summaries only

系统 SHALL 仅按提交状态汇总标准和场景，不推断证据充分性；场景任一失败汇总为 failed，否则按 blocked、not_run、passed 的明确规则汇总，not_applicable 明示并保留理由。

#### Scenario: 部分场景失败
- **WHEN** 同一标准一个场景 passed 而另一个 failed
- **THEN** 标准汇总 failed，报告同时保留每个场景实际结果

#### Scenario: 全部不适用
- **WHEN** 全部场景以合法理由声明 not_applicable
- **THEN** 标准汇总为 not_applicable，不计为通过

### Requirement: RPT-007 Human review without release decision

系统 MUST 将验收结果留给人工审核，不自动审证、不输出能否发布、发布阻断、豁免结论或 release_allowed 字段。

#### Scenario: 必验失败仍只出报告
- **WHEN** I0 项失败或未执行
- **THEN** 报告显著呈现事实，但不发出发布批准/拒绝，也不因为该结果产生发布门禁退出码

#### Scenario: 请求自动判断材料可信度
- **WHEN** 调用方请求系统为结果自动打审核分数或做复验
- **THEN** 接口明确不提供此能力，已有材料仍可导出给人审核
