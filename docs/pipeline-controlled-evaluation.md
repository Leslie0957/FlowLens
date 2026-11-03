# 候选 SQL 鲁棒性与受控 LIVE 执行器

2026-11-03 首次保留集 LIVE 已获明确授权并执行：H01/H03 自动检查通过，H02 因缺少原生工具调用和合规最终答案失败，共 10 次真实请求，没有补跑。见[首次保留集 LIVE 结果](pipeline-holdout-first-live-result.md)。以下准备及早期阶段记录按当时状态阅读。

2026-11-03 更新：新增[保留集首次验收入口与计划](pipeline-holdout-acceptance.md)，默认开发集行为不变；必须显式选择保留集和案例，LIVE 另有独立授权检查。已完成离线回归，尚未运行保留集 LIVE。下文仅开发集和保留集次数为 0 的限制描述保留对应阶段背景。

当前授权更新（2026-10-30）：用户明确给予 FlowLens 测试所需 DeepSeek 调用的持续授权，不再逐次请求人工批准。后续由执行者设置显式 LIVE 开关并为每次实际运行生成独立 approval-id，继续保留案例范围、有限预算、停止机制和记录。下文早期“等待逐次授权”的文字保留为阶段历史；持续授权不等于无限循环、自动调答案或解除冻结保留集约束。

后续新增[评估层 Prompt 变体实验](pipeline-prompt-experiments.md)：可用 `--prompt-variant=grounded-actions-v1` 显式选择，默认 baseline 与生产 Prompt 不变。计划与请求日志保存实际变体及 hash；旧阶段结果不覆盖。

第三阶段只修改评估代码、测试和文档。没有改生产 Agent/Prompt、MCP、SQL 白名单、冻结案例及数据或历史报告；本轮真实模型 API 调用为 0，没有执行保留集 Agent。

## 鲁棒性数据与参考规则

v1 的固定数据和保留数据都有四个正确事件。保留数据中速度 0.9999 的记录不足三秒，因此错误阈值 `<0.9995` 不会改变正确集合；`LIMIT 4` 也不会截断四条结果。

新增独立的 `fixtures/evals/pipeline-robustness-v1.json`，不修改冻结文件。生成器 `scripts/pipeline-robustness.mjs` 提供以下五组数据：

| 数据集         | 源行数 | 预期结果数 | 检查目的                                               |
| -------------- | ------ | ---------- | ------------------------------------------------------ |
| boundary-grid  | 84     | 32         | 速度阈值上下、三秒上下、零时长及长时段的交叉组合       |
| reordered-grid | 84     | 32         | 改变 ID/顺序，重复样本标识，避免依赖预置 ID 或结果顺序 |
| zero-results   | 3      | 0          | 合法零结果及不应选入的行                               |
| one-result     | 3      | 1          | 单结果与精确三秒                                       |
| shared-sample  | 6      | 5          | 同样本多个事件、超过四条结果、不同车系                 |

速度类包含 0.9994、0.9995、0.9996、0.9999、0.999999、1、1.000001；每类与合格/不合格时长组合，避免仅增加无效短时数据。时长包括 0、1、2999999、3000000、3000001、9000000、9000001 微秒。

数据类的人工 membership 标签生成预期事件 ID；另一个整数时长参考规则重新计算并核对这些 ID。任何标签/规则不一致直接失败。实际候选通过原有 SQL 白名单后在独立 SQLite 执行，比较完整字段、类型和值的多重集，不按特定 SQL 字符串拦截，也不调用生产 oracle()。

每个候选的三项结果分别保留在 `candidate_validation.fixed`、`holdout`、`robustness`。新增数据仅供候选生成后的评判，不能由 Agent 工具读取。鲁棒性失败记为 ROBUSTNESS_CANDIDATE_INVALID，不改诊断标签、不扩大授权，也不把测试验证结果当成根因正确率。

```powershell
# SQLite-only 矩阵，没有 Agent 或模型调用
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-robustness.mjs
```

矩阵包含 2 条正确/等价候选和 9 条错误候选：窄速度阈值、LIMIT 4、速度等号、时长严格大于、时间单位错误、遗漏时长、AND 改 OR、虚增时长上限、错误起点值。每条错误候选至少由一组数据识别；正确 SQL 及不同排序/条件顺序均可通过。有限等价类仍可能遗漏更精细阈值、更高 LIMIT 或条件组合，不证明 SQL 的一般语义正确性。

## 入口与三种模式

新入口 `scripts/eval-pipeline-controlled.mjs` 不替代原有 MOCK-only 入口。默认只输出计划，不执行；必须明确指定开发集案例 ID。未知、重复、H 开头的保留集 ID、G01、空选择或 all 均拒绝。

从项目根目录执行，PowerShell 下必须给逗号列表加引号：

先按 README 安装依赖并构建 contracts（`pnpm --filter @flowlens/contracts build`）。不需要启动 Web/后端服务，也不依赖 server/dist；执行记录会保存实际加载的 contracts 编译文件 hash 与快照。

```powershell
# 默认 PLAN_ONLY；不会读密钥、创建数据库或调用模型
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs '--cases=D01,D02,D04,D07'

# 完整离线协议模拟：实际 Agent、MCP、SQLite，HTTP 使用内置 SSE 替身
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs --simulate '--cases=D01,D02,D04,D07'
```

MODE 为 PLAN_ONLY / SIMULATED_LIVE / LIVE。原有内置 MOCK、故障注入网关仍单独标识。模拟请求数不计为真实 API 请求，模拟用量不计费用或模型准确率。

### LIVE 授权与命令

以下命令本轮没有执行，必须等待用户明确授权。需配置有效模型密钥，并设置新的 `FLOWLENS_EVAL_LIVE_APPROVED=1`；旧 LIVE_APPROVED 或 unlimited 本身无效。

```powershell
# 仅在明确批准首次批次之后运行
$env:FLOWLENS_EVAL_LIVE_APPROVED = '1'
try {
  pnpm --filter @flowlens/server exec node --env-file-if-exists=../../.env.local --import tsx ../../scripts/eval-pipeline-controlled.mjs --execute-live '--cases=D01,D02,D04,D07' --model=deepseek-flash --approval-id=first-dev-live-001
} finally {
  Remove-Item Env:FLOWLENS_EVAL_LIVE_APPROVED -ErrorAction SilentlyContinue
}
```

`--execute-live`、新授权开关、显式案例和 approval-id 缺一不可。执行前打印完整计划和版本。授权记录用排他创建绑定计划 hash；同一 ID 一旦使用，不论成功失败都不能自动重跑。新的批次需重新获得用户授权并使用新 ID。

沿用本地模型标识 deepseek-flash，并不表示已在线验证其鉴权、可用性或不可变修订。endpoint 限定现有官方 DeepSeek 地址。其他提供商不在本阶段范围。

## 预算、隔离与停止

| 限制                    | 当前值                           |
| ----------------------- | -------------------------------- |
| 每例模型请求/Agent 步数 | 最多 6，含格式纠错；不是最低步数 |
| 整轮模型请求            | 最多 24                          |
| 每次 max_tokens         | 1024，显式写入实际 HTTP 请求体   |
| 每例工具调用            | 最多 8                           |
| 单请求/单例/整轮时间    | 30 / 90 / 360 秒                 |
| 消息上下文/完整请求体   | 32 / 64 KiB；完整请求含工具定义  |
| 响应原始流              | 最多 256 KiB                     |
| HTTP 自动重试           | 0                                |
| 保留集 Agent            | 0                                |

以上为默认 `first` 档，其配置只能调低，不能通过配置文件扩大。新的 `effect` 档见下节，必须显式选择。单例/全局计数在调用前预留，失败也消耗次数；不能切换案例重置。生产 Agent 的原生 LIVE 预算仍保留，并在独立 CLI 进程中暂时设置为有限值，结束后恢复。网关始终提供给 Agent，不走会读取旧配置的默认网关分支；离线测试核对实际请求体的 max_tokens 与所选档位一致。

### 效果评估档与预算对照

2026-10-30 首次 LIVE 的 D07 六次均调用工具，没有留下最终回答机会。因此不能据此断言模型不会处理目标冲突。新增显式 `--profile=effect`；默认 `first` 及其历史报告不改。报告中的 `limit_profile` 与生效参数参与授权计划 hash，未知档位拒绝。

| 参数                                          | first（默认） | effect          |
| --------------------------------------------- | ------------- | --------------- |
| 每例 / 全局请求                               | 6 / 24        | 20 / 80         |
| 每请求输出 tokens                             | 1024          | 2048            |
| 每例工具调用                                  | 8             | 30              |
| 单请求 / 单例 / 整轮秒数                      | 30 / 90 / 360 | 60 / 300 / 1200 |
| 连续无进展上限                                | 3             | 3               |
| 消息/请求字节量、SQL/工具权限、自动 HTTP 重试 | 原约束        | 保持不变        |

每档只允许调低。调用次数是上限，不要求读全工具，也不强制最后一轮总结。没有改 Prompt、模型、案例或 evidence-rubric-v2；这次只变执行预算。若一次同时放宽多个执行参数，不能将任何效果变化单独归因于请求轮数；LLM 多次调用本身也有变异。

```powershell
# 仅查看 D07 较宽松预算，零 API 请求
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs --profile=effect --cases=D07

# 仅离线模拟
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs --profile=effect --simulate --cases=D07
```

下一次建议只对 D07 执行一次 effect LIVE，以核对能否自然结束；尚未执行，需要新的一次性授权。单例实际可用请求上限是 20，不会因为全局 80 而运行 80 次。输出配置上界 40960 tokens，不是费用预估。先前 first-dev-live-001 已使用，不能再次使用。

未来经明确批准后的命令使用绝对环境文件路径，避免前次相对路径未找到的提示；密钥不得打印：

```powershell
# 尚未执行，仅供本次 D07 对照获得明确授权后使用
$env:FLOWLENS_EVAL_LIVE_APPROVED = '1'
try {
  pnpm --filter @flowlens/server exec node '--env-file=D:/Downloaad/FlowLens/.env.local' --import tsx ../../scripts/eval-pipeline-controlled.mjs --profile=effect --execute-live --cases=D07 --model=deepseek-flash --approval-id=d07-effect-live-001
} finally {
  Remove-Item Env:FLOWLENS_EVAL_LIVE_APPROVED -ErrorAction SilentlyContinue
}
```

离线回归用确定性替身证明：first 在六次真实 MCP 观测后以 MODEL_REQUEST_LIMIT 终止；effect 能在同一 Prompt 下给出第七次最终人工建议；反复读取同一 SQL 的 effect 则仍在四次调用时以 REPAIR_NO_PROGRESS 终止。这只证明预算与停止机制，不是 LIVE 成功预测。

每例创建独立 app.sqlite、源/目标库、目录及会话，不读取 APP_DB_PATH 指向的现有库。模型只有原来的六个只读工具；候选测试审批只授权隔离验证，不授权目标提交。固定数据、保留数据和鲁棒性数据分别评判；即使鲁棒性失败，也保留原生校验结果供对照，绝不据此写入用户项目。

时间限制覆盖请求、整个案例和批次。达到期限或收到 SIGINT/SIGTERM 即取消，不再开始模型调用；保存记录、关闭 SQLite/MCP 的收尾可能稍晚完成，不承诺操作系统 I/O 被硬实时中断。即使测试替身不响应取消，请求等待也有独立超时竞争，迟到结果不能变成成功。

鉴权、协议、服务错误、预算、版本漂移或隔离异常会停止相应执行，剩余案例明确标为 NOT_RUN。正常业务诊断失败在原预算内保留并可继续其他已授权案例。不自动补跑、调 Prompt、改答案或运行保留集。运行前已输出的完整计划及失败轨迹保留，不能把平台拒绝候选当成 Agent 动作正确。

## 记录与复核

输出位置：`logs/pipeline/controlled/<simulation|live>-<随机后缀>/`，包含：

- plan.json、report.json、review.json：整批计划、每例状态、请求计数和未知项。
- source-snapshot/：本次运行的评估、Agent、工具、网关、数据、规则及锁文件快照；每次调用前校验源版本未漂移。
- D01 等案例目录：原始 SSE（含中断时已有片段）、不含 Authorization 的请求 JSON、响应标识和用量、逐请求状态。
- 各案例子报告：实际执行、持久工具/证据、最终诊断、候选、三组独立校验及平台结果。隔离数据库保留在报告指明的操作系统临时目录。

保存 requested_model 与服务实际返回的 model/id/fingerprint/model_revision（如果存在）。没有返回的模型修订、用量或费用保持 null/unknown，不能由模型别名推断。原始文本、工具调用及部分流不因格式失败丢弃；硬杀进程或磁盘不可写仍只能保留最后成功写入的部分。

汇总 usage 是提供商已返回字段的**小计**，另列 unknown_requests。接口中断后没返回用量，不等于没有计费；原生 Agent 的默认零计数不能当成账单依据。密钥和 Authorization 头不写入日志，HTTP 错误体不复制到报告。

```powershell
node scripts/review-pipeline-eval.mjs <运行目录>/report.json <运行目录>/review.json
```

人工复核区分根因、证据充分性、动作和候选正确性。诊断准确率初始为 null；未完成全量复核不把成功子集作为整轮结果。保留 NOT_RUN、超时与基础设施失败的原因，不把它们悄悄删去或统一归咎于模型。

## 首次 LIVE 计划与成本

推荐 D01 → D02 → D04 → D07，各一次：确认不存在列、别名错误、空表达式与遗漏字段的区分，以及目标冲突的保守交接。D07 若提出 SQL_PATCH，即使平台正确拒绝，也仍是 Agent 决策不符合预期。

最大请求 24，输出配置上界 24576 tokens。这不是总费用上限。估算需要当次模型/币种/单价版本、各轮输入及工具上下文 token、缓存命中计价、实际输出，以及断流请求的计费信息。当前没有可靠单价快照或真实输入用量，费用估计保留 null。模型可能提前结束，实际次数也可能小于上限；不能用离线 16 次模拟推导 LIVE 次数、时延或费用。

## 本轮离线验收

结果和原始文件定位见 `docs/evals/pipeline-phase3-summary.json`。包括独立 SQL 矩阵、14 项新增测试及相关回归、四例公开 CLI 模拟。第一次未加引号的 PowerShell 列表被改写并在执行前拒绝；加引号后模拟通过。没有执行 LIVE 或保留集 Agent。

真实模型的诊断能力、提供商可用性、线上计费、模型修订可得性仍未验证。所有测试通过后停止，等待明确的 LIVE 授权。
