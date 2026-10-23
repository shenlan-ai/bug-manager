# Spec Delta

## Purpose

为大量 Bug 与验收标准提供稳定、可解释的多类型组织和有界查询语义，兼顾受控分类、同义名称和可扩展标签，防止分类漂移、重复分页与无范围模型上下文造成维护失控。

## ADDED Requirements

### Requirement: TAX-001 Controlled types and independent tags

系统 SHALL 为类型提供稳定 ID、定义和可管理别名，允许新增类型提案；标签单独管理，不得作为项目受控类型的隐式替代。

#### Scenario: 改名与同义词
- **WHEN** 类型改名或添加同义别名
- **THEN** 原类型 ID 和全部知识/项目关联保持稳定，别名解析到同一类型

#### Scenario: 新类型未确认
- **WHEN** 分析提出未知类型
- **THEN** 系统保存候选与理由，确认前不让其成为有效项目类型配置

### Requirement: TAX-002 Multiple types per entity

系统 SHALL 允许每条 Bug 和每条验收标准同时关联多个受控类型，有效知识至少关联一个类型，并保留分类变更原因。

#### Scenario: 多机制条目
- **WHEN** 一条标准属于权限、缓存和一致性三类
- **THEN** 任一对应类型可召回该标准，返回的类型集合不丢失其他归属

#### Scenario: 空类型写入
- **WHEN** 调用方尝试使无类型知识生效
- **THEN** 系统拒绝生效并说明需要分类，允许保留为待确认提案

### Requirement: TAX-003 Explicit filter semantics

系统 SHALL 支持 ANY 和 ALL 类型过滤，对同一实体去重；类型层级仅用于组织，默认不隐式包含父类、子类或相近类型。

#### Scenario: ANY 与 ALL
- **WHEN** 查询两个类型，某条标准仅关联其中一个
- **THEN** ANY 可返回该标准，ALL 不返回；关联两个类型的标准在两种查询中都仅出现一次

#### Scenario: 不隐式展开
- **WHEN** 项目只选择父类型且未选择某子类型
- **THEN** 仅属于子类型的标准不因层级关系自动入选

### Requirement: TAX-004 Type-first bounded knowledge queries

系统 SHALL 在知识列表、候选全文/语义检索和录入去重前限定类型，再排序和分页；缺类型范围返回明确错误。已明确 entity_id、plan_id 的读取和元数据列表不要求重复提供类型，但仍须有界。

#### Scenario: 无范围搜索
- **WHEN** 客户端请求列出或搜索 Bug/标准但没有类型范围
- **THEN** 系统返回 type_scope_required，不向模型返回全库

#### Scenario: 重复命中分页
- **WHEN** 多类型查询中一个实体匹配多个类型，结果跨页
- **THEN** 同一快照内每个实体只出现一次，游标不因连接表重复而遗漏其他实体

### Requirement: TAX-005 Classification governance

系统 SHALL 记录类型创建、别名归并和知识重新分类的 actor、原因与修订；类型词典更新不能默默改变项目已选 ID 集合。

#### Scenario: 调整分类
- **WHEN** 智能体为既有标准补充第二个类型
- **THEN** 系统记录修订，并保持此前计划所用标准分类快照
