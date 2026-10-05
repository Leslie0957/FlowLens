# FlowLens M6：本地任务执行与受控修复

版本：v0.2-M6-draft-1；日期：2026-10-03。**状态：2026-10-05 用户确认 M6.1 人工验收通过；M6.2 已开发，用户表示暂未发现问题并要求进入下一步；M6.3 已实施有限循环，等待人工验收。**

本稿最初只用于文档交接。后续用户明确授权本会话实施 M6.1；实际结果见 [验收计划](m6-acceptance-plan.md)。M0～M5 的产品事实仍以 [v0.1 PRD](FlowLens_PRD_v0.1.md)、[进度](implementation-progress.md)和实际验收记录为准。

## 1. 目标与实施顺序

将现有“查询已保存证据 → 诊断 → 审批 → 模拟重试”向“真实本地执行 → 诊断 → 展示代码补丁 → 审批应用 → 实际验证 → 有限继续修复”扩展。

这里的“真实”指本机子进程实际执行任务代码、实际查询 SQLite 并产生结果。输入仍为合成订单数据，不连接真实业务服务；本地验证成功不能证明生产故障已经修复。

| 阶段 | 必须交付 | 阶段边界 |
|---|---|---|
| M6.1 执行基础 | 专用工作目录、可信任务运行器、运行/日志/产物持久化、超时/取消、本地执行页面 | 用户按钮触发固定任务；无模型修复、Diff 应用或自动循环 |
| M6.2 单次受控修复 | Agent 查询本地任务证据和允许读取的源码，生成补丁、展示 Diff、人工审批、应用和实际验证 | 一次批准只授权一份绑定具体版本的补丁与一次验证；失败可以生成下一份待审批补丁 |
| M6.3 有限循环 | 失败结果回传 Agent，授权范围内继续尝试，轮次/预算/取消/停止记录 | 用户显式批准循环后才自动继续；进程重启后不从中断点 Continue |

先交付并人工验收 M6.1，再实施 M6.2/M6.3。用户在 M6.2 页面反馈暂未发现问题后明确要求“开始下一步”，据此实施 M6.3；该反馈尚未被记为明确的 M6.2 人工验收通过。本文中的数值和接口是设计默认值，不是实测结果或用户逐项确认过的技术选择。实现者可以调整局部命名，但必须同步文档；扩大可写文件、执行命令、自动继续权限或业务范围须先向用户说明并确认。

不在本次范围：Prefect、MCP、向量库、多 Agent、任意仓库修复、任意 Shell、生产任务连接、公网鉴权与部署、跨会话记忆、Agent checkpoint/Continue。

## 2. 首个真实任务与独立判定

首个任务为小型订单聚合 SQL 项目。任务源码修改从一个文件 `task.sql` 开始；这是实际源码变更，但不是通用 TypeScript/Python 项目修复能力。

可信运行器建立隔离的内存 SQLite，创建 `orders(order_id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)`，从固定输入读取三笔订单：

```json
[{"order_id":101,"amount":20},{"order_id":102,"amount":30},{"order_id":103,"amount":50}]
```

故障版本：

```sql
SELECT COUNT(*) AS order_count, SUM(order_total) AS total_amount FROM orders;
```

正常对照版本：

```sql
SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount FROM orders;
```

业务验收要求为恰好一行结果，`order_count=3`、`total_amount=100`。依据为上述独立输入与订单汇总需求，不由模型回答、运行器返回的 status 或被测 SQL 自行决定。

M6.1 提供“SQL 列错误”和“正常对照”两种预置项目，均实际执行。正常对照是开发者预置的验证样本，UI 必须注明“正常对照（预置）”，不能写成 Agent 已经修复。未改源码而重新运行故障项目应继续报列不存在，不能换到成功时间线。

还必须覆盖语义错误：将 `SUM(order_total)` 改为 `SUM(order_id)`，SQL 可以执行，但得到的总额不符合 100，验证必须失败。该样本在自动化测试中构造，不要求 M6.1 提供编辑器。

### 2.1 SQL 的最小执行范围

首批只允许一条与上述结构一致的聚合 SELECT：固定 `COUNT(*)`、固定结果别名、固定表 `orders`，SUM 参数为一个普通列标识符；允许空白和一个尾部分号，不允许额外语句、注释、子查询或其他表达式。列不存在由实际 SQLite 执行发现。

实现必须用明确的小语法或解析器验证完整输入，不能只判断 `startsWith('SELECT')` 或使用关键词黑名单。不执行 DDL/DML、ATTACH、PRAGMA、扩展加载或任意 SQL。需要扩展 SQL 能力时另开需求，不顺便放开。

## 3. M6.1 用户流程

1. 用户打开侧栏“本地执行实验”，选择故障项目或正常对照，创建独立项目。
2. 查看合成输入、当前 SQL 和来源标识，点击“运行任务”。创建项目本身不隐式执行。
3. 服务端创建新的 execution，快照保存源码和输入，启动可信子进程；页面显示运行状态与实际日志。
4. 终态显示进程退出码、运行错误、业务验证结果、耗时和可查看的产物。
5. 再次运行创建新 execution，绑定同一项目版本。旧 execution 的源码、日志和结果保持不变。
6. 活动执行支持取消；页面刷新恢复已保存记录，不重新启动执行。

拟定页面为 `/local`（项目列表与创建）和 `/local/projects/:projectId`（源码只读、运行记录和执行详情）；通过 `execution` query 指定历史执行。详情加载前必须校验执行归属项目，异步请求用取消和序号阻止串场。

页面明确区分三个事实：`LOCAL_EXECUTION` 表示实际本地执行；`SYNTHETIC` 表示合成输入；`LIVE/MOCK` 表示模型来源。M6.1 尚不调用模型，显示“本步骤未调用模型”，不借用全局 LIVE 标志声称模型已参与。

现有 `/runs`、`/diagnoses`、`/demo` 及 S00～S05 保持原有 FIXTURE 语义和模拟审批。新项目不混入六场景列表，也不能调用旧“批准模拟重试”来启动真实任务。

## 4. 工作目录与可信运行器

### 4.1 目录与来源

应用默认实验根目录位于数据目录下的 `local-projects/`；测试注入独立临时目录。project_id、revision_id、execution_id 由服务端生成，HTTP 和模型不能指定绝对路径、输出目录或运行器路径。

每次执行使用新的专用目录，保存当前版本 `task.sql`、`input.json` 和运行产物；用真实绝对路径、路径分隔边界和链接检查保证范围归属。拒绝目录穿越、Windows 盘符/UNC 路径、符号链接或 junction 越界。清理仅针对验证过的生成目录，首批不提供“一键删除所有缓存”。

可信运行器、验证逻辑和模板由应用交付，不能位于模型可写范围。必须同时支持 dev 和编译后的 start；构建/干净安装需要包含运行器和模板，不依赖开发机残留文件。

### 4.2 子进程

沿用现有 Node.js 24 与 SQLite 技术基础。使用 Node 子进程 API，以参数数组启动固定运行器，`shell=false`；不拼接 Shell 命令，不运行任务目录里的任意脚本或依赖安装。子进程不启动可见终端窗口。

子进程仅接收执行所需的最小环境，不继承 MODEL_API_KEY、GitHub 凭据、NODE_OPTIONS 或其他父进程敏感环境。运行器只处理已校验的 SQL 和合成输入，不允许 SQL 调用文件系统、网络或额外进程。

这属于限定任务和能力的本地执行，不宣称工作目录本身构成 OS 安全沙箱；M6 不执行模型生成的任意 JS/Python/Shell。未来若引入任意程序执行，需另行设计真正的隔离边界。

默认全局最多 1 个本地执行，单次超时 30 秒。达到并发上限返回可解释的 409 `LOCAL_EXECUTION_BUSY`，不无限排队。重复幂等请求先查已有结果，不能因为正在运行而把同一请求当作新请求拒绝或重启。

### 4.3 执行结果与停止

状态建议为 `PENDING → RUNNING → SUCCEEDED / FAILED / CANCELLED / INTERRUPTED`。成功必须同时满足子进程正常退出、结构化结果完整合法和独立业务断言；退出码 0 不自动等于业务成功。

需要分别记录运行错误、进程退出信息和验证错误。典型错误为 `SQL_COLUMN_ERROR`、`SQL_POLICY_REJECTED`、`RESULT_VALIDATION_FAILED`、`LOCAL_EXECUTION_TIMEOUT`、`LOCAL_EXECUTION_INTERRUPTED`、`LOCAL_RUNNER_ERROR`。

取消或超时必须实际终止本次进程并确认退出，迟到输出不能将终态改为成功；取消 API 可先返回停止中，但 UI 不能在进程仍运行时宣称“已停止”。不根据 PID 单独杀进程，以免重启后误杀复用 PID 的其他程序。

服务退出应终止自身管理的活动子进程并保存状态。服务重启后，将遗留 PENDING/RUNNING 标为 INTERRUPTED，保留日志、版本和产物，不自动重跑。需验证服务异常退出时任务不会无界存活：运行器自身应有期限，并采用父进程生命周期通知或等价可验证机制。此处是执行状态收尾，不是恢复 Agent 思考或中断点 Continue。

## 5. 持久化、协议与审计

### 5.1 与现有协议的关系

当前 `Run` 与 capabilities 的任务来源固定为 FIXTURE；`task_run` 有 FIXTURE CHECK，diagnosis_session 外键引用 task_run。**不能只把 TaskBackend 替换为本地数据，然后宣称平台已支持真实执行。**

M6.1 使用独立契约和持久化表，保留原有 Run、审批、模拟器和来源标识。建议增加一次版本化迁移，建立以下实体；版本号须在实施时以当时 PRAGMA user_version 为准，不修改已经应用的旧迁移。

| 实体 | 核心字段与约束 |
|---|---|
| local_project | id、template_id、name、input_source=SYNTHETIC、current_revision_id、created_at |
| local_revision | id、project_id、parent_revision_id、源码/输入快照或稳定位置、SHA-256、创建来源；版本不可变 |
| local_execution | id、project_id、revision_id、status、created/started/finished_at、exit_code、termination_reason、验证结果、runner_version、validator_version；一次请求只生成一个 execution |
| local_execution_log | id、execution_id、seq、timestamp、level、step、message；UNIQUE(execution_id,seq) |
| local_artifact | id、execution_id、允许的产物名、内容hash、大小；产物与执行绑定 |

幂等可复用 request_dedup 的独立 scope，不复用模拟运行 scope。请求键与 body/project/revision 的摘要绑定，同键不同内容返回 409，HTTP 超时重试不会启动第二个进程。持久化/工作目录/启动之间失败要落到可解释的终态，不能返回成功但没有执行记录。

建议 API（均为计划，不是现有接口）：

| 方法与路径 | 作用 |
|---|---|
| GET /api/v1/local-projects | 有界分页项目列表 |
| POST /api/v1/local-projects | 选择注册 template_id 创建项目，要求 Idempotency-Key；不执行 |
| GET /api/v1/local-projects/:id | 获取项目及当前版本的只读源码/输入 |
| POST /api/v1/local-projects/:id/executions | 快照当前版本并实际运行，要求 Idempotency-Key，不接受 command/path/env/SQL 正文 |
| GET /api/v1/local-projects/:id/executions | 分页执行历史 |
| GET /api/v1/local-executions/:id | 状态、版本hash、退出与验证结果 |
| GET /api/v1/local-executions/:id/logs | 序号游标获取有界日志 |
| GET /api/v1/local-executions/:id/artifacts/:artifactId | 获取当前执行登记的有界产物，不接受文件路径 |
| POST /api/v1/local-executions/:id/cancel | 幂等请求停止当前执行 |

所有 body/query 经共享 schema 校验，错误沿用 request_id 格式。快照/产物读取校验项目与执行归属；对不存在、越界、冲突和忙碌给出稳定错误，不泄漏绝对路径。

### 5.2 日志与产物上限

设计默认：日志单条最多 2KB，单次总输出最多 200KB；超过上限终止执行并记录 `LOCAL_OUTPUT_LIMIT`，不能静默截断后判为成功。页面日志窗口最多 200 条。产物限已登记的 SQL/输入快照与结果 JSON，每项最多 64KB，首批无任意文件下载。

结构化服务日志记录 request_id、project_id、revision_id、execution_id、状态、错误、耗时和大小，不输出密钥、完整 Prompt 或未限制正文。执行日志是可追溯的实际进程输出，不采用固定时间线生成。产物、实验目录和用户历史均位于 Git 忽略的数据/日志范围，测试使用隔离库。

## 6. M6.2 单次修复设计

本节为 M6.2 已实现范围，M6.1 未提前实现。M6.2 开始时补齐本地诊断与既有 Agent 持久化/FK 的适配设计：保留目标类型、project/run/revision 绑定、证据版本、会话隔离和旧会话兼容；不能宽松解析旧 FIXTURE 契约绕过检查。

模型只获得当前项目允许读取的 `task.sql`、已登记执行日志、结构化结果和允许的任务说明；新增源码引用需绑定 revision/hash。沿用 ModelGateway 与工具注册思路，不把任意文件工具或 Shell 暴露给模型。

流程：失败执行 → Agent 查询证据 → 提交结构化补丁候选 → 服务端验证路径与版本 → 前端展示精确 Diff → 用户批准 → 生成新不可变版本 → 实际执行与验证 → 展示新旧版本和结果。

首批只允许改 `task.sql`，一次一个文件、补丁正文最多 8KB；input、runner、验证器、测试、配置、依赖和应用代码不可写。补丁格式需在实施文档中固定，首批建议用“原始内容hash + 完整新文件内容”表达，再由服务端计算 Diff；不能相信模型提交的 Diff 与实际应用内容一致。

审批绑定 project_id、base_revision_id、base_hash、candidate_hash、验证命令ID和有效期（默认10分钟）。同一审批只能应用一次并创建一次验证执行；拒绝/过期/版本变化/篡改后无文件变更和执行。聊天中的“帮我修复”“同意”不能代替页面批准。文件写入与DB记录使用明确的版本提交步骤；部分失败不能遗留“已批准且已成功”的假状态。

测试失败或取消时保留候选及实际结果，原版本与原失败执行不改写。模型可以继续提出新候选，但新候选需要新的审批；M6.2 不隐式进入循环。

## 7. M6.3 有限循环设计

用户单独选择“批准有限修复循环”，看到可改文件、可执行命令、最多轮次、时限和用量计数，明确授权后才开始。用量记录实际请求次数和usage tokens，提供商未返回金额时不虚构人民币费用。该授权只覆盖当前项目及固定能力。

设计默认最多 3 次候选应用/验证、整个循环最多 10 分钟；每次模型输出最多 2048 tokens，每轮沿用最多12个实际模型请求/8次工具调用/120秒，包含工具循环、请求重试与格式修复。同一循环累计最多36个实际模型请求，不能通过新建turn或重启重置。持续 LIVE 总额度授权不等于无限修复循环。

每轮必须保存实际补丁、基准与新版本hash、日志、退出码、独立验证结果、实际模型请求和usage。失败结果回传后生成下一份候选；通过全部独立断言才停止为 SUCCEEDED。达到轮次、请求或时间限制、取消或不可恢复错误时明确停止，不能写“最终成功”或只选择成功轮次展示。

服务重启将活动循环标为 INTERRUPTED，不自动恢复或继续应用；用户可查看旧记录，另行启动新任务。跨进程checkpoint/Continue依然暂缓。

## 8. 验证与交付要求

详细场景见 [M6 验收计划](m6-acceptance-plan.md)，实现交接见 [M6 AI 交接](m6-ai-handoff.md)。每一阶段先固定可观察的验收目标，再实现并验证；关键副作用与状态约束优先写能实际失败的测试。

M6.1 自动化必须使用真实子进程和临时 SQLite，不 Mock 运行器来证明真实执行。故障、正常对照、语义错误、重复请求、超时/取消、重启收尾和历史不变均需证据。诊断/修复阶段分别记录 MOCK 协议测试与真实 DeepSeek 质量，后者不能用 Mock 宣称通过。

旧 P0/M5 回归、typecheck/lint/build、必要 Chrome E2E 与实际 start/preview 均按影响面验证；共享schema/迁移改变后不可只测新页面。CI 不读 LIVE 密钥、不调用付费 API。本机历史和持久 LIVE 配置保留，清理测试缓存不等于删除用户聊天。

每阶段交付记录包含源码版本、启动方式、实际测试计数、失败/未执行项、真实执行证据、已知问题与人工操作清单。自动化通过后状态为“等待人工验收”；用户确认后再进入下一批。不得把本文中的验收表填成已通过。
