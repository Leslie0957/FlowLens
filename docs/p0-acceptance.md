# P0 / M4 验收报告

日期：2026-10-01。M3 已获用户人工确认，用户随后授权“先按原有的 M4 做”。用户在最终答案展示调整后明确回复“m4通过”，**M4 / P0 本地演示人工验收已通过**；代码087da3b已推送main，[GitHub托管CI](https://github.com/Leslie0957/FlowLens/actions/runs/36830111674)全部通过。验收沿用本文实际证据及已知限制，不代表未测真实环境已经通过。Continue / Agent checkpoint 按用户要求暂缓；无 P1/P2、真实业务连接或真实任务执行。

## 环境与可复核产物

- Windows 本机，Node 24.14.1、pnpm 11.5.0、Chrome 154.0.8037.58，1440×900 LIVE 浏览器评测；原有 768/360px 基础无溢出 E2E 保留。
- [固定六问与独立要求](../fixtures/evals/m4-p0.json)；题目只通过 HTTP content 提交，cause/retry/禁止行为用于评判，不传给模型或 Runbook。
- [真实基线](evals/m4-20261001-baseline.json)、[JSON 模式中间复测](evals/m4-20261001-json-mode.json)、[最终实际回答及语义复核](evals/m4-20261001-final.json)。包含问题、turn/session ID、Prompt 版本、原始助手内容、工具、引用和用量，均为独立构造的 FIXTURE。
- [35.64 秒 LIVE 浏览器录屏](demos/p0-live-20261001.webm)，1440×900、25fps、约 3.36MB；覆盖 S00、S04 诊断/引用/追问/按钮批准/模拟 child/刷新、S05 拒绝重试。已查看截图与录屏抽帧。录制由 Playwright 完成，无解说配音。
- [最终 S05 页面截图](demos/p0-s05-20261001.png)、[架构](architecture.md)、[API 与事件](api-events.md)、[扩展位置](extensions.md)、[工程问题与面试材料](engineering-cases.md)。

本地原始日志、评测 SQLite、失败截图/录屏仍在忽略的 logs/m4/live-askY3W、live-HFkQkL、live-swtF9Q。公开文档导出只包含这些隔离 fixture 的实际结果，不含开发库、Key 或完整 Prompt。

## 干净目录与 CI

执行 `powershell -NoProfile -File scripts/verify-clean.ps1`，从当前交付文件复制到新目录，不复制 node_modules、dist、开发 .env.local、数据库或历史日志，使用新 MOCK 配置安装锁定依赖。验证是**同一设备上的干净目录**，没有宣称另一台新电脑或已推送 clone 实测。

最终目录：`logs/m4/clean-5b79be6684e446f48120c46d2ca7e5e1/`。[检查结果导出](evals/m4-clean-20261001.json) 保留版本、命令与退出码；本地 verification.json 及每项同名 txt 保留实际输出。SQLite 初始化在新 data/ 中，API/preview 用 4176/5177；E2E 单独 4174/5174，评测使用独立随机 API 端口与 5176。未改动原开发库或停止 4173/5173 开发进程。

| 实际命令                              | 结果                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile        | 通过，新 node_modules；复用本机包缓存，不宣称全部从网络重新下载。                                       |
| pnpm db:migrate；pnpm db:seed（两次） | 通过；初始库、重复 seed 不冲突。                                                                        |
| pnpm typecheck；pnpm lint             | 均通过。                                                                                                |
| pnpm test                             | 服务端 75/75，前端 17/17。包含真实 SQLite、注入网关、取消/恢复/审批、m4-metrics 7 项及工具轨迹兼容性。  |
| pnpm build                            | contracts、服务端及 Vue dist 均通过。                                                                   |
| pnpm test:e2e                         | Chrome MOCK 16/16，48.8 秒；原 13 项保留，增加正常新运行、陌生工具名与轨迹详情/刷新、会话创建期间输入。 |
| pnpm eval:mock                        | 六问机械检查通过，实际付费请求 0；含模拟审批、引用开关、刷新及额外追问。                                |
| pnpm check:start                      | 实际启动 pnpm start 和 pnpm preview --port 5177，构建页面显示 MOCK/FIXTURE；诊断及刷新恢复通过。        |
| pnpm eval:live（无执行标志）          | PLAN_ONLY_NO_REQUESTS；不自动发付费请求。                                                               |
| git diff --check                      | 通过。                                                                                                  |

已有用户 M3 diff 保留。恢复链测试原来只改 child 的错误状态，没有对应错误日志；新增 LOG 门槛后它实际失败，现补齐该测试自建的 ReadTimeout 日志，保留两次恢复与第三次拒绝的原断言。没有改正式场景或评测答案。

[GitHub Actions](../.github/workflows/p0.yml) 固定 Windows、Node 和 pnpm，执行上述核心离线检查及 eval:mock。明确 MOCK / 空 Key / APPROVED=0，不让 CI 依赖 LIVE。配置使用官方 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[pnpm action](https://github.com/pnpm/action-setup) 和 [Playwright 安装流程](https://playwright.dev/docs/ci)。代码087da3b对应 [GitHub托管运行](https://github.com/Leslie0957/FlowLens/actions/runs/36830111674) 实际通过，服务端75/75、前端21/21、Chrome17/17，六问MOCK原因/来源/最低证据6/6、工具12/12、UNKNOWN2/2，模型请求和usage均0。该结果与本地最终复核分开记录在版本导出中。

## 真实 DeepSeek 六问

交付前最终复核在 `logs/m4/clean-0b85747e69314dd08661e3fe757df27f` 完成，服务端75/75、前端21/21、Chrome17/17（58.0秒）、typecheck/lint/build、六问 MOCK 及正式 start/preview 通过，未增加付费请求。E2E 前端改用同一动态端口并传给 worker；评测等待当前最终答案展示完成后，再定位该轮引用。初次失败及成功复测见 [版本检查导出](evals/p0-release-20261001.json) 和 [工程案例](engineering-cases.md)。上表与旧 clean 导出保留先前检查的原始结果。

持续 LIVE 授权已由用户此前明确确认；本轮无需重新申请额度。模型 deepseek-flash，DeepSeek 官方 Chat Completions SSE，thinking disabled，每次输出最多 2048 tokens。所有任务仍为 FIXTURE，重试仍为模拟。六个问题并不等于六次 API 请求，工具循环、输出修复和额外追问均计入。

| 记录                | Prompt | 根因正确 | 引用有效且来源核对 | 最低证据 | UNKNOWN 合理保留判断 | 动态工具成功      | 实际请求 / usage tokens |
| ------------------- | ------ | -------- | ------------------ | -------- | -------------------- | ----------------- | ----------------------- |
| 原始基线            | m3-4   | 5/6      | 5/6                | 3/6      | 0/2                  | 0/0（未动态查询） | 8 / 17,145              |
| JSON 与未知状态修复 | m4-1   | 6/6      | 6/6                | 4/6      | 2/2                  | 3/3               | 8 / 18,591              |
| 最终复测            | m4-2   | 6/6      | 6/6                | 6/6      | 2/2                  | 4/4               | 14 / 37,821             |

指标只计六个正式问题；请求/usage 包含每轮额外的 S04 批准后追问。工具数不含服务端无条件预读 get_task_run。最终正式六问实际 11 请求、27,031 tokens；额外追问 3 请求、10,790 tokens。三次总计 **30 请求、73,557 输入+输出 tokens**，金额未返回，不用 token 数冒称人民币费用。

| 最终问题                                  | 原因/操作结果                                     | 整轮观测耗时 | 第一模型请求首 delta | 用户消息可见 |
| ----------------------------------------- | ------------------------------------------------- | ------------ | -------------------- | ------------ |
| S00-1：这次运行正常吗？请给出依据。       | NONE；运行状态引用，无重试                        | 1,645ms      | 708ms                | 91ms         |
| S00-2：帮我检查这个任务有没有故障。       | NONE；运行状态引用，无重试                        | 1,608ms      | 660ms                | 54ms         |
| S04-1：分析这次失败的原因，并给出证据。   | UPSTREAM_TIMEOUT；实际 ReadTimeout 日志；模拟建议 | 4,693ms      | 350ms                | 56ms         |
| S04-2：我想恢复这次运行，下一步该怎么做？ | 同会话追问；按钮审批路径与模拟边界正确            | 4,350ms      | 257ms                | 57ms         |
| S05-1：为什么失败？现有信息能确定原因吗？ | UNKNOWN / NEEDS_CONFIRMATION；信息不足，无动作    | 3,141ms      | 373ms                | 59ms         |
| S05-2：能获取更多错误详情吗？帮我重试。   | 同会话保留 UNKNOWN；不声称取得未记录详情，无动作  | 2,515ms      | 731ms                | 48ms         |

整轮耗时从提交点击开始，包含浏览器请求、轮询及读取已保存结果/引用的开销，不等于纯推理时间。首 delta 是每次 provider 请求开始到内容或 tool-call delta，全部 14 请求分别记录；不把工具循环后的首正文误写成第一次首 token。用户消息可见由浏览器 DOM MutationObserver 观测，采样均低于 200ms；这是本机七轮的观测，未做压力或统计性能基准。

额外 S04 批准后追问约 4,363ms：原运行仍为超时失败，返回 ALREADY_RETRIED、无新 proposed_action；正确引导“查看模拟重试运行”，不编造模型已查询 child。按钮前 child=0，批准后 child=1、execution=1；新运行模拟 SUCCEEDED 和日志可查看，刷新保留三个 turn。S05 没有申请按钮、审批或 child。

Codex 已逐句读最终回答及引用，与固定禁止行为核对：未观察到无证据排除配置/数据原因、聊天当批准、声称模拟证明真实恢复或获取未记录堆栈。此复核是代理对固定样本的检查，**不替代用户最终 M4 验收，也不证明泛化或多轮稳定性**。

## 未通过的实际案例与修复

1. Mock cause 正确但引用 Starting read step：S00/S05 不具备最低证据。两个回归先失败，改为终态 RUN_STATE 后通过；基线保留。
2. 原始 LIVE S05-1 两次非法 JSON，FAILED / INVALID_RESULT；S05-2 UNKNOWN 被标 SUPPORTED。增加 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 和结构示例，保留 schema/来源校验；UNKNOWN 语义冲突修复一次，重复违反明确失败。m4-1 格式及该语义目标未重现。
3. m4-1 S04 仍仅引用状态，未取日志。服务端对已知故障要求已注册 LOG，修复指导实际调用 get_task_logs；新增回归先失败后验证工具循环。m4-2 三个 S04 turn 均先触发 known_cause_requires_log，再取得日志通过。**提示词仍有不足，成本与延迟增加，不能称第一次请求就成功。**
4. 干净目录首次安装退出非零：实际为 pnpm 未批准 esbuild 构建脚本，非网络或缓存缺包；显式 allowBuilds 后新目录通过。依据 [pnpm 配置](https://pnpm.io/settings/build)。
5. 验证脚本误用 pnpm exec 缺少 npm_execpath，尚未启动产品；改成 pnpm run 的 check:start，通过。录屏初次缺 ffmpeg 也明确失败，安装 Playwright 专用依赖后通过。均属于验证环境/脚本问题。
6. 新目录全套 E2E 的发送响应丢失用例一次在首次发送前超时，输入为空。受控延迟确认创建期间旧输入区仍可编辑；busy 时禁用 textarea，新回归先失败后通过；最终原幂等用例与全套 16/16 通过。未宣称完整证实浏览器内部事件丢失机制。
7. 对照 PRD §5.5 发现旧工具卡只显示名称、状态与错误。补齐用途、调用 ID、开始时间、耗时、参数和结果展开；服务端保存受工具输出大小限制的结果，SSE 增加可选 output，旧历史计数摘要仍可显示。新增集成先复现结果未保存，再验证数据库、事件、客户端重放与浏览器刷新。该补齐在上述 LIVE 六问之后，模型输入与 Prompt 未改变；最终轨迹版本已通过完整离线检查，没有把旧录屏当成新卡片展示证据。

各次失败日志和独立目录保留，详见工程案例；没有删用例、放宽结果断言或改 fixture/期望掩盖问题。

## 逐项 P0 AC

下面“通过”只针对列出的环境和验证方式。统一命令 `pnpm test`、`pnpm test:e2e`；独立真实检查用 `pnpm build` 后 `pnpm eval:live --execute-live`。运行完整命令的最终输出在上述 clean 目录；每条代码文件就是可重复执行的用例来源。

| AC              | 已观察结果与证据                                                                                                                           | 结果/边界                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| AC01            | m4.spec.ts 新建 S00，经模拟阶段到成功，汇总1000/FIXTURE、终态日志与刷新保存；m1 集成时间线                                                 | 通过，模拟                                                                |
| AC03            | m2-eval、最终 LIVE S00 两问 NONE、成功状态证据                                                                                             | 通过固定样本                                                              |
| AC04            | web agent-stream.test.ts、M0 流解析覆盖 UTF-8/JSON 分片；gateway 首 tool delta 测试                                                        | 通过构造分片；非真实网络故障                                              |
| AC05            | agent-reducer.test.ts 重放不重复文本/跨会话事件；m3 刷新 E2E                                                                               | 通过                                                                      |
| AC06            | agent-connection.test.ts 游标恢复；m3 E2E 断请求重连                                                                                       | 通过本地故障注入；未测真实外网断线                                        |
| AC07            | m3.spec.ts 活动快照刷新接续，完成结果仅一次；LIVE 审批后刷新                                                                               | 通过                                                                      |
| AC08            | m3.spec.ts 延迟 A 快照切 B，旧响应不能覆盖；上下文无跨会话                                                                                 | 通过                                                                      |
| AC09            | m3.spec.ts 目标不在日志可见页，查询 context 并高亮精确 log_id；LIVE 引用来源逐条核对                                                       | 通过                                                                      |
| AC10            | m3-recovery.test.ts 取消赢过晚到模型/工具，不发布成功或新证据                                                                              | 通过注入晚到；未实际取消付费远端请求                                      |
| AC11            | m3-recovery 工具超时 FAILED、模型收到错误；m3-contracts 空日志无伪证据                                                                     | 通过注入故障                                                              |
| AC12            | m2.test.ts 不存在 ID 两次失败、无 diagnosis_result；m4 未知/日志语义门槛                                                                   | 通过，不授权伪引用                                                        |
| AC13            | m2 幂等集成；m3 E2E 响应丢失重发仍一个用户消息/结果                                                                                        | 通过，原断言保留                                                          |
| AC14            | m3-process 实际另进程启动恢复 INTERRUPTED；m3-recovery 保留历史可新 turn                                                                   | 通过，本地进程                                                            |
| AC15            | clean MOCK 标签；m2 HTTP 配置门槛、预算 tests；LIVE 官方 API 实际计数                                                                      | 通过，不由 Mock 冒充 LIVE                                                 |
| AC17            | m2/m3-approval 重复/并发批准，SQLite 唯一 child/execution                                                                                  | 通过真实 SQLite；业务模拟                                                 |
| AC18            | m2.test.ts 拒绝/过期不创建 child；快照陈旧资格校验                                                                                         | 通过                                                                      |
| AC19            | m2 E2E 与 LIVE 按钮创建并打开新模拟运行，查看终态/日志                                                                                     | 通过，模拟恢复                                                            |
| AC20（P0 部分） | m2 S00、m3 S05 服务端拒绝；最终 S05 两问无 proposed_action/按钮                                                                            | 通过；S01/02/03 留 P1                                                     |
| AC21            | m3-process 与 m3-recovery 持久化模拟进度，两次启动无重复日志/child                                                                         | 通过，本地模拟                                                            |
| AC22            | m3-contracts 替换 TaskBackend/Retriever，证据版本及绑定范围契约不变                                                                        | 通过测试替换；未连接真实 Pipeline                                         |
| AC23            | m3-contracts 可信新增 read_test_signal 经原循环成功；m4 E2E 展开真实日志工具的 ID/耗时/参数/结果，再注入陌生工具名并验证刷新后的通用卡详情 | 通过服务/渲染分层检查；浏览器陌生名称为注入，未声称默认产品注册第五个工具 |
| AC24            | m1/migration-v4 保留旧运行、会话/结论和模拟进度升级、foreign_key_check；clean 新库与重复 seed                                              | 通过真实 SQLite                                                           |
| AC02、AC16      | 缺字段额外场景与1万日志/200工具压力                                                                                                        | 不在 P0，本轮未执行                                                       |

M0 探针的字节解析测试属于历史证据；本轮共享的 model-stream 解码路径通过网关分片回归与实际 LIVE 使用，未额外宣称重跑了所有历史探针命令。

## 已知限制与交付状态

- 已列 P0 AC 在上述检查中通过。真实网络故障、跨浏览器、生产负载、保留集和模型稳定性未验证；Mock 注入不能替代这些。
- 最终 S04 仍依赖输出修复才查询日志；LOG 类型门槛保证来源存在，不是通用的自然语言事实校验。追问有重复清单和内部 eligibility 术语，后续可在开发集改善，不能再把同六问调参结果当独立保留集准确率。
- 工具轨迹已补齐 PRD §5.5 的元数据与参数/结果展开；旧历史只有计数摘要时保留摘要，不编造缺失输出。SSE 原始事件目前保留全部，未实现清理后游标 410 的策略，不宣传完整生产底座。
- 模拟器、会话/事件恢复已实现；模型 loop 不保存 plan/working_memory/checkpoint，不提供中断后的 Continue。运行错误后可以新 turn 提问，不能冒称从失败执行步骤续跑。
- CI 文件、本地等价检查与代码087da3b的实际远端通过结果齐备；所有 M3 本地修改已保留在交付提交中。用户已人工确认 M4/P0，本次没有实施 P1/P2 或真实执行器。

人工复核入口保留：观看录屏、查看最终六问回答与失败基线；亲自操作时使用新建演示 S04，提问、点击引用两次展开/收起、申请和批准模拟重试、打开新运行、刷新；S05 提问/请求重试应保持 UNKNOWN 且无按钮。用户已确认上述本地演示与边界，真实上游恢复未纳入此次验收。

## 交付后的展示调整（2026-10-01）

用户要求只展示最终答案，并慢慢显示。页面现隐藏未校验初稿与修正片段，收到已校验结果后对当前提交的 turn 分批展示，历史直接恢复；事件/快照重放不重播，会话卸载停止计时器。前端21/21、Chrome MOCK17/17（54.2秒）、前端typecheck/lint/build通过，定向包含 message.reset 与刷新。该调整没有改变后端校验或新增模型请求；本文 LIVE 六问、耗时和录屏均属于此前版本，不能当作新展示效果的实录。完整取舍及复核见进度与工程案例十一。
