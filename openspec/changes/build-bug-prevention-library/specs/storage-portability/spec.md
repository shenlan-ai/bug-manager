# Spec Delta

## Purpose

为个人本地知识中心提供默认无需独立服务的 SQLite 与可配置 PostgreSQL，保证同一数据模型、迁移版本和查询边界，在多进程同步、版本更新、备份及跨后端迁移时保持知识和证据完整。

## ADDED Requirements

### Requirement: DB-001 Two supported database backends

系统 SHALL 默认使用 SQLite，并允许配置 PostgreSQL；两者提供相同逻辑模型、受控类型筛选、版本写入与事务语义，不把某一后端测试替代另一后端。

#### Scenario: 默认初始化
- **WHEN** 用户未配置外部数据库而初始化
- **THEN** 系统建立本地 SQLite 存储，不要求安装数据库服务器

#### Scenario: PostgreSQL 配置
- **WHEN** 用户配置有效 PostgreSQL 连接
- **THEN** 同一领域操作和类型查询契约可用，诊断和日志不展示连接密码

### Requirement: DB-002 Explicit versioned migrations

系统 SHALL 提供显式、可检查的双后端迁移与版本预检，不通过静默 schema 同步或降级继续运行；失败须保留可恢复状态。

#### Scenario: 数据库版本不兼容
- **WHEN** 客户端遇到比自身支持范围更新的数据库版本
- **THEN** 系统拒绝破坏性操作并给出升级指引，不自动重建或清空

#### Scenario: 迁移失败
- **WHEN** 某迁移步骤中断或失败
- **THEN** 系统回滚受事务保护的变更或明确报告恢复步骤，不把迁移标成成功

### Requirement: DB-003 Cross-process consistency

系统 SHALL 对来源幂等、分段提交、修订更新和任务租约提供跨进程一致性，数据库约束与事务不能由内存锁替代。

#### Scenario: 多进程写同来源
- **WHEN** 两个独立进程同时提交同一片段的确认结果
- **THEN** 至多一份有效提交和完成点，其他返回幂等结果或冲突，不产生重复关系

#### Scenario: 中途失败
- **WHEN** 事务在知识写入后、来源/完成点写入前失败
- **THEN** 数据库不留下被错误标为已完成的部分结果

### Requirement: DB-004 Consistent backup and portable export

系统 SHALL 支持一致性备份和版本化逻辑导出/导入，跨后端保留稳定 ID、修订、类型、来源、关系、计划/结果与关键证据 manifest；不自动删除原数据。

#### Scenario: SQLite 迁移 PostgreSQL
- **WHEN** 导出数据并导入兼容版本 PostgreSQL
- **THEN** 标识、版本与关联可对照，证据 hash 可核验，原 SQLite 仍可用

#### Scenario: 活动数据库备份
- **WHEN** 同步运行时发起备份
- **THEN** 备份代表一致时间点，不裸拷贝活动数据库形成不完整文件

### Requirement: DB-005 Local data and evidence boundaries

系统 SHALL 默认将数据库、日志和受管证据放在可配置的应用数据目录，而非目标代码仓库；公开分发不得包含真实历史、Key、私人数据库与证据。

#### Scenario: 目标项目启用
- **WHEN** 智能体在项目中注册并使用中心库
- **THEN** 运行数据仍保存在中心数据目录，项目代码中不新增私密数据库

#### Scenario: 打包检查
- **WHEN** 生成分发包
- **THEN** 包中只有程序、规范允许的文档/Skill 和脱敏合成资源，不包含用户运行数据

### Requirement: DB-006 Observable resource and connection failures

系统 SHALL 对数据库不可达、锁等待、磁盘空间和证据写入失败提供明确错误与可恢复进度，不伪造成功；性能声明必须包含实际数据规模与环境。

#### Scenario: 磁盘不足或连接中断
- **WHEN** 提交知识或证据时遇到资源故障
- **THEN** 系统保留可重试状态，事务不完成，错误不泄露凭据

#### Scenario: 大规模基准
- **WHEN** 项目报告检索性能
- **THEN** 同时给出总记录、类型过滤后的候选量、后端、测试环境、耗时和内存，不把未经测试的容量写为已验证支持
