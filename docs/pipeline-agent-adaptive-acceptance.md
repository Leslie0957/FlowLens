# Pipeline Agent 自主取证实施验收

2026-10-08，按 `pipeline-agent-adaptive-plan.md` 在当前未提交工作区实施。原有合并审批、结果页、同步与数据库页修改保留；没有 reset、提交 Git、修改 `.env.local` 或连接用户业务库。此前固定六工具与八请求的验收属于历史版本，本记录描述当前实现。

## 当前行为

初始上下文仅包含目标、绑定标识及持久化执行的实际状态/失败阶段/错误码/错误消息，登记为 `INITIAL_FAILURE`。没有模板名、源码、Schema、输出或预置修复答案。六个工具全部可用，由模型选择；每次实际结果通过对应 `tool_call_id` 返回，再请求模型决定下一步。单轮多个调用逐个执行和回传。

SQL_PATCH 必须引用本版本 get_sql 和实际失败依据；证据 ID 非空、唯一、属于本会话的执行/版本。候选限定 task.sql、绑定 base_hash，服务端计算内容 hash 与 Diff。其余工具没有统一必读要求；单个 get_sql 加初始失败证据可以生成候选。初始证据支持保守 MANUAL_REQUIRED，candidate=null，不创建新版本、执行或写入。已失败执行的 NO_CHANGE 被拒绝。

非法参数保存 FAILED 和错误对象，按调用 ID 返回并允许有限纠正。未知工具、权限/版本绑定失效明确拒绝。最终回复仅一次纠正，反馈针对具体结构或来源问题，不补充正确 SQL 或证据 ID。`model_turns` 保存实际收到的原始回复与调用，`response_checks.response_text` 保存不合格最终回复，usage 按实际响应累计。

默认上限如下；配置以正整数解析，构造器可覆盖，每次新会话保存有效快照。旧记录 diagnosis_limits=null，界面明确上限未知，不按新配置推断。

| 环境变量 | 默认值 |
| --- | ---: |
| FLOWLENS_PIPELINE_DIAG_MAX_REQUESTS | 100 |
| FLOWLENS_PIPELINE_DIAG_MAX_TOOL_CALLS | 200 |
| FLOWLENS_PIPELINE_DIAG_TIMEOUT_MS | 900000 |
| FLOWLENS_PIPELINE_DIAG_MAX_STALL_ROUNDS | 3 |
| FLOWLENS_PIPELINE_DIAG_MAX_CONTEXT_BYTES | 262144 |

每次 LIVE 请求前仍须共享预算 reserve。上述配置不会扩大付费授权；LIVE 评测默认独立 cap=8，可显式设置 FLOWLENS_PIPELINE_EVAL_LIVE_MAX_REQUESTS，仍取与既有授权的较小值。没有修改用户配置或发起付费 LIVE 调用。

无进展按工具名、规范化参数、绑定版本和规范化实际输出的指纹判断。call ID、证据 UUID、轨迹元数据不参与；实际输出中的业务时间保留。重复或交替旧观测达到阈值以 REPAIR_NO_PROGRESS 停止。此机制只检测客观重复，不声称判断所有语义无进展。工具仍沿用空参数，不新增日志分页或范围读取能力。

上下文按序列化消息的 UTF-8 字节数限制，不是 token 精确计数；超限不静默删证据或工具协议。总时限既由取消计时器控制，也在动作边界检查单调时钟，避免即时 Promise 使计时器延迟时绕过时限。取消、超时、预算、上下文和重启中断保留明确终态，迟到回复不重新发布候选。

界面显示实际调用顺序、重复名称、失败和模型请求序号，使用“正在取证、已完成 N 次调用”；初始失败弹窗注明来自持久化执行。保留 SSE 游标/恢复、项目隔离及 mutationKey。一次批准仍绑定具体候选和批准时目标 hash/version；旧的仅验证授权不升级。本次没有增加验证失败后的自动修复循环。

## 两条可复查的工具反馈路线

原始记录：[feedback-trajectories.json](evals/pipeline-adaptive-20261008/feedback-trajectories.json)。其中 `requests[0..2]` 是网关每次实际收到的完整消息；`repair.tools` 保存实际 ToolRegistry 调用、结果、call ID、证据 ID 与轮次；`executions` 保存真实 SQLite 查询、独立 oracle、验证和预检；`batch` 为真实撤销凭证。

已额外逐条核对每次后续请求中的 assistant 调用与 tool 消息一一对应，返回正文与保存的实际 tool.result 完全相同、证据存在、候选 hash 正确及提交/撤销凭证真实：[轨迹复核结果](evals/pipeline-adaptive-20261008/trace-verification.json)。可在新的输出目录重跑受控用例生成新的记录，原报告保留：

```powershell
$env:FLOWLENS_ADAPTIVE_TRACE_DIR = Join-Path (Get-Location) 'logs/pipeline/adaptive-proof'
pnpm --filter @flowlens/server exec vitest run test/pipeline-adaptive.test.ts
```

| 受控故障 | 模型请求 1 | 请求 2 实际收到的资料及选择 | 请求 3 |
| --- | --- | --- | --- |
| 列不存在 | 初始 SQLite 报 no such column，选择 get_sql | SQL 实际含 speed_kph，选择 get_schema；返回源表确有 speed_mps | 用错误中的列名与 Schema 中的真实列生成候选 |
| 输出契约失败 | 初始校验错误，选择 get_output_preview | 实际 columns 含 vehicle_type、validation.passed=false，选择同轮 get_sql + get_task_contract | 两个调用 ID 均有对应结果；从实际缺失/多余字段生成候选 |

两条路线均为三次模型请求，工具分别为 2 次和 3 次，不调用全部六工具。测试在每一步断言前一轮实际结果及 call ID 完整进入下一轮，后续选项依赖这些返回字段；候选通过绑定校验。未批准时执行数仍为 1、目标为 0；测试授权后真实隔离验证→预检→事务入库 4 行→恢复 0 行，凭证分别 COMMITTED/RESTORED。

这些网关是确定性测试策略，工具与 SQLite 执行是真实的。它们证明反馈循环、协议、工具选择分歧和授权后结果成立，不作为 LIVE 模型自主推理质量或准确率的证据。生产取证循环没有 A/B 模板分支、错误字符串路线或预置正确 SQL；MOCK fixture 的答案单独位于 pipeline-mock.ts。

## 本次实际检查

| 命令 | 本次结果 |
| --- | --- |
| pnpm typecheck | 通过，最终计时器类型修正后重新执行 |
| pnpm lint | 通过 |
| pnpm test | 服务端 142/142（23 文件）；前端 39/39（13 文件） |
| pnpm build | 通过，最终版重新构建 |
| pnpm test:e2e -- tests/e2e/pipeline.spec.ts tests/e2e/pipeline-diagnosis.spec.ts tests/e2e/pipeline-result.spec.ts tests/e2e/pipeline-sync.spec.ts tests/e2e/pipeline-presentation.spec.ts tests/e2e/pipeline-table.spec.ts | 12/12，45.317 秒，0 skipped/flaky/unexpected |
| pnpm check:pipeline:start | PASSED；构建版随机端口、独立测试库、一次审批、COUNT=4、撤销 COUNT=0、刷新凭证、无 pageerror |
| git diff --check | 通过 |

机器记录：[checks.json](evals/pipeline-adaptive-20261008/checks.json)，[本次浏览器报告](evals/pipeline-adaptive-20261008/e2e-report.json)，[构建启动报告](evals/pipeline-adaptive-20261008/build-start-report.json)。原启动日志/截图/完整状态在 `logs/pipeline/build-start-2026-10-08T07-11-02-255Z/`，E2E 原报告在 `logs/m5/e2e-2026-10-08T07-06-25-303Z.json`。

新增受控用例覆盖：初始证据建议、工具子集补丁、缺少基础 SQL、伪/跨会话/版本错误/重复引用、阶段及动作不一致、多调用协议、参数纠正与未知工具、版本变化、连续及交替重复、允许有限重复、超过八请求完成、默认 100 请求没有第 101 次、失败工具计入上限、上下文超限、取消/超时/迟到回复、同步返回超时、共享 LIVE reserve、配置快照和历史默认值。原授权、真实 oracle 拒绝、目标变化、第二行 INSERT 失败回滚、取消、重启凭证核对、旧审批不升级和撤销测试继续通过。

初次相关测试有一项预期需修正：5,000 字节上下文实际在第二轮后超限，调整测试阈值为 4,000 后证明下一次请求之前停止。前端新增检查曾将相邻标题拼接文本误匹配为“取证已完成”，改为检查进度元素。时限改造的计时器初始化出现一次类型检查错误，修正为可选句柄后类型检查和最终构建通过。没有将这些失败报告记作通过；上表为修正后的真实执行结果。

限制：本次没有新增付费 LIVE 样本，未运行全仓库浏览器套件；共享网关、流解析器、ToolRegistry 和旧 Agent 未修改，执行的是计划指定的六组 Pipeline 浏览器回归。来源校验不能自动证明自然语言因果结论；业务语义仍由真实执行器和独立 oracle 验证。
