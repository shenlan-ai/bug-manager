# Spec Delta

## Purpose

在大规模、多类型和跨项目知识中分别识别 Bug 与标准的重复，结合来源幂等、确定性候选、全文和可选语义检索控制成本，并通过有依据的补充、关联或合并保留场景差异与历史证据。

## ADDED Requirements

### Requirement: DED-001 Separate replay identity from semantic duplication

系统 SHALL 先识别同一来源或相同逻辑提交的重放，再分别对 Bug 和标准进行语义去重，不将来源幂等与跨场景语义相似视为同一规则。

#### Scenario: 同来源重复同步
- **WHEN** 同一片段经手动同步和后台再次提交
- **THEN** 有效来源、知识及关联只保存一份，返回已有结果

#### Scenario: 不同来源相似内容
- **WHEN** 两个项目描述同类故障
- **THEN** 系统比较机制与场景兼容性并保留两个来源，不仅凭内容哈希删除一个来源

### Requirement: DED-002 Type-filtered staged candidate retrieval

系统 SHALL 归一化候选的全部类型后，以其 ANY 集合限定 Bug 和标准候选，依次使用指纹、全文及可选向量召回；所有候选响应必须有界，不能加载全库。

#### Scenario: 多类型召回
- **WHEN** 新片段分类为并发与数据一致性
- **THEN** 两类候选以并集合并、去重和分页，未命中类型的知识不被返回

#### Scenario: 向量关闭
- **WHEN** 用户未配置嵌入模型或关闭向量功能
- **THEN** 来源、指纹、全文与智能体/模型判断仍可完成去重维护

### Requirement: DED-003 Independent maintenance outcomes

系统 SHALL 分别为 Bug 和标准产生新增、补充、复用、关联或合并提案；同一段允许新增一类并复用另一类，不要求一 Bug 对应一新标准。

#### Scenario: 新故障复用通用标准
- **WHEN** Bug 候选为新问题而标准候选已覆盖其机制
- **THEN** 仅新增 Bug，并连接既有标准及覆盖理由

#### Scenario: 旧 Bug 补充新场景
- **WHEN** 新来源为既有 Bug 提供另一种触发边界
- **THEN** 系统可补充上下文或标准场景，不重复创建整条 Bug

### Requirement: DED-004 Visible retrieval coverage

系统 SHALL 标明候选分页、截断和分类不确定带来的检索覆盖范围；不能将有限第一页未命中表述为全库没有重复。

#### Scenario: 候选超过预算
- **WHEN** 类型过滤后的候选数量超出单次分析预算
- **THEN** 系统提供游标/后续摘要与覆盖说明，必要时将最终唯一性判断留待确认

### Requirement: DED-005 Conservative traceable merges

系统 SHALL 在机制、前置条件和预期兼容时合并知识，保留类型并集、来源、项目场景、关联及旧 ID 重定向；冲突或证据不足进入待确认，不静默覆盖评级与行为差异。

#### Scenario: 安全合并
- **WHEN** 两条标准为不同表述但其机制与可观察预期一致
- **THEN** 合并后所有 Bug 关联和证据仍可访问，旧 ID 解析到新条目且旧修订可读

#### Scenario: 预期相反或评级冲突
- **WHEN** 相似名称标准要求相反业务效果，或合并将无依据降低重要性
- **THEN** 系统不自动合并，保存冲突提案和依据

### Requirement: DED-006 Concurrent maintenance safety

系统 SHALL 在并发写入时保证确定性来源防重和修订冲突检测，并在新增确认前重新核查相同类型的候选，不能仅依赖某进程内缓存。

#### Scenario: 两个执行者同时新增
- **WHEN** 两个进程基于旧候选集合提出相同机制新知识
- **THEN** 后提交者会重新核查已提交候选或进入待确认，而非跳过去重直接覆盖

### Requirement: DED-007 Multilingual and embedding compatibility

系统 SHALL 在两个数据库后端支持中文、英文和混合文本的类型受限候选检索；可选向量必须记录模型与维度，不混合不兼容表示。

#### Scenario: 中文不同措辞
- **WHEN** 中文片段与既有标准使用不同措辞但包含可召回的共同机制词
- **THEN** 两种后端均能在受控类型候选中检索该标准，不要求向量服务才支持中文

#### Scenario: 更换嵌入模型
- **WHEN** 新模型向量与旧模型维度或语义空间不同
- **THEN** 系统隔离或重建表示，不直接比较两种向量，也不丢失原知识
