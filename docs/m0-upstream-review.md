# M0：miniClaude 本地源码只读核验

日期：2026-09-26。状态：本地静态核验完成，接入方案为建议；M0 尚未完成，未进入 M1。

## 1. 核验对象与方法

- 本地：用户提供的独立 miniClaude 教程检出目录；未纳入 FlowLens 仓库。
- Git origin：https://github.com/Windy3f3f3f3f/claude-code-from-scratch.git。
- 固定候选 commit：0b452360866433fde0dc77cd37ada9d303546592。
- 完整阅读根 README.md、LICENSE、package.json、tsconfig.json、session.ts；检查 agent.ts 中构造/循环/双模型流/重试/预算/压缩/工具派发、tools.ts 权限与执行、prompt.ts 注入，以及相关集成测试。依赖按 package-lock.json 提取，不将 node_modules 存在视为安装成功证明。
- git diff --exit-code HEAD -- README.md LICENSE package.json package-lock.json tsconfig.json src 返回 0：这些核验对象与本地 HEAD 一致。未联网核对远端对象，来源关联目前依据本地 Git 元数据。
- 检查前后 git status --porcelain=v1 一致：5 个 python/claude_code_from_scratch.egg-info 文件和 steps/run.mjs 原已有修改，保持原样。未读取本地密钥文件、未安装依赖、未构建、未运行测试/CLI、未复制或修改上游源码。
- README 的能力/行数描述是项目自述；本报告优先采用源码证据。根 toolDefinitions 实际包含 12 个定义，schedule_wakeup 另由自治逻辑动态提供，不将 README 的“13 工具”当固定接口契约。

## 2. 许可与依赖

根 LICENSE 为 MIT，版权声明为 Copyright (c) 2025 Windy3f3f3f3f。文本允许使用、复制、修改和分发，并要求在副本或实质性代码部分保留版权与许可声明。本轮仅核验文本，尚未引入代码。

将来实际抽取时，在 FlowLens 保留上游完整 LICENSE 文本及版权声明；来源说明记录仓库 URL、完整 commit、原文件/符号、FlowLens 目标文件和改动范围，并在 README 区分上游贡献与 FlowLens 新增功能。建议使用第三方声明文件和对应许可副本，不将整个 FlowLens 的许可证自动改成上游许可证。依赖有各自许可证，根 MIT 不能覆盖全部依赖；最终选定依赖仍需逐包核验许可/NOTICE。

| 直接依赖            | package.json 范围 | 锁文件实际版本 | 锁文件许可元数据 | FlowLens 建议                                                  |
| ------------------- | ----------------- | -------------- | ---------------- | -------------------------------------------------------------- |
| @anthropic-ai/sdk   | ^0.52.0           | 0.52.0         | MIT              | 首版 DeepSeek 不需要；移除对其 Tool 类型的依赖                 |
| openai              | ^6.33.0           | 6.33.0         | Apache-2.0       | 可作为 DeepSeek gateway 候选，必须验证官方协议和实际行为后锁定 |
| chalk               | ^5.4.1            | 5.6.2          | MIT              | 终端显示依赖，不随 Agent 抽入                                  |
| glob                | ^11.0.1           | 11.1.0         | BlueOak-1.0.0    | 文件搜索依赖，不随 Agent 抽入                                  |
| @types/node（开发） | ^22.15.3          | 22.19.15       | MIT              | 与 FlowLens 选定 Node 版本协调，不直接照搬                     |
| typescript（开发）  | ^5.8.3            | 5.9.3          | Apache-2.0       | 可参考配置，版本按 FlowLens 验证结果确定                       |

锁文件还包含 MIT、ISC、BlueOak-1.0.0 等间接依赖；表中许可仅为锁文件元数据，未完成所有依赖的原文核验。根 package.json 无 engines/packageManager；使用 npm lockfile，TS strict=true、ES2022、ESNext、bundler 解析。锁文件中已声明的 Node engines 没有显见排斥当前 Node 24 的条件，但这不是运行兼容性通过。Python 和部分 steps 脚本依赖 python3、.venv/bin/python 等环境，不整体移入 Windows/pnpm/Node 的 FlowLens。

## 3. 对照 PRD 的复用边界

| 能力                 | 源码证据（行号为本地固定版本）                                                                 | 判断与 FlowLens 处理                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Loop           | src/agent.ts:1898 chatOpenAI；1638 chatAnthropic                                               | 可有限抽取“模型选择工具→执行→返回结果→继续”的流程及调用/结果 ID 配对逻辑。不能直接实例化完整 Agent：它依赖 UI、文件会话、MCP、记忆、技能、子 Agent 和自治。改成 PRD §13.5 的可注入 gateway/executor、规范化输入及内部 AgentEvent 输出     |
| 模型流与工具参数拼接 | agent.ts:115 toOpenAITools；2065 callOpenAIStream                                              | 可抽取工具 schema 映射及按 tool index 累加 arguments 的小段逻辑；迁入 ModelGateway 并测试。SSE 字节解码由 SDK承担，上游循环消费 SDK chunk；不能声称这里已实现 FlowLens 浏览器 SSE 协议                                                    |
| DeepSeek 配置        | agent.ts:260 构造；cli.ts:336 配置选择                                                         | 现有 OpenAI-compatible baseURL 是接入候选，不是 DeepSeek 已验证。FlowLens 用显式 MODEL_PROVIDER / MODEL_NAME / MODEL_BASE_URL / MODEL_API_KEY、配置校验和 LIVE/MOCK；不能沿用凭环境自动选择双后端或 Claude 默认模型                       |
| 工具注册/执行        | tools.ts:24 ToolDef、746 executeTool；agent.ts:1389 executeToolCall                            | schema/handler 分离思路可参考；现有 ToolDef 依赖 Anthropic 类型，customTools 只能换定义，执行仍走内置 switch/特殊工具，并非任意注入 handler 的完整注册表。重做 FlowLens ToolRegistry/Executor，仅注册 PRD §7.2 四种只读业务工具           |
| 工具权限             | tools.ts:641 checkPermission                                                                   | 不复用权限模式体系。末尾默认 allow；plan 模式允许计划文件写入，还可经特殊工具派发。因此不能只设 plan 或 dontAsk 就当成 FlowLens 的权限边界。必须显式白名单、参数运行时 schema、run/task/session 绑定及输出限制                            |
| 多轮与压缩           | agent.ts:1028–1295                                                                             | 可参考保留 tool call/result 配对和限制工具结果占用的原则。现有按利用率截断、保留最近 3 个工具结果、5 分钟冷却后清理、额外模型摘要，与 PRD §7.5 不同。实现最近 6 个完整 turn、早期已验证诊断摘要、证据引用、每轮新运行摘要；不照搬四层压缩 |
| 会话保存             | session.ts:25、33；agent.ts:1010                                                               | 不复用文件持久化。它保存供应商消息 JSON 到用户目录，autoSave 静默吞错；不能提供 FlowLens SQLite 事务、消息/事件一致性、幂等、恢复和会话证据边界                                                                                           |
| 可观察性             | agent.ts:513 emitText、1984 附近 printToolCall、tools.ts 错误字符串                            | 替换为脱敏结构化日志和类型化事件，携带 trace_id/turn_id/tool_call_id；SDK 类型和终端文本不作为前端契约。FlowLens 应用服务负责公共事件 seq/持久化，adapter 不直接写 HTTP                                                                   |
| 现有测试             | test/integration/backend-parity.test.mjs、streaming-loop.test.mjs、retry.test.mjs、harness.mjs | 可参考传输层 Mock、分片参数、实际工具结果回传、隔离 HOME/cwd 和意外额外请求检测。断言需迁成 FlowLens 业务行为，不能搬 Shell/文件编辑测试来证明只读诊断合格                                                                                |

## 4. 关键适配风险（静态证据，未运行复现）

1. **非法参数被弱化。** agent.ts:1982 将 JSON 解析错误变为 {}；1878 的 Anthropic 分支也吞解析错误。tools.ts 主要靠类型断言进入 handler，schema 描述不是运行时校验。FlowLens 应返回明确参数错误，拒绝派发非法输入。
2. **流结束判定不足。** agent.ts:2065 的重组只在首次出现时记录 tool id/name，之后只累加 arguments；缺 finish_reason 时默认 stop，未单独拒绝 length 等非正常结束。应按核验后的 DeepSeek 协议测试合法分片、缺字段、截断和终止原因；不能缺结束标记就完成诊断。
3. **流中断后的重试可能重复输出。** withRetry 包围整个流消费，而 emitText 已将部分文本输出；重试没有对应的片段撤销/attempt 隔离。应为模型尝试定义明确事件语义，避免前端重复追加。此项是代码路径推断，未做运行复现。
4. **预算语义不一致。** withRetry 默认最多 3 次重试，SDK 默认重试层未统一关闭；maxTurns 为实例累计、在返回工具调用后计数，不能直接实现每轮 8 工具/12 模型请求。摘要等额外调用也需计入统一预算。FlowLens 要统一重试、5s/45s/120s 超时和取消策略。
5. **早启动不适合直接搬入。** Anthropic 分支在流中完整工具块到达后开始执行，随后才检查循环预算。P0 优先在完整参数通过校验、预算和取消检查后派发，暂不加入推测性早执行优化。
6. **取消还不是产品终态。** 现有 AbortController 能传给主模型请求，但 executor 接口没有统一 signal/超时，也没有 FlowLens 的终态/持久化裁决。上游能力不能替代取消胜出、晚到结果丢弃和终态唯一测试。
7. **上下文与费用默认值不能照搬。** 未知模型窗口默认 200000，OpenAI 请求 max_tokens 固定 16384；费用使用固定输入/输出/缓存费率。DeepSeek 需要独立核验配置，usage 缺失应记未知，不能把默认 0 当真实用量。
8. **大结果处理越过产品边界。** agent.ts:1315 超过 30KB 写入 ~/.mini-claude/tool-results，提示模型 read_file；tools.ts:729 截断按 50000 字符。FlowLens 应保持每工具≤20KB，采用分页/摘要/证据登记，不开放任意文件读取补全文本。
9. **动态扩展与会话隔离。** chat 首次自动连 MCP；工具 activatedTools 是模块级 Set。整体复用会增加隐式工具和跨实例状态。FlowLens 使用显式、有限注册和会话范围状态。

## 5. 首版明确排除

- write_file、edit_file、run_shell、任意 read_file/list_files/grep_search、web_fetch；四种业务只读工具通过 TaskBackend/RunbookRetriever 查允许的数据，不开放磁盘或互联网通用访问。
- 原编程助手 system prompt、CLAUDE.md/@include/.claude/rules 自动加载、环境/Git/用户目录内容注入（prompt.ts:75、101、208）。改成固定版本的诊断提示词，日志与 Runbook 仅作不可信证据。
- 技能发现、子 Agent、长期记忆/语义召回、MCP、/goal、/loop/schedule_wakeup、Auto Mode 分类器、yolo/acceptEdits 和 Plan Mode 文件审批。
- 上游 thinking 文本透传（agent.ts:1851 附近）；FlowLens 展示可观察工具/证据/行动说明，不展示隐藏推理。
- CLI/REPL、文件会话、Shell 测试入口、Python 双实现、教程生成器。

上游确认回调和 Plan Mode 都不是 FlowLens 重试审批实现。PRD §12 的确定性策略、服务端审批状态、过期/快照校验、事务及幂等创建 child run 仍须按后续阶段实现。

## 6. 建议与下一检查点

建议采用“固定 commit、有限抽取、业务边界重新实现”：优先复用 OpenAI 分支中小范围 schema 转换/工具流累加/消息配对逻辑，保留来源；不把完整 Agent 当依赖导入。共享中立工具契约应移除 Anthropic SDK 类型。只服务 DeepSeek 的首版无需同时安装两家 SDK。

先在 FlowLens 的 M0 隔离探针中建立测试：合法与非法分片、工具结果配对/真实 handler 回传、未注册及越界工具拒绝、8/12 预算边界、超时/取消晚到、引用修复上限、LIVE 缺配置不回退、日志脱敏与关联 ID。确认测试按预期失败后再抽取/适配。当前用户仅授权本轮只读核验，因此这些测试和适配尚未开始。

人工复查可在上游目录执行：

```powershell
git rev-parse HEAD
git status --porcelain=v1
git diff --exit-code HEAD -- README.md LICENSE package.json package-lock.json tsconfig.json src
```

再按本报告行号阅读实现并对照 FlowLens PRD §7、§8、§9–13。以上命令只核对本地版本及差异，不能证明远端真实性、构建通过或模型兼容。

本轮没有启动服务、没有生成应用日志；无需执行上游 npm test/npm start 来复查报告。模型请求、结构化日志失败定位、Windows 依赖/SQLite smoke、Mock 回归和真实 DeepSeek 往返均未执行。DeepSeek Key 仍缺，LIVE 验收未完成；不进入 M1。

后续 M0 收尾补证（2026-09-26）：经 `gh api repos/Windy3f3f3f3f/claude-code-from-scratch/git/commits/0b452360866433fde0dc77cd37ada9d303546592` 只读查询，远端对象 SHA 与本地一致。本报告此前的“未联网核对”与“未执行探针”描述保留为当时只读核验的历史状态；现况见 [实施进度](implementation-progress.md)。
