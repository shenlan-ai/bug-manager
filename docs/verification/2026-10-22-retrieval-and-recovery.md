# 检索规模、并发与恢复验证

环境：2026-10-22，Windows 10.0.26200 x64、Node v24.21.0、Intel i7-14700、28 逻辑核、约 31.6 GiB 主机内存。PostgreSQL 16 为本机 Docker 专用测试库。所有数据合成，无真实会话或模型调用。

## 10 万 Bug＋10 万标准

运行 `npm run build`，随后分别执行：

```text
npm run benchmark:retrieval -- sqlite 100000
npm run benchmark:retrieval -- postgres 100000
```

PostgreSQL 仅使用 BUG_MANAGER_TEST_DATABASE_URL，创建随机 bm_benchmark schema，结束后删除该 schema；SQLite 使用专用临时目录并清理。没有更改业务数据库。

夹具为 100 个受控类型，每项两个类型，选两个类型做 ANY 过滤。每类知识 100000 条过滤为 4000 个不同候选；每页 200，遍历全部命中，五次重复。无强制预热或操作系统缓存重置，首次可能有冷缓存；同主机其他开发测试可能影响时延。原始记录中的 warm repetitions 措辞已改为无预热的五次重复，数值与时间未变。

| 后端 / 查询 | Bug 命中数 / 全部分页平均耗时 | 标准命中数 / 全部分页平均耗时 |
| --- | --- | --- |
| SQLite / 类型集合 | 4000 / 356.7 ms | 4000 / 459.5 ms |
| SQLite / 并发 重试 | 1000 / 330.4 ms | 1000 / 419.2 ms |
| SQLite / retry concurrency | 1000 / 232.8 ms | 1000 / 220.0 ms |
| SQLite / 缓存 cache | 3000 / 1542.8 ms | 3000 / 1611.9 ms |
| PostgreSQL / 类型集合 | 4000 / 259.4 ms | 4000 / 252.7 ms |
| PostgreSQL / 并发 重试 | 1000 / 258.9 ms | 1000 / 290.8 ms |
| PostgreSQL / retry concurrency | 1000 / 228.5 ms | 1000 / 316.3 ms |
| PostgreSQL / 缓存 cache | 3000 / 370.3 ms | 3000 / 366.9 ms |

SQLite 合成播种 514.4 秒、进程峰值 RSS 304.2 MiB；PostgreSQL 播种 120.2 秒、Node 客户端峰值 RSS 213.2 MiB。内存为采样与进程资源用量报告的最大值，不含 PostgreSQL/Docker 服务端。原始五次耗时和环境在 retrieval-sqlite-2026-10-22.json、retrieval-postgres-2026-10-22.json。数值是这组分布下完整分页查询的观测，不是单请求延迟、语义去重质量、历史提炼吞吐或任意容量保证。

## 可选向量与有界候选

`tests/integration/vectors.test.ts` 在两个真实后端验证：类型先过滤、多页无重复/遗漏、模型/维度/表示版本隔离、旧知识修订不参与当前比较、零向量/错误维度拒绝、关闭时全文仍可用。向量由外部工具明确提交；测试使用确定性向量，不代表真实 embedding 质量。

`tests/integration/history.test.ts` 的 DED-004 检查有界摘要、截断标记、后续游标和保守候选分流；`concurrency.test.ts` 的 DED-006 用两个独立 Node 进程从旧召回同时提交相同机制，最终一个 active、一个 candidate。数据库事务重查不是单进程缓存。

新游标测试暴露 analysis_context 在保存召回收据后立刻作废自己的游标。已让该内部元数据写入继续取得 DB 写锁和幂等记录，但不推进知识查询修订；真实知识变更仍使旧游标失效。定向复验通过。

## 故障与隔离

- `failures.test.ts`：实际 PostgreSQL pg_terminate_backend(pg_backend_pid())，只终止该夹具当前事务连接；半写入及幂等记录均回滚，连接池重连后同请求键可成功。收到连接错误不记录原始驱动信息。
- 同文件并发初始化三个独立 schema，迁移表与列元数据只查当前 schema，互不误判。此前默认 Kysely 全库 introspection 会在并发 DDL 时看到别库同名表并失败；改为作用域受限 introspection 并明确 migrationTableSchema。
- PostgreSQL acquired/idle client error 都有处理，活动查询仍拒绝，不让断连事件变成未捕获进程异常。首次强制断连测试发现该问题后已修复。
- `reports.test.ts` 在两后端注入 ENOSPC 到证据对象写入；无结果/证据行提交，解除注入后原请求可重试。此为磁盘不足错误注入，没有实际填满用户磁盘。
- 模型 401/429/超时/非法 JSON 与预算暂停在 model.test.ts，真实 worker kill/restart 在 worker.test.ts，来源丢失/损坏在 history.test.ts；附件缺失在 reports.test.ts。正常、故障和恢复都保留未完成覆盖。

定向命令 `npx vitest run tests/integration/failures.test.ts tests/integration/history.test.ts -t 'DB-002|DB-003|DB-006|DED-004'`：5 项选中测试通过、32 项因名称过滤未运行，无未捕获错误。最终全量结果另见交付验证记录，不能将定向跳过计为通过。
