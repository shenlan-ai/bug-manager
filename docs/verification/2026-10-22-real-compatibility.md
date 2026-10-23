# 真实来源与模型验证

日期：2026-10-22。用户明确授权在本机查找 Codex 会话，并使用其指定 OpenAI 兼容端点和 deepseek-flash 模型进行有界验证。后续选择 C，Claude Code 真实兼容性暂保留未验证。没有读取 Codex/Claude 登录凭据。

## Codex 文本历史

仅选取两份归档会话，分别为 574881、824355 字节。先在本地检查结构和规范化结果，源文件读取前后 hash 相同；公开记录不包含源路径、会话身份、源 hash、正文或工具参数。客户端版本来自样本 session_meta.payload.cli_version，均为 0.162.0-alpha.17.2。本机同时存在 PowerShell/npm 包装器 0.154.0 和桌面安装的 codex.exe 0.163.0-alpha.10.2；任一现装版本都不能替换历史生产者版本或代表全部客户端行为。

命令结构：`node scripts/verify-history.mjs --adapter codex --sample <明确样本文件> --output <新的脱敏结果文件>`。本次两次实际结果为 [样本 A](codex-sample-a-2026-10-22.json)、[样本 B](codex-sample-b-2026-10-22.json)。

| 样本 | JSONL 记录 | 规范化事件 | user / assistant / tool | 元数据 / 排除 / 文本事件记录 | 未知记录 |
| --- | --- | --- | --- | --- | --- |
| A | 85 | 24 | 2 / 2 / 20 | 49 / 12 / 24 | 0 |
| B | 187 | 52 | 1 / 6 / 45 | 108 / 27 / 52 | 0 |

实际样本暴露 token_usage_record 与 world_state。已将前者明确作为用量元数据；后者为运行上下文快照，明确排除，内容不进入提炼。合成回归检查其结构处理与未来未知记录仍可见。两个来源的 declared session identity、消息、函数/自定义工具输入输出正常规范化，归档源未被修改。

B 有一条 input_image 内容不受支持，保留 unsupported_content 警示；图像、推理和运行上下文不作为文本提炼证据。本次只是这两个已观测样本与文本记录形态的验证，不是所有客户端功能、所有版本或云端历史的兼容承诺。Claude Code 仍只有合成协议/分支/归档/追加测试，没有真实版本声明。

## Codex Skill 发现

本机 Codex CLI 0.163.0-alpha.10.2 通过 `debug prompt-input` 渲染了不发往模型的完整 prompt，实际显示临时项目 `.agents/skills` 的 Skill 根、`bug-manager` 名称、描述和 `bug-manager/SKILL.md` 入口；安装内容 hash 与 canonical Skill 相同，protocol 引用也存在。验证共发起 0 次模型请求，结果见 [Codex Skill 客户端证据](codex-skill-client-2026-10-22.json)。

这项结果证明该版本的 Codex CLI 能发现并广告产品 Skill，不能证明桌面客户端、其他 Codex 版本会自动选中并正确使用它，也不替代 Claude Code 真实客户端或跨平台验证。

## 配置的真实模型

对用户给定服务的 /v1 路径，以 Chat Completions、deepseek-flash、response_format=auto 进行验证；Key 仅通过隐藏的标准输入进入一次 Node 进程的环境，在 finally 中删除，没有写入配置、DB、公开工件或日志。公开 [模型计数](model-smoke-2026-10-22.json) 不包含服务域名、Key、原始响应或私有片段。

| 检查 | 实际结果 | HTTP 请求数（含退路） |
| --- | --- | --- |
| 小型合成结构化响应 | literal/string schema 校验通过 | 2 |
| 内置提炼合成重复提交故障 | 处理 1 段，保存 1 Bug、1 独立标准、1 覆盖关联，job completed | 3 |
| 最小脱敏真实 Codex 片段 | 接收合法结构，区分已观察错误与未证实原因 | 2 |
| 独立能力退路跟踪 | json_schema 返回 400，回退无 response_format 返回 200，输出通过校验 | 2 |

总计 9 次有界请求。连接和真实片段检查分别使用独立 provider；内置提炼任务使用持久化预算与标准领域事务。另一次最小合成检查只记录 HTTP 状态和 response_format，不记录请求头、正文或响应体，确认 JSON Schema 请求返回 400、auto 回退无扩展请求返回 200。解析后仍校验 schema，没有为了通过验证放宽产品 schema。token 用量为端点自报，预留是应用的 UTF-8 字节估算，不作为费用或精确 tokenizer 证明。

模型使用的真实片段只保留一条通用认证错误说明，删去仓库/分支、精确端口；没有传整份会话、工具参数、私人路径或本次 Key。模型的内容判断属于提炼结果声明，不能证明所有 Bug 都被发现，也不是对验收执行结果的自动审核。大规模提炼质量、其他端点/模型、Responses 协议的真实服务兼容性仍未验证。
