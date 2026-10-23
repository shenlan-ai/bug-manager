# 规范场景与验证对照

日期：2026-10-22。共 66 条 requirement、115 个 scenario。每行列出原规范场景、可重跑检查文件、实际结果和脱敏证据中的 check_id；同一检查可覆盖多个相关场景。这是人工可核对的关联索引，不从检查数量计算覆盖率，也不把实现的辅助逻辑当成外部兼容性证明。

本表的自动结果来自 [Windows 双数据库全量断言记录](tests-windows-2026-10-22.json)。T 编号可在该文件中找到完整测试名、后端、状态及耗时。重跑命令为 npm run build 后 npm run test:all，PostgreSQL 需配置合成专用 BUG_MANAGER_TEST_DATABASE_URL。命令退出状态与原生/未捕获错误另见 [交付验证](2026-10-22-delivery.md)；JSON reporter success 不能独自证明整个进程成功。

真实客户端/模型范围见 [真实兼容性](2026-10-22-real-compatibility.md)；检索容量与原始计数见 [检索及恢复](2026-10-22-retrieval-and-recovery.md)。macOS、远程 CI 和 Claude 真实客户端尚无通过记录；Windows、Debian Linux 与 Alpine Linux 的具体 Node 版本、运行结果以交付验证为准。

| Requirement | Scenario | Check | Result | Evidence / 限制 |
| --- | --- | --- | --- | --- |
| acceptance-planning / PLN-001 | 未提交变更；非 Git 或缺少 ref | [integration/changes.test.ts](../../tests/integration/changes.test.ts) | 6 关联检查通过 | T053, T054, T055, T056, T057, T058。 |
| acceptance-planning / PLN-002 | 一个标准命中多个类型；新类型标准不在配置 | [integration/plans.test.ts](../../tests/integration/plans.test.ts) | 8 关联检查通过 | T120, T121, T123, T124, T126, T127, T129, T130。 |
| acceptance-planning / PLN-003 | 无相关变更但 I0；I0 环境缺失 | [integration/plans.test.ts](../../tests/integration/plans.test.ts) | 2 关联检查通过 | T120, T126。 |
| acceptance-planning / PLN-004 | 相关与不相关标准；缺少分析能力 | [integration/model.test.ts](../../tests/integration/model.test.ts)、[integration/plans.test.ts](../../tests/integration/plans.test.ts) | 4 关联检查通过 | T114, T117, T122, T128。 |
| acceptance-planning / PLN-005 | 全量验收 | [integration/plans.test.ts](../../tests/integration/plans.test.ts) | 2 关联检查通过 | T121, T127。 |
| acceptance-planning / PLN-006 | 计划生成后标准更新；生成时并发变化 | [integration/plans.test.ts](../../tests/integration/plans.test.ts) | 6 关联检查通过 | T121, T123, T125, T127, T129, T131。 |
| acceptance-planning / PLN-007 | 标准包含测试操作说明 | [e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts) | 4 关联检查通过 | T046, T047, T137, T144。 |
| acceptance-reporting / RPT-001 | 正常提交；不适用声明 | [integration/reports.test.ts](../../tests/integration/reports.test.ts) | 4 关联检查通过 | T132, T134, T139, T141。 |
| acceptance-reporting / RPT-002 | 缺必需引用；材料存在但结论可疑 | [integration/reports.test.ts](../../tests/integration/reports.test.ts) | 4 关联检查通过 | T132, T137, T139, T144。 |
| acceptance-reporting / RPT-003 | 重试同一次提交；再次验收 | [integration/reports.test.ts](../../tests/integration/reports.test.ts) | 4 关联检查通过 | T133, T136, T140, T143。 |
| acceptance-reporting / RPT-004 | 关键附件归档；引用不可用或越界 | [integration/reports.test.ts](../../tests/integration/reports.test.ts) | 4 关联检查通过 | T137, T138, T144, T145。 |
| acceptance-reporting / RPT-005 | 双格式导出；未完成验收 | [e2e/transports.test.ts](../../tests/e2e/transports.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts) | 6 关联检查通过 | T043, T044, T136, T137, T143, T144。 |
| acceptance-reporting / RPT-006 | 部分场景失败；全部不适用 | [integration/reports.test.ts](../../tests/integration/reports.test.ts) | 2 关联检查通过 | T134, T141。 |
| acceptance-reporting / RPT-007 | 必验失败仍只出报告；请求自动判断材料可信度 | [e2e/transports.test.ts](../../tests/e2e/transports.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts) | 4 关联检查通过 | T043, T044, T137, T144。 |
| agent-interfaces / API-001 | 跨接口写读；非法写入跨接口一致 | [e2e/transports.test.ts](../../tests/e2e/transports.test.ts) | 3 关联检查通过 | T043, T044, T045。 |
| agent-interfaces / API-002 | JSON 模式 | [e2e/doctor.test.ts](../../tests/e2e/doctor.test.ts)、[e2e/transports.test.ts](../../tests/e2e/transports.test.ts)、[integration/application.test.ts](../../tests/integration/application.test.ts) | 4 关联检查通过 | T041, T043, T044, T048。 |
| agent-interfaces / API-003 | 真实客户端连接 | [e2e/transports.test.ts](../../tests/e2e/transports.test.ts) | 1 关联检查通过 | T045。 |
| agent-interfaces / API-004 | 大批历史启动 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/concurrency.test.ts](../../tests/integration/concurrency.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts)、[integration/worker.test.ts](../../tests/integration/worker.test.ts) | 16 关联检查通过 | T016, T036, T060, T063, T068, T069, T076, T081, T083, T085, T086, T093, T098, T100, T149, T152。 |
| agent-interfaces / API-005 | 未配内置模型；验收执行 | [e2e/skill.test.ts](../../tests/e2e/skill.test.ts)、[e2e/transports.test.ts](../../tests/e2e/transports.test.ts)、[e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts) | 4 关联检查通过 | T042, T045, T046, T047。另经 Codex CLI 0.163.0-alpha.10.2 model-visible prompt 验证产品 Skill 发现；不冒充 Claude Code、交互选择行为或其他版本加载。 |
| agent-interfaces / API-006 | 已有同名或无关文件 | [e2e/skill.test.ts](../../tests/e2e/skill.test.ts) | 1 关联检查通过 | T042。临时用户/项目目录四组合及符号链接/冲突测试；未修改实际客户端配置。 |
| agent-interfaces / API-007 | 成功导出失败报告 | [e2e/transports.test.ts](../../tests/e2e/transports.test.ts) | 2 关联检查通过 | T043, T044。 |
| analysis-runtime / ANA-001 | 无 Key 完整提炼；不能绕过规则 | [e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts)、[integration/model.test.ts](../../tests/integration/model.test.ts) | 6 关联检查通过 | T046, T047, T080, T097, T115, T118。 |
| analysis-runtime / ANA-002 | 不支持结构化输出扩展；认证或限流失败 | [integration/model.test.ts](../../tests/integration/model.test.ts) | 2 关联检查通过 | T110, T112。另有 deepseek-flash 配置端点真实 smoke；其他端点/协议不据此认定兼容。 |
| analysis-runtime / ANA-003 | 明确故障与有效覆盖；推测或矛盾 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 6 关联检查通过 | T007, T014, T019, T027, T034, T039。 |
| analysis-runtime / ANA-004 | 被排除会话；片段含已知凭据格式 | [integration/history.test.ts](../../tests/integration/history.test.ts)、[integration/model.test.ts](../../tests/integration/model.test.ts)、[unit/security.test.ts](../../tests/unit/security.test.ts) | 5 关联检查通过 | T079, T096, T115, T118, T164。 |
| analysis-runtime / ANA-005 | 历史内提示注入 | [e2e/transports.test.ts](../../tests/e2e/transports.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts)、[unit/security.test.ts](../../tests/unit/security.test.ts) | 4 关联检查通过 | T045, T138, T145, T164。 |
| analysis-runtime / ANA-006 | token 预算耗尽；重试仍无合法 JSON | [integration/model.test.ts](../../tests/integration/model.test.ts) | 4 关联检查通过 | T111, T113, T116, T119。 |
| analysis-runtime / ANA-007 | 更新提炼策略 | [integration/history.test.ts](../../tests/integration/history.test.ts) | 2 关联检查通过 | T075, T092。 |
| deduplication / DED-001 | 同来源重复同步；不同来源相似内容 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts) | 6 关联检查通过 | T013, T033, T046, T047, T077, T094。 |
| deduplication / DED-002 | 多类型召回；向量关闭 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/vectors.test.ts](../../tests/integration/vectors.test.ts) | 8 关联检查通过 | T008, T009, T017, T028, T029, T037, T146, T147。 |
| deduplication / DED-003 | 新故障复用通用标准；旧 Bug 补充新场景 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts) | 6 关联检查通过 | T015, T035, T046, T047, T080, T097。 |
| deduplication / DED-004 | 候选超过预算 | [integration/history.test.ts](../../tests/integration/history.test.ts) | 2 关联检查通过 | T083, T100。 |
| deduplication / DED-005 | 安全合并；预期相反或评级冲突 | [integration/merges.test.ts](../../tests/integration/merges.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts) | 8 关联检查通过 | T102, T103, T104, T106, T107, T108, T136, T143。 |
| deduplication / DED-006 | 两个执行者同时新增 | [integration/concurrency.test.ts](../../tests/integration/concurrency.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts) | 4 关联检查通过 | T059, T062, T082, T099。 |
| deduplication / DED-007 | 中文不同措辞；更换嵌入模型 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/vectors.test.ts](../../tests/integration/vectors.test.ts) | 4 关联检查通过 | T010, T030, T146, T147。向量测试用确定性合成表示；不证明真实 embedding 语义质量。 |
| history-ingestion / HIS-001 | 两类本地来源；未知格式 | [integration/history.test.ts](../../tests/integration/history.test.ts)、[unit/history.test.ts](../../tests/unit/history.test.ts) | 12 关联检查通过 | T074, T077, T078, T091, T094, T095, T155, T156, T157, T158, T159, T160。Codex 两份真实文本样本通过；Claude 真实版本按用户选择暂未验证。图像/运行上下文/推理排除可见。 |
| history-ingestion / HIS-002 | 三路同时触发；后台没有模型 | [e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts)、[integration/concurrency.test.ts](../../tests/integration/concurrency.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts) | 6 关联检查通过 | T046, T047, T060, T063, T078, T095。 |
| history-ingestion / HIS-003 | 原因在下一段；超长工具输出 | [integration/history.test.ts](../../tests/integration/history.test.ts)、[unit/history.test.ts](../../tests/unit/history.test.ts) | 3 关联检查通过 | T072, T089, T161。 |
| history-ingestion / HIS-004 | 读完但未分析；无 Bug 片段 | [integration/history.test.ts](../../tests/integration/history.test.ts) | 4 关联检查通过 | T076, T080, T093, T097。 |
| history-ingestion / HIS-005 | 崩溃恢复；旧 worker 回来 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/concurrency.test.ts](../../tests/integration/concurrency.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts)、[integration/worker.test.ts](../../tests/integration/worker.test.ts) | 14 关联检查通过 | T016, T036, T060, T061, T063, T064, T068, T069, T081, T085, T086, T098, T149, T152。 |
| history-ingestion / HIS-006 | 半条记录；截断与替换 | [integration/history.test.ts](../../tests/integration/history.test.ts)、[unit/history.test.ts](../../tests/unit/history.test.ts) | 6 关联检查通过 | T074, T077, T091, T094, T159, T160。 |
| history-ingestion / HIS-007 | 预算到期生成计划 | [integration/history.test.ts](../../tests/integration/history.test.ts)、[integration/plans.test.ts](../../tests/integration/plans.test.ts) | 8 关联检查通过 | T070, T071, T084, T087, T088, T101, T124, T130。 |
| history-ingestion / HIS-008 | 漏失 watch 事件 | [integration/worker-watch-error.test.ts](../../tests/integration/worker-watch-error.test.ts)、[integration/worker.test.ts](../../tests/integration/worker.test.ts) | 7 关联检查通过 | T148, T149, T150, T151, T152, T153, T154。 |
| knowledge-catalog / CAT-001 | 多 Bug 共用标准；单 Bug 需要多项检查 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 4 关联检查通过 | T006, T020, T026, T040。 |
| knowledge-catalog / CAT-002 | 历史声称已修复；根因未证实 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 2 关联检查通过 | T007, T027。 |
| knowledge-catalog / CAT-003 | 同类机制跨项目发生 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[e2e/workflow.test.ts](../../tests/e2e/workflow.test.ts) | 4 关联检查通过 | T015, T035, T046, T047。 |
| knowledge-catalog / CAT-004 | 跨项目参数化；不可执行口号 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/plans.test.ts](../../tests/integration/plans.test.ts) | 4 关联检查通过 | T018, T038, T121, T127。 |
| knowledge-catalog / CAT-005 | 严重 Bug 关联一般标准 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 2 关联检查通过 | T006, T026。 |
| knowledge-catalog / CAT-006 | 并发编辑；历史计划引用 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/merges.test.ts](../../tests/integration/merges.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts) | 6 关联检查通过 | T011, T031, T105, T109, T136, T143。 |
| knowledge-catalog / CAT-007 | 复用旧标准；提交中断 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts) | 4 关联检查通过 | T012, T032, T080, T097。 |
| project-registry / PRJ-001 | 移动与 worktree；相同 remote 不足以确认 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 2 关联检查通过 | T003, T023。 |
| project-registry / PRJ-002 | 未识别路径；已有确定映射 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/history.test.ts](../../tests/integration/history.test.ts) | 4 关联检查通过 | T003, T023, T073, T090。 |
| project-registry / PRJ-003 | 两种路径保存；并发修改 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/model.test.ts](../../tests/integration/model.test.ts) | 4 关联检查通过 | T004, T024, T115, T118。 |
| project-registry / PRJ-004 | 未选类型的最高级标准；尚未配置 | [integration/plans.test.ts](../../tests/integration/plans.test.ts) | 6 关联检查通过 | T120, T123, T124, T126, T129, T130。 |
| project-registry / PRJ-005 | 执行途中改类型 | [integration/plans.test.ts](../../tests/integration/plans.test.ts) | 2 关联检查通过 | T121, T127。 |
| storage-portability / DB-001 | 默认初始化；PostgreSQL 配置 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 2 关联检查通过 | T001, T021。 |
| storage-portability / DB-002 | 数据库版本不兼容；迁移失败 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/failures.test.ts](../../tests/integration/failures.test.ts) | 3 关联检查通过 | T002, T022, T067。 |
| storage-portability / DB-003 | 多进程写同来源；中途失败 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/concurrency.test.ts](../../tests/integration/concurrency.test.ts)、[integration/failures.test.ts](../../tests/integration/failures.test.ts) | 9 关联检查通过 | T012, T032, T059, T060, T061, T062, T063, T064, T065。 |
| storage-portability / DB-004 | SQLite 迁移 PostgreSQL；活动数据库备份 | [integration/archive.test.ts](../../tests/integration/archive.test.ts) | 4 关联检查通过 | T049, T050, T051, T052。双向逻辑互导含旧计划/报告；SQLite 原生备份不替代证据归档。 |
| storage-portability / DB-005 | 目标项目启用；打包检查 | [unit/security.test.ts](../../tests/unit/security.test.ts) | 3 关联检查通过 | T166, T167, T169。另见独立 npm tarball 安装/白名单记录。 |
| storage-portability / DB-006 | 磁盘不足或连接中断；大规模基准 | [e2e/doctor.test.ts](../../tests/e2e/doctor.test.ts)、[integration/failures.test.ts](../../tests/integration/failures.test.ts)、[integration/reports.test.ts](../../tests/integration/reports.test.ts) | 5 关联检查通过 | T041, T065, T066, T135, T142。另见两后端各 10 万 Bug＋10 万标准真实合成基准；磁盘不足为 ENOSPC 注入。 |
| taxonomy / TAX-001 | 改名与同义词；新类型未确认 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 6 关联检查通过 | T004, T005, T020, T024, T025, T040。 |
| taxonomy / TAX-002 | 多机制条目；空类型写入 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 8 关联检查通过 | T006, T008, T018, T020, T026, T028, T038, T040。 |
| taxonomy / TAX-003 | ANY 与 ALL；不隐式展开 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 2 关联检查通过 | T008, T028。 |
| taxonomy / TAX-004 | 无范围搜索；重复命中分页 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts) | 4 关联检查通过 | T009, T017, T029, T037。 |
| taxonomy / TAX-005 | 调整分类 | [contracts/catalog.test.ts](../../tests/contracts/catalog.test.ts)、[integration/merges.test.ts](../../tests/integration/merges.test.ts)、[integration/plans.test.ts](../../tests/integration/plans.test.ts) | 6 关联检查通过 | T011, T031, T105, T109, T121, T127。 |

再生：先用 scripts/verification-summary.mjs 从最新 Vitest JSON 生成脱敏断言记录，再运行 node scripts/traceability.mjs。表的 supplemental associations 是脚本中明确维护的映射，规范新增场景后需要重新人工核对，不能仅因为存在同 requirement 标签就宣称新场景已经验证。
