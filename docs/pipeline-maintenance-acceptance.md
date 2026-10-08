# FlowLens 四项维护改造验收

日期：2026-10-08。状态：四项已完成，逐项及最终离线验证通过。要求见 [原实施计划](pipeline-maintenance-plan.md)，完成状态见 [待办](todo.md)。

本轮保留开始时已有的未提交和未跟踪改动，没有 reset、checkout、重新 seed 用户库或提交 Git commit。原有单次人工批准、`CANDIDATE_CHECK` 候选 SQL 只执行一次、复用输出事务入库、项目隔离、SSE、取消和重启凭证核对继续保留。测试使用独立数据库和 MOCK/受控模型网关，未调用 LIVE，未修改 `.env.local`。

## 实现与入口

| 项目     | 最终行为                                                                              | 关键文件                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 格式整理 | 锁定 Prettier，统一源码/配置/文档规则，编辑器与 CI 同规则                             | 根 `.prettierrc.json`、`.prettierignore`、`.editorconfig`、`.vscode/settings.json`、`package.json`、`.github/workflows/p0.yml`                                        |
| 日志分页 | 严格输入、稳定 seq、筛选和向前分页、20 KiB 完整响应限制、逐页证据、重复内容去重       | `packages/contracts/src/pipeline.ts`、`apps/server/src/pipeline-logs.ts`、`pipeline-tools.ts`、`pipeline-agent.ts`                                                    |
| 增量撤销 | 一次基线、可校验事件链、无整表 JSON 的快照元数据；只删除最新有效批次新增行            | `apps/server/src/pipeline-history.ts`、`pipeline-data.ts`、`pipeline.ts`、前端 `PipelineDatabasePage.vue` 与批准/结果页面                                             |
| MCP      | 每次诊断真实 stdio 连接、发现并调用六工具、来源校验、结果回写、证据追溯和生命周期清理 | `apps/server/src/pipeline-mcp-client.ts`、`pipeline-mcp-server.ts`、`pipeline-tool-reader.ts`、`pipeline-tools.ts`、`pipeline-agent.ts`、前端 `PipelineDiagnosis.vue` |

## 1. 格式整理

Prettier 固定为 3.9.9，行宽 100、两空格、单引号、分号、LF，保留 Markdown 段落换行。Vue 使用嵌入语言格式化，以保证模板插值格式化可重复执行。保留现有 ESLint 规则，没有为排版增加业务 lint 规则。

`pnpm format` 与 `pnpm format:check` 范围一致。依赖、dist、日志、评估报告、演示媒体、数据库、测试产物、环境文件和第三方参考代码排除。CI 在锁定安装之后增加格式检查。

格式阶段先独立通过 146 后端 / 46 前端测试、构建和 45 MOCK E2E，再实施业务改造。以包含初始未提交文件的 Codex capture 为基准，对单独格式化后的 153 个 JS/TS/Vue 脚本进行字符串、正则、模板字面量及规范化属性/声明名称审查：40,182 项，0 个差异。该检查范围是脚本字面量和名称，模板交互由浏览器回归验证；不把格式差异声称为字节不变。[格式审查记录](evals/pipeline-maintenance-20261008/format-audit.json)

浏览器验收生成的图片保存到本轮证据目录，原有演示图片恢复为初始 capture 的字节，保留原未提交图片改动。[媒体保留记录](evals/pipeline-maintenance-20261008/preserved-media.json)

## 2. 日志分页与证据

`get_logs` 仅接受严格 `limit`、`before_seq`、`step`、`level` 参数。默认 20 条，最多 100 条；整数游标是原日志数组索引加一的排他上界。阶段限定 query/validate/precheck/verification，级别限定 DEBUG/INFO/WARN/ERROR。未知字段、小数、非法枚举及超过执行日志范围的游标被拒绝。

从最新匹配日志向前读取，每页内部按原 `seq` 升序。`matched_count` 是当前游标范围内符合筛选的总数；`has_more`、`next_before_seq` 和 `truncated_by_bytes` 说明续读状态。字节截断保留完整日志及连续分页范围，包含 MCP 来源元数据的完整工具响应不超过 20 KiB；单条放不下则返回 `LOG_ENTRY_TOO_LARGE`，不静默删改内容。

每页登记执行 ID、日志 hash、实际参数、有效游标及首尾原始序号。历史保留轮次、call ID、实际参数/结果和证据编号，刷新后仍可打开原页。重复观测按绑定执行中的 seq 和实际内容识别，改变条数、筛选、证据 UUID 或 MCP 外层元数据不产生虚假进展。第一次成功空页可以作为观测，但重复空页不解除无进展限制。

分页专测覆盖数量/字节截断、筛选与末页、非法游标；自适应及 MCP 测试覆盖翻页发现早期错误、重复参数变体、空页、绑定失效和引用校验。

## 3. 增量历史、迁移与撤销

目标库独立使用 `PRAGMA user_version=2`。服务启动及可写目标入口执行幂等迁移，在事务内再次检查版本；只读数据库查询和 MCP 读取不迁移、不恢复、不写状态。旧库保留原 `snapshots` 和旧批次，将迁移时当前业务数据保存为一次基线，之后采用增量模式。缺少新字段的旧批次按 FULL 解释。

新结构包括 `history_baselines`（一次完整数据和摘要）、`change_events`（单调 seq、INSERT/UNDO_INSERT、业务键、完整变化行、前后链 hash）、`history_state` 和 `snapshot_metadata`（基线引用、事件位置、行数、hash、数据版本）。新快照元数据没有 `rows_json`，每批存储不随当前完整表行数增长。

入库前历史从基线重放事件重建，校验行结构、唯一键、事件连续性/链 hash、最终行数和 hash。旧 FULL 快照继续校验并查询。撤销不把当前数据作为损坏历史的替代结果，也不重写原历史快照。

入库在同一目标事务内写业务行、实际变化事件、历史元数据、批次、幂等凭证和版本。零新增批次不推进有效数据头。撤销仅针对最新有效且有实际新增的批次，校验前后摘要、重建历史和新增行归属，再以精确业务键、执行和行内容条件删除新增行。撤销事件、恢复凭证、批次状态、前一有效头和新版本同事务提交；失败完整回滚。没有整表 DELETE 后重插，重复入库/撤销及服务重启仍核对真实凭证。

实际存储验证：

| 场景                                        | 基线 | 新 FULL 快照 | 元数据 |                 增量事件 | 数据结果                                       |
| ------------------------------------------- | ---: | -----------: | -----: | -----------------------: | ---------------------------------------------- |
| 2000 原有行，新增 A/B 各一行，重复 B 零新增 |    1 |            0 |      3 |                 2 INSERT | 共 2002 行，零新增不移头                       |
| 依次撤销 B、A                               |    1 |            0 |      3 | 共 4（含 2 UNDO_INSERT） | 原 2000 行完全保留，旧入库前查询仍返回对应历史 |
| dist 浏览器 A：入库 4 行再撤销              |    1 |            0 |      1 | 4 INSERT + 4 UNDO_INSERT | 目标 0 行，版本 2，批次 RESTORED               |

六个增量专测还覆盖第二条 INSERT 真正失败、删除后 hash 验证失败、事件写入失败、缺失或损坏基线/事件/元数据/增量摘要、旧 FULL 快照及旧批次增量撤销；既有流水线测试另验证旧目标库启动迁移两次只建一个基线、只读查询不迁移、新批次历史查询及撤销。[增量测试](../apps/server/test/pipeline-incremental.test.ts) · [启动验收存储报告](evals/pipeline-maintenance-20261008/build-start-report.json)

存储优化不消除整表读取：提交/撤销仍计算全表 hash 并核对历史，历史查询仍重放事件。2000 行测试是功能和存储结构证据，没有做生产大表性能验收。

## 4. 真实 MCP 接入

使用官方 TypeScript SDK 分包 `@modelcontextprotocol/client`、`@modelcontextprotocol/server`，均锁定 2.3.1；契约、服务端和前端统一锁定 Zod 4.6.5，以支持 SDK 的 Standard JSON Schema。采用当前 SDK 支持的协议版本 `2026-07-28`。验证设备为 Windows、Node.js 24.14.1、pnpm 11.5.0。[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [客户端文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/README.md) · [服务端文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/README.md)

每次诊断通过真实 `tools/list` 发现六个允许工具，校验集合、重复/遗漏、严格参数 schema，并适配为模型原生 Tool Calling 定义。SDK 处理分页发现，集成测试确认两页定义全部发现。模型的 tool_calls 经真实 `tools/call` 到独立服务；其结构化结果和来源校验后，由主进程登记证据并按原 `tool_call_id` 回写下一轮。

范围由可信后端固定，包含项目、执行、SQL/输入/日志/执行内容 hash 等，不作为模型参数暴露。工具服务只以 readonly SQLite 读取，未实例化会迁移或恢复的 PipelineService。主进程和子进程均检查诊断状态及绑定，拒绝跨范围、旧版本、执行被改写或取消后的迟到结果；错误不产生成功证据。没有连接失败后的本地调用回退。

六工具名称为 `get_execution`、`get_sql`、`get_schema`、`get_logs`、`get_output_preview`、`get_task_contract`，从同一共享 schema 生成描述和两端校验。stdio stdout 仅用于协议，错误写 stderr。子进程不继承模型 API key、模型地址或 NODE_OPTIONS。客户端/服务在成功、失败、超时、取消和退出时清理连接；真实测试核对相关子进程已退出。Windows 启动隐藏窗口。

dev 使用 TS 入口，build/start 使用实际 dist JS 服务，不依赖开发加载器。新 trace 保存 `transport: MCP` 和服务名，旧无标记 trace 按历史工具显示。9 个真实 MCP 集成测试覆盖六工具、分页发现、拒绝范围/参数错误、缺失/额外/放宽定义、错误/伪造/超大结果、取消/超时/协议错误/退出、模型回写及连接失败停止。

真实通信证据：

- [六工具发现、调用、实际业务结果及来源](evals/pipeline-maintenance-20261008/mcp-tools.json)：真实 SDK 客户端与子进程通信，模型为受控网关。
- [分页取证与三轮模型请求记录](evals/pipeline-maintenance-20261008/mcp-model-loop.json)：首轮 `{limit:10}` 取得 seq 46–55，下一轮用 `before_seq:46` 和 ERROR 筛选取得早期 seq 3，实际返回按 call ID `recent`/`older` 回写，最终引用该页证据并以 NO_CANDIDATE 结束。没有把全部日志预填给模型。
- [dist 启动报告](evals/pipeline-maintenance-20261008/build-start-report.json)及 [A 完整记录](evals/pipeline-maintenance-20261008/build-start-case-A.json)：浏览器三轮 MOCK 请求，经 MCP 读取 SQL/schema、批准后单次执行候选、入库 4 行、查询及撤销，刷新核对恢复凭证，无页面错误。批准属于独立测试库中的自动化验收。

本轮未连接另一个 AI 客户端或部署远程 MCP，没有用 MOCK 结果宣称 LIVE 推理质量。

## 最终验证

全部检查针对最终业务代码执行；最后只更新文档及保存验收产物，再执行格式检查。

| 命令                        | 实际结果                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| `pnpm format:check`         | 通过；重复格式化稳定                                                |
| `pnpm typecheck`            | contracts、server、web 通过                                         |
| `pnpm lint`                 | server、web 通过                                                    |
| `pnpm test`                 | 27 个服务端测试文件、167 测试；14 个前端测试文件、48 测试，全部通过 |
| `pnpm build`                | contracts、server、web 构建通过                                     |
| `pnpm test:e2e`             | 45/45 通过，MOCK，实际 MCP 服务及独立目标库                         |
| `pnpm check:pipeline:start` | PASSED，最终 dist 服务 + preview + 浏览器，隔离库，模型 usage 为 0  |
| `pnpm eval:mock`            | 6/6 根因、引用及最低证据，12/12 工具，2/2 保留判断；0 请求/usage    |
| `pnpm eval:mock --m5`       | 12/12 根因、引用及最低证据，24/24 工具，2/2 保留判断；0 请求/usage  |

两组离线评测输出均为 `MECHANICAL_CHECKS_PASSED_SEMANTIC_REVIEW_REQUIRED`：机械检查通过，语义措辞仍需人工复核。没有把它改写为人工确认或真实模型准确率。

完整输出已保存：[单元测试](evals/pipeline-maintenance-20261008/pipeline-maintenance-test.txt) · [浏览器测试](evals/pipeline-maintenance-20261008/pipeline-maintenance-e2e.txt) · [P0 MOCK](evals/pipeline-maintenance-20261008/pipeline-maintenance-eval.txt) · [M5 MOCK](evals/pipeline-maintenance-20261008/pipeline-maintenance-eval-m5.txt) · [最终启动](evals/pipeline-maintenance-20261008/pipeline-maintenance-start-final.txt)。同目录保留本轮浏览器截图，旧日期验收事实保持原样。

修正了新增浏览器 MCP 断言中多轮工具列表的严格定位器冲突，并重跑全部 45 项 E2E。2000 行测试建库使用单次事务；服务端测试超时统一为 15 秒以容纳 Windows 下多个真实子进程启动，MCP 调用和诊断预算仍有独立超时/取消测试，不靠放宽生产预算通过。

## 可使用的项目/简历表述

仓库未发现独立简历文件，已更新 README 和待办，并在此提供经验收支持的表述：

> 通过 MCP stdio 接入六个只读诊断工具，统一参数与执行版本校验、工具结果回写和证据追溯；实现日志按需分页取证，以及批次增量记录与事务撤销恢复，保留可重建的入库前数据查询。

不再描述为每次保存完整入库前快照；格式整理仅作为工程维护改造。

## 后续：明确只撤销数据（2026-10-08）

工作台和结果复查页的按钮统一为“只撤销本次数据”，确认按钮为“确认只撤销数据”。确认范围、完成提示及操作记录均明确当前 SQL 版本继续保留，只移除本批次新增行；再次预检只读，重新入库仍需批准。后端原有增量删除行为保持一致。

在既有 A 修复 E2E 中增加实际断言：撤销后 SQL 内容、版本及当前版本指针不变，目标库为 0 行、数据版本 2；再次预检通过，预计新增 4 行，但目标数据和批次记录均不变，仅新增一次预检执行。结果页路径也验证 SQL 和当前版本指针保留。

本次修改后复验 `pnpm lint`、48 项前端单元测试、构建、6 项相关 E2E 及最终 `pnpm check:pipeline:start`，全部通过；最后更新文档并执行格式检查。全套 167 / 48 单元测试、45 E2E 和两组离线评测结果是上文四项改造的验收，本次界面调整补充相关回归，没有宣称重新运行完整 E2E。

输出及实际 dist 验收报告保存在 [本次证据目录](evals/pipeline-data-only-undo-20261008)。其中新浏览器截图另存，原演示图片与本轮开始时的工作区字节一致。

提交前补充 `.gitattributes`，文本检出统一 LF，媒体显式按二进制处理，避免 Windows `core.autocrlf=true` 的检出结果与 Prettier 换行规则冲突。验收文本副本仅规范换行和行尾空白，原始输出仍在忽略的 logs 目录；暂存区 whitespace 检查通过。
