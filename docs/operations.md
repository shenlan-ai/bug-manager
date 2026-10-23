# 安装、运行数据与升级

## 首次本地使用

npm 包尚未发布，但源码仓库已采用 MIT License 并允许公开使用和贡献。使用 Node.js >=22、npm，从本仓库执行 `npm ci`、`npm run build`。当前源码已通过 GitHub Actions 的 Windows、macOS、Linux × Node.js 22/24 SQLite 作业，以及 Ubuntu、Node.js 24、PostgreSQL 16 全量作业。Debian 与 Alpine 的较早本机记录继续保留为开发历史快照。需要原生 SQLite 扩展；没有当前平台的预编译包时，安装器需要该平台的 C/C++、Python 构建工具。

依赖固定为 `better-sqlite3` 13.0.3 或兼容的后续版本。早期 12.11.1 曾在 Alpine / Node 24.21.0 的源码构建中触发 Node 24.19+ 原生清理钩子崩溃；13.x 的 N-API 路径已在同一环境干净 `npm ci` 后通过完整双数据库测试。升级 native 依赖后仍应重新安装依赖并运行 `doctor` 与项目自动测试。完整环境、CI 结果和剩余未验证客户端见 [交付验证](verification/2026-10-23-delivery.md) 与 [hosted CI](verification/2026-10-23-hosted-ci.md)；分发包不包含这些仓库验证记录。

从仓库运行下列命令，把占位符换成明确的绝对路径；中心数据目录应位于代码仓库外：

```text
node dist/cli.js --home <私有中心目录> init
node dist/cli.js --home <私有中心目录> --json doctor
node dist/cli.js --json skill install --client codex --scope project --root <目标项目目录>
```

Claude Code 改用 `--client claude`。客户端重新发现 Skill 的具体方式及加载能力需要用对应版本核实，目录安装成功不等于已验证客户端加载。未配置历史目录或模型时，初始化只创建空库，不会自动扫描或发送数据。

安装 Codex CLI 后，可在仓库完成 build 后运行 `npm run verify:codex-skill`。该检查用 `codex debug prompt-input` 核对临时项目安装的 Skill 是否进入 model-visible prompt，不请求模型；缺少 Codex CLI 时会明确失败，不能用目录存在代替客户端发现证据。

接着让项目编程智能体读取安装后的 `bug-manager` Skill：先注册项目、维护受控类型并显式保存项目类型，再配置授权历史目录、同步和领取分析任务。按来源证据分别维护 Bug 与标准；读取明确 Git/显式变更、创建计划、用智能体自身工具执行并回写结果，最后导出双报告。精确命令、字段、错误和示例见 [使用指南](usage.md) 与 [产品协议示例](../skills/bug-manager/references/protocol.md)。用 `tools --name <工具名>` 读取当前 schema，不把占位示例当成真实输入。

没有内置 Key 时，外部智能体完成上述分析；不需要交出 Codex/Claude Code 的账号凭据。内置路径在 config.json 中添加 model，仅保存 api_key_env 的变量名，将 Key 放在启动 CLI/MCP/worker 的进程环境。MCP 客户端需显式转发必要环境变量；不要把 Key 写进命令文件、项目配置或 Skill。

如只想复核合成闭环，从仓库构建后运行 `npx vitest run tests/e2e/workflow.test.ts`：SQLite 自动运行，PostgreSQL 需提供合成测试专用的 BUG_MANAGER_TEST_DATABASE_URL。它会在临时目录用两种合成历史和本地 HTTP mock 验证流程，不能当成真实模型兼容性证据。`npm run test:package` 会在独立临时消费者目录安装 npm tarball，再实际初始化 CLI、启动 MCP 并调用 `config_status`、启动 worker 扫描合成历史以及安装 Skill，结束后删除该临时目录。

## 配置与隐私

应用配置、DB 和受管证据保存在私有中心目录。源会话仍在原位，只读。历史目录须显式添加；先排除敏感目录/会话，并补充 privacy.patterns。已知凭据启发式脱敏不保证识别全部业务隐私。真实样本验证工具 `node scripts/verify-history.mjs --adapter codex --sample <已授权样本文件> --output <新的结果文件>` 只输出计数、格式与覆盖状态，不保存正文/路径；样本上限为 4 MiB，不递归扫描用户目录。

逻辑归档、报告和证据仍可能包含私人知识与来源索引，不能直接提交到 Git 或 npm。仓库忽略 artifacts、DB、.env、reports 等运行材料；npm 使用 files 白名单。公开验证记录只保留合成测试结果及必要的脱敏计数。真实历史中的命令、URL、提示词和工具输入属于来源数据，不授权执行。

## 备份与跨后端迁移

先确保没有其他进程正在对同一目标目录进行导入、升级或维护；正常读写期间可以创建一致性备份/逻辑导出。输入 JSON 文件采用以下结构，通过 `--file` 提交，避免 shell 转义问题：

| 操作            | 命令后缀                            | 文件内容                                     |
| --------------- | ----------------------------------- | -------------------------------------------- |
| SQLite 原生快照 | `storage backup --file backup.json` | `{"filename":"<不存在的备份文件绝对路径>"}`  |
| 两后端逻辑导出  | `storage export --file export.json` | `{"directory":"<不存在的归档目录绝对路径>"}` |
| 导入空目标库    | `storage import --file import.json` | `{"directory":"<已有归档目录绝对路径>"}`     |

所有命令加前缀 `node dist/cli.js --home <源或目标中心目录> --json`。storage export/import/backup 是显式维护入口，不需要知识写入的 actor/reason/key。SQLite 快照仅含 DB；需要可携带证据时使用逻辑导出。不要裸拷贝活动 SQLite 的主文件，也不要将 SQLite snapshot 命令用于 PostgreSQL。

逻辑导出在一致事务快照中分页写 rows.ndjson、manifest 及受管证据；manifest 包含记录计数和 hash。PostgreSQL 使用 repeatable read。源库继续保留。先用 `init` 初始化独立空目标库，再导入；非空目标拒绝导入，schema 不兼容、篡改或部分写入失败不能成为成功恢复。切换项目 CLI/MCP/worker 前，核对项目、类型、知识修订、关系、计划/结果数量及证据 hash。两个方向互导及旧报告保留均有自动测试。失败的目标目录需要人工确认用途后再清理，不自动删除源库。

## 版本升级与恢复

1. 停止本产品的前台 worker 和写入进程，保存当前程序版本、config.json 的安全引用以及一份逻辑归档；已有 SQLite 可另做原生快照。
2. 在隔离目录安装并构建新版本，保留可恢复的旧程序。新版本当前物理迁移为 v6，配置/逻辑归档 schema 为 1；实际版本用 doctor 核实。
3. 对目标中心目录运行 `init` 执行显式迁移，再运行 doctor。遇到 schema_too_new 时停止使用旧程序，不清空、不自动降级。迁移失败保留错误并用原版本/兼容工具恢复备份。
4. 先核对已有知识、来源和旧报告，再恢复 worker 与智能体使用。回退程序版本前核实 DB 兼容性；需要恢复时导入独立空库或使用已验证快照，不把旧结构覆盖到活动 DB。

## 源码发布与 npm 发布边界

项目代号和 npm 包名为 bug-manager，源码使用 MIT License 在 GitHub 公开。`package.json` 保持 `private=true`，因此仓库公开不等于 npm 包已经发布，也防止在最终包名、账号和明确发布决定尚未确认时误发。

源码发布前至少核对：

1. `git status --short --ignored` 中没有待提交的配置、SQLite/PostgreSQL 数据、证据、真实会话、日志或私人路径。
2. 在干净 checkout 执行 lint、typecheck、format、build、SQLite/PostgreSQL 测试和独立包烟测。
3. 检查 `npm pack --dry-run` 白名单、GitHub Actions 结果、文档和 Skill 资源。
4. 明确未验证平台和客户端，不把部分测试通过描述成完整兼容。

未来发布 npm 包还需要单独确认最终包名和账号、复核包内容，并由维护者明确执行发布。产品报告始终不生成发布许可，也不自动发布。
