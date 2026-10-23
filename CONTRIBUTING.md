# Contributing

感谢参与 bug-manager。这个项目维护跨项目的 Bug 预防知识，任何涉及知识语义、验收范围、隐私或接口契约的变化都需要留下可复核的依据。

## 开始之前

1. 阅读 [README](README.md)、[使用说明](docs/usage.md)、[已确认决策](docs/decisions.md) 和 [AGENTS.md](AGENTS.md)。
2. 查看当前 OpenSpec change、相关规范、proposal、design 和 tasks。
3. 对产品行为、数据结构、安全边界或公开接口的修改，先补齐规范，再实现代码。
4. 不要在 Issue、PR、提交、测试夹具、截图或日志中放入真实会话、Key、生产数据库、客户资料或私人绝对路径。

## 开发环境

- Node.js >=22
- npm with the committed `package-lock.json`
- SQLite 为默认开发数据库
- PostgreSQL 变化必须用真实 PostgreSQL 16 验证

```bash
npm ci
npm run build
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
```

格式化与独立包检查：

```bash
npm run format:check
npm run test:package
```

PostgreSQL 可用专用测试库或项目脚本：

```bash
BUG_MANAGER_TEST_DATABASE_URL='postgresql://...' npm run test:all
npm run test:pg
```

测试数据库和账号必须是合成测试专用。缺少外部环境时，在交付说明中写“未验证”并说明原因，不能用 skip 或模拟服务冒充真实验证。

## 规范驱动流程

```bash
openspec list --specs
openspec list
openspec status --change build-bug-prevention-library
openspec validate build-bug-prevention-library --strict --no-interactive
openspec validate --all --strict --no-interactive
```

规范场景与命令、夹具、环境、证据分别记录：行为写在 delta spec，执行方式和证据写在 task 或验证记录。任务只有取得可观察验证后才能勾选。

## 不可偏离的产品约束

- Bug 和验收标准独立存储、独立版本、独立去重，多对多关联。
- 不维护 Bug 修复状态，不做缺陷工单。
- 只接受人工报告或人工明确引导 Agent 检查发现的 Bug。
- 项目只使用已选择的受控类型；不隐式加入父类、子类或全库知识。
- 所有规模化检索、录入去重和标准使用先限定类型，再排序分页。
- 验收执行属于编程智能体及其工具；本产品不运行测试、不控制浏览器/设备、不自动复验。
- 系统只校验结构、版本、归属、完整性与路径安全，不自动审核证据结论。
- 不判断是否发布，不提供阻断、豁免或 release_allowed。
- 报告只支持 Markdown 和 JSON，不建设 HTML 报告或 Web 管理台。
- SQLite 与 PostgreSQL 共用逻辑迁移语义；一种后端通过不能替代另一种。

## 提交与 Pull Request

- 使用聚焦的提交，说明用户可见行为或工程目的。
- 使用 `codex/` 前缀的工作分支时，请遵循维护者在任务中的要求。
- PR 描述应包含：问题与触发条件、修改后的行为、验证命令与环境、未验证范围、隐私影响。
- 新增依赖需要说明维护状态、许可证和必要性。
- 不提交 `dist/`、`node_modules/`、coverage、SQLite、`.env`、真实配置、报告、受管证据、日志、私人路径或压缩包。
- 提交前运行 `git diff --check`、敏感模式扫描，并检查 `git status --short --ignored`。

安全漏洞和敏感信息泄露不要发公开 Issue，请阅读 [SECURITY.md](SECURITY.md)。

## 许可证

提交贡献即表示你有权提交该内容，并同意其按仓库的 [MIT License](LICENSE) 分发。
