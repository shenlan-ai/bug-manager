# 首批实现验证

环境：Windows，Node.js 24.21.0，SQLite（better-sqlite3），独立 Docker PostgreSQL 16。全部数据为合成夹具，无内置模型 Key、无真实历史。

执行 `npm ci`、`npm run build`、`npm run typecheck`、`npm run lint`，成功。设置测试专用 `BUG_MANAGER_TEST_DATABASE_URL` 后执行 `npm run test:all`：6 个文件、52 项测试通过，0 失败、0 跳过。CLI/MCP 测试使用构建产物和真实 stdio 客户端。

| 需求/任务 | 证据 |
| --- | --- |
| DB-001/002，2.1 | tests/contracts/catalog.test.ts：两种真实后端初始化、故障迁移回滚、未知新版本拒绝 |
| DB-003、HIS-005，2.2 | tests/integration/concurrency.test.ts：独立 Node 子进程并发重放、争抢、租约失效及迟到提交拒绝；catalog.test.ts 验证乐观锁 |
| 2.3 | tests/unit/security.test.ts：附件归档/哈希/脱敏、路径穿越、目录 junction/符号链接越界、大小限制；不可用附件显式失败，导出标记 unavailable |
| DB-004，2.4 | tests/integration/archive.test.ts：SQLite 原生一致性备份，SQLite↔PostgreSQL 双向逻辑恢复、类型父子关系、稳定 ID、两版标准、关系、项目上下文与证据哈希；损坏导入回滚 |
| PRJ-001/002，3.1 | catalog.test.ts：路径搬移、多目录、子目录识别及同 remote 的 fork 不合并 |
| TAX-001/002，3.2 | catalog.test.ts：候选类型、确认、改名旧别名、稳定 ID；tags 独立持久化并不替代 type_ids |
| CAT-001/002/003，4.1 | catalog.test.ts：多 Bug 共用标准、独立来源场景、修复状态字段缺失；关系表允许反向多关联 |
| CAT-004/005，4.2 | catalog.test.ts：执行步骤缺失拒绝，S0 不强制提升 I2，完整标准 schema 和独立评级理由 |
| ANA-003、CAT-007，4.3 | catalog.test.ts：推测/无覆盖留候选、补证确认、拒绝保留历史、不确定更新不覆盖有效知识、事务失败回滚 |
| API-001/003（部分） | tests/e2e/transports.test.ts：CLI init → MCP 写入 → CLI 读取同库，真实 MCP SDK 握手 |

当前未验证 macOS/Linux 实机、外部模型服务、真实 Codex/Claude Code 格式兼容性。CI 已配置但尚无远端执行证据。历史采集、分析运行时、语义去重、验收计划/报告及产品 Skill 尚在实现；完整目标未完成。

后续新增测试会改变数量，以最近实际运行输出为准。该记录只证明本批列明行为，不代表整个项目交付。
