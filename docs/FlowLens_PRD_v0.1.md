# FlowLens 数据任务智能诊断工作台 PRD

版本：v0.1-r2 可实施需求稿（基本闭环 + 可扩展底座）  
编写日期：2026-09-26  
项目性质：个人项目，服务于前端 / AI 全栈偏前端求职  
当前状态：需求与技术方案设计，本文不代表功能已经实现

## 0. 文档使用规则与决策记录

### 0.1 本文的地位

本文面向后续实现项目的开发者和 AI，包含产品需求、建议技术方案、接口契约及验收标准。全文中“必须”表示对应阶段的验收要求，“建议”允许实现者根据实际代码给出理由后调整。

本项目采用此前讨论收敛后的方向：以 Vue3 工作台体现前端开发能力，接入基础 Agent 诊断能力。早期 `AI_Pipeline_Ops_Agent_项目展示计划.md` 中的 Prefect、复杂调度、多 Agent、自动修改代码和完整评测看板属于历史构想，不作为本版实现要求。二者冲突时，以本文为准。

不得将本文中的计划、目标数值、模拟案例写成已完成成果或生产实测数据。

2026-10-03 M5交付后，M6的独立扩展设计见 [M6需求稿](FlowLens_M6_PRD.md)。后续 M6.1 已通过人工验收，M6.2 已开发待人工验收；它们不改写本文的P0/M5范围、模拟事实或既有验收。M6.3 尚未实现。

### 0.2 已确认选择与实施假设

以下表格区分用户已经确认的决策和暂定方案。后续修改必须同步更新相关章节。

| 决策                     | 推荐默认值                                                 | 状态                                 | 对实现的影响                                     |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------ | ------------------------------------------------ |
| D01 前端技术栈           | Vue3 + TypeScript + Vite + Pinia + Element Plus            | 用户已确认                           | 组件、状态管理与测试方式                         |
| D02 任务数据来源         | 固定任务数据与日志，优先完成前端                           | 用户已确认                           | Node 场景模拟器，无需真实 Python/SQL 执行环境    |
| D03 首版是否支持重试审批 | 需要；首版包含诊断—审批—重试闭环                           | 用户已确认                           | 第 12 节必须实现，业务任务重试为演示模拟         |
| D04 模型与预算           | 真实模型 API + mock 开发测试模式                           | 用户已确认；具体提供商与预算后续配置 | 需在 M0 验证流式输出和工具调用兼容性             |
| D05 部署范围             | Windows 本地开发、单用户演示                               | 暂定                                 | 不先建设多租户或公网账户体系                     |
| D06 Agent 基座           | 参考/复用 claude-code-from-scratch 的 TypeScript 实现      | 已有讨论方向，接入方式待源码验证     | 不要求直接搬入所有 CLI、文件和 Shell 能力        |
| D07 交付原则             | 优先跑通基本闭环，同时交付较高完成度、可扩展的底座         | 用户已确认                           | 分为 P0 底座验收和 P1 展示增强，关键质量不能后补 |
| D08 仓库组织             | 独立 FlowLens 仓库，引用/抽取必要上游模块并记录来源 commit | 技术默认方案                         | 业务代码与教程章节结构分离，不整仓混改后失去边界 |

首版页面必须持续显示“演示任务数据”；重试结果标记“模拟执行”。数据来源与模型来源分别展示：即使使用真实 LLM，任务日志依然来自 fixture。审批、状态流转、持久化和幂等校验需要实际实现，不能仅前端切换标签。

## 1. 背景与产品定位

### 1.1 背景

项目灵感来自长安汽车算法实习中参与的数据挖掘 Pipeline 自动化工作。个人项目探索任务状态、日志、配置和排查文档如何在同一界面中协同，减少用户手动切换信息的步骤。

具体个人实习贡献仍以实际材料为准。项目不使用公司代码、业务数据、内部 Runbook 或受限文档；演示任务与排查知识独立构建。

### 1.2 一句话定位

面向数据任务故障排查的可视化工作台：用户选择一次演示运行，Agent 调用只读工具收集证据，前端流式呈现诊断过程、引用与建议，支持继续追问，并在人工批准后模拟重试。

### 1.3 目标用户

- 需要了解某次任务失败原因的开发人员。
- 需要复查诊断证据、确认后续处理方向的维护人员。
- 观看本项目演示、评估前端与 AI 应用开发能力的面试官。

### 1.4 产品目标

- 在一个工作台内完成选择运行、发起诊断、查看工具调用、查看证据、继续追问。
- 用户能区分模型建议、工具查询结果、连接状态和演示任务状态。
- 刷新、断线、切换任务后，不丢失已经持久化的诊断结果，不出现消息串场。
- 用有限的固定故障案例验证工具接入、前端交互与诊断流程，不宣称已接入生产故障。
- 完成服务端校验的审批与模拟重试链路，用户可查看重试结果并继续诊断。

### 1.5 前端能力目标

- 用明确事件类型驱动复杂异步 UI 状态。
- 设计可复用的消息、工具卡片、证据和日志组件。
- 处理长日志、增量文本、自动滚动和请求取消。
- 通过单元与 E2E 测试验证核心流程和异常状态。

## 2. 范围、优先级与版本

本次交付目标是 P0：一条完整业务闭环、可靠持久化、可替换的外部依赖、可测试的前端状态。先用较少的案例把这条链路做好，再增加页面和场景。

优先级：P0 为本次必须完成；P1 为底座通过验收后的增强；P2 为后续扩展。下文详细需求是整体设计，执行顺序以本节和第 15 节为准。P1/P2 不阻塞 P0 验收，也不能用尚未实现的空按钮充当功能。

### 2.1 最小完整闭环

```text
选择预置的超时运行 S04
→ 发起真实模型诊断
→ 观察 Tools 和流式输出
→ 点击引用查看日志 / Runbook
→ 追问
→ 申请重试并人工批准
→ 创建新的模拟运行
→ 查看恢复状态
→ 刷新或切换会话后恢复已保存信息
```

同时用 S00（正常）和 S05（信息不足）验证 Agent 不编造失败原因。不能只演示一条永远成功的聊天脚本。

| 范围     | P0 底座必须                                   | P1 展示增强                      | P2 后续扩展                 |
| -------- | --------------------------------------------- | -------------------------------- | --------------------------- |
| 任务环境 | S00/S04/S05、持久化模拟器、服务重启恢复       | 补齐 S01/S02/S03                 | 接入真实任务 / Prefect      |
| 诊断     | 单 Agent、只读 Tools、多轮会话、结构化结论    | 更多输入表达和失败分支           | 多 Agent、复杂意图路由      |
| 前端     | 列表、工作台、引用、会话选择、审批和模拟重试  | 独立历史页、演示场景页、进阶筛选 | Diff 编辑器、自动修复工作台 |
| 检索     | 简单 Runbook 检索、统一结果协议、引用溯源     | 标注更多检索案例                 | 向量/混合检索、Rerank       |
| 质量     | 核心回归测试、3 场景 6 个问题、结构化错误记录 | 6 场景 12 个问题、长日志压力验证 | 评测看板、多模型对比平台    |
| 部署     | Windows 本地启动、可构建运行、依赖锁定        | Docker 和演示发布准备            | 公网鉴权、多租户            |

v0.1 中 Agent 没有写文件、运行任意命令或直接重跑任务的权限。重试建议经确定性策略和人工审批后，由服务端场景模拟器执行。MCP 作为后续工具协议适配项，不是首版诊断的前置条件。工具直接调用已经足以实现 Tool Calling。

### 2.2 P0 不能省略的底座要求

- 共享 DTO 与事件 schema、运行时校验、明确的错误结构。
- 服务端为状态事实来源；模拟数据也必须经过相同 API、数据库与状态机。
- 消息、事件、审批实际落库，支持刷新恢复、事件重放和幂等请求。
- 取消、断线、切换会话及审批竞态具备确定的结果和自动化测试。
- Agent、数据任务、检索和数据库分别通过有限接口接入。
- 提供迁移、种子数据、环境变量说明、类型检查、测试和构建命令。
- 使用真实模型完成至少一次端到端验收；mock 跑通不能代替真实模型接入。

### 2.3 P0 可以简化的体验

- 日志先做服务端分页和限定内存窗口，不要求同时引入虚拟滚动库；长日志压力优化放 P1。
- 会话历史先在工作台选择器中完成，不要求首版独立历史页面。
- 新建演示运行先通过列表页场景选择弹窗完成，不要求独立演示页。
- 时间范围筛选、复杂 Markdown 表格样式和小屏精细适配放 P1；P0 保证基础排版、键盘操作和主要页面不溢出。
- 知识文档与任务 fixture 作为代码维护，不开发上传、编辑和版本管理后台。

不提前搭通用插件平台、分布式队列或空的多 Agent 系统。扩展点要对应本项目已知的下一步，接口有当前实现并可通过测试替换。

## 3. 典型用户故事

| ID   | 用户故事                   | 成功条件                                                   |
| ---- | -------------------------- | ---------------------------------------------------------- |
| US01 | 我想找到刚才失败的任务     | 可按状态、任务名和时间筛选运行记录                         |
| US02 | 我想了解本次运行发生了什么 | 能看阶段、输入参数、耗时与清楚标识来源的演示日志           |
| US03 | 我想让 Agent 分析失败原因  | 点击按钮发起诊断，并看到工具开始、完成或失败               |
| US04 | 我想核实结论是否有依据     | 点击引用定位到对应日志或 Runbook 片段                      |
| US05 | 我想追问“那应该先检查什么” | 仍以当前 run_id 和已有证据回答                             |
| US06 | 我想切到别的任务后回来继续 | 原会话可恢复，新任务不会混入原消息                         |
| US07 | 诊断时网络断开了           | 显示重连状态，恢复已有事件，不重复创建诊断                 |
| US08 | Agent 没有查到足够信息     | 明确输出信息不足及下一步建议，不编造错误根因               |
| US09 | 我希望停止等待             | 点击停止后服务端停止后续 Agent 步骤，保留已有内容          |
| US10 | 我希望检查此前的诊断       | 可查看历史结论、证据快照和工具耗时                         |
| US11 | 我想批准一次符合条件的重试 | 看到审批内容，批准后仅创建一个 child run，能跟踪其模拟状态 |

## 4. 信息架构与路由

| 路由                              | 页面               | 行为                                            |
| --------------------------------- | ------------------ | ----------------------------------------------- |
| `/runs`                           | 运行列表           | 默认最近运行；筛选条件同步 URL query            |
| `/runs/:runId`                    | 任务诊断工作台     | 展示目标运行，可选择/新建诊断会话               |
| `/runs/:runId?session=:sessionId` | 指定会话工作台     | 直接链接和刷新可恢复                            |
| `/diagnoses`                      | 历史诊断列表（P1） | P0 在工作台会话选择器查看；P1 再增加独立页面    |
| `/demo`                           | 演示场景面板（P1） | P0 在运行列表页弹窗创建场景；后端接口首版即存在 |

非法 runId/sessionId 显示明确的不存在页面；sessionId 不属于 runId 时返回错误，不静默加载另一任务。

### 4.1 布局

- 桌面宽屏：左侧为运行详情与日志，右侧为诊断面板；证据使用抽屉展示。
- 中等宽度：改为“运行详情 / 诊断”标签页切换。
- 小屏：单列排布，证据抽屉全屏；核心操作可用，复杂表格允许局部横向滚动。
- 默认浅色技术控制台风格，统一状态色、间距与字号。首版不要求主题切换。
- 颜色必须同时配文字或图标，不仅依赖红绿表示成功失败。

## 5. 页面交互详细需求

### 5.1 运行列表

字段：任务名、run_id 简写、状态、场景、开始时间、耗时、创建来源、操作。

- P0 支持状态筛选、任务名搜索；时间范围筛选为 P1；搜索防抖 300ms。
- 默认每页 20 条；服务端分页，按 created_at 降序、id 作为稳定次序。
- 点击一行进入详情；复制 ID 按钮阻止冒泡，提示复制成功。
- 每 3 秒刷新当前页的活动运行状态；页面不可见时暂停轮询，重新可见立即刷新。
- 首次加载使用骨架屏，后台刷新保留现有内容；筛选无结果与加载失败使用不同空态。
- 快速变更筛选时取消过期请求，并用 requestId 防止慢响应覆盖新结果。

### 5.2 运行详情

- 顶部展示任务名称、完整 run_id、状态、运行模式、创建/开始/结束时间与耗时。
- 展示阶段列表：读取、校验、入库、聚合；失败后下游阶段标记 SKIPPED。
- 参数以只读键值表展示；长值可展开。
- FAILED 显示“分析失败原因”；SUCCEEDED 显示“询问本次运行”；PENDING/RUNNING 只支持查看和询问当前进度，不能生成最终故障结论。
- 检测到服务器状态变化时更新顶部和阶段状态，不清除对话。

### 5.3 日志面板

- 每条日志包含不可变 log_id、seq、时间、级别、阶段、message。
- 支持文本搜索、级别筛选、复制单条、展开多行错误堆栈。
- 按 seq 升序展示；首屏取最近 200 条，向上加载更早日志。
- 活动运行每 3 秒查询 after_seq 之后的日志，合并时按 log_id 去重。
- 进入证据定位模式时，直接查询目标 log_id 前后各 20 条，不能仅在当前已加载列表中查找。
- 引用定位可以临时覆盖筛选，展示“正在查看引用上下文”，关闭后恢复原筛选和滚动位置。
- 活动运行提供“跟随最新”开关；用户主动向上滚动后关闭跟随，显示新增日志数量。
- 内存保留最多 2,000 条可见窗口数据，超出后回收远端页；必要时使用虚拟列表。

### 5.4 诊断面板

- 顶部展示所属运行和会话，允许新建会话/选择历史会话。
- 空会话提供示例问题：“这次运行为什么失败？”“有哪些证据？”“下一步该检查什么？”
- 输入框支持 Enter 发送、Shift+Enter 换行；中文输入法组合期间 Enter 不触发发送。
- 问题去除首尾空白后为 1～2,000 字符；空输入禁用发送。
- 同一会话同时只能存在一个非终态 turn；执行期间禁用再次发送，显示停止按钮。
- 用户消息、Agent 文本、工具卡片、最终结论、错误提示采用不同组件。
- 流式文本按帧或约 50ms 批量更新，避免每个 token 触发整页重渲染。
- 用户在底部附近时自动跟随；向上阅读后显示“回到最新”，不强制滚动。
- Markdown 支持段落、列表、表格、代码块、链接；禁用原始 HTML，并对链接协议进行校验。
- 当前会话结束后允许追问；最终结构化结论是稳定卡片，流式文字不代替结论状态。

### 5.5 工具卡片与 Trace

- 卡片包含 tool_call_id、工具名、可读用途、开始时间、状态、耗时和结果摘要。
- 参数和完整结果按需展开；大结果受大小限制，只返回引用或摘要。
- RUNNING、SUCCEEDED、FAILED、CANCELLED 分别显示文字和图标。
- 工具失败不一定表示整个诊断失败；Agent 可继续查询其他证据，最终标注缺失信息。
- Trace 展示可观察的调用和结果、简短行动说明；不要求展示模型隐藏思维链。

### 5.6 结构化诊断卡片

字段：summary、findings、evidence_ids、missing_information、next_steps、proposed_action。

- finding 包含原因类别、解释和证据引用。
- evidence_ids 引用后端登记的证据，不接受模型随意编造的日志 ID。
- 信息不足时 root cause 为 UNKNOWN，并展示还缺哪些信息。
- 不展示未经校准的“91% 置信度”；可用“证据充分 / 有待确认”，并解释依据。
- v0.1 的 next_steps 为文字建议，不生成自动修改代码按钮。
- proposed_action 仅允许 null 或 `{type: "RETRY_RUN", run_id, reason, evidence_ids}`。该字段只是建议；只有服务端策略返回 retry_eligibility.allowed=true 时才展示“申请重试”。不满足条件显示禁用原因。

### 5.7 历史诊断

P0 在工作台使用会话选择器展示当前运行的历史；列表型独立页面为 P1。会话持久化、切换和刷新恢复均属于 P0。

- 展示最近更新时间、任务名称、运行 ID、会话标题和最后一轮状态。
- 会话标题默认使用首次提问前 30 字，无需额外模型调用。
- 页面刷新后从服务端读取会话快照，再补齐新事件。
- 切换会话只关闭该页面的流连接，不取消服务器正在进行的诊断。
- 原会话继续运行，新会话能独立查看；同一用户最多 2 个活动 turn，超出返回可解释的限流提示。

### 5.8 通用状态

| 场景                   | UI 行为                              |
| ---------------------- | ------------------------------------ |
| 首次加载               | 骨架屏，避免显示伪造默认结果         |
| 无数据                 | 解释原因并提供打开场景选择弹窗的入口 |
| API 超时/失败          | 保留已有数据，局部错误提示与重试按钮 |
| 模型未配置             | 提示配置位置，不展示假的真实模型回答 |
| SSE 中断               | “连接中断，正在重连”，已收内容保留   |
| 服务不可达             | 显示离线状态，禁用新增请求           |
| 证据失效               | 展示历史快照并标注原始来源不可访问   |
| 服务端重启导致诊断中断 | 显示 INTERRUPTED，允许重新发起新一轮 |

## 6. 固定任务数据与场景模拟器

### 6.1 最小业务任务

首版模拟通用订单日报 Pipeline，任务说明中的输入字段为 order_id、created_at、amount、status。业务数据无需真实入库。每个 scenario 目录提供运行参数、阶段时间线、日志和结果摘要 JSON，无个人信息。

展示的逻辑顺序：读取输入 → 校验字段/类型/日期 → 写入订单表 → 按日期聚合 → 保存摘要结果。首版不实际执行这些 SQL 或 Python 步骤。

- Node SceneRunner 根据 fixture 时间线驱动 PENDING → RUNNING → SUCCEEDED/FAILED，并逐步追加日志。
- 默认一次场景 6～10 秒，采用相对时间 offset_ms；测试中使用可控时钟，不进行真实长时间等待。
- 模拟状态与日志实际写入 SQLite，页面刷新和切换不能使任务重新开始。
- 单机同时模拟最多 2 个 run，其余按创建顺序排队；日志以唯一 (run_id, seq) 保证不重复。
- 固定任务定义和 fixture 只读，不提供任意文件上传/编辑；修改 fixture 通过开发代码完成。
- 服务重启时可从持久化 next_event_index 恢复尚未终结的模拟任务；已写入事件通过唯一约束避免重复。
- 不设置隐式自动重试；只有已批准审批能创建 child run。

### 6.2 首版场景

P0 实现 S00/S04/S05，P1 补齐其余场景；以下保留完整 fixture 设计便于后续增量开发。

| ID  | 场景         | fixture 内容                                             | 预期模拟结果                 | 诊断重点                   |
| --- | ------------ | -------------------------------------------------------- | ---------------------------- | -------------------------- |
| S00 | 正常任务     | 全部阶段正常的日志与汇总                                 | SUCCEEDED，展示演示汇总      | 不应编造故障               |
| S01 | 缺少必填字段 | 日志写明 required=[order_id,amount]、observed=[order_id] | validate 阶段失败            | Schema 与日志相互印证      |
| S02 | SQL 引用错误 | `no such column: order_total` 与失败阶段信息             | aggregate 阶段失败           | 指出聚合阶段和具体列       |
| S03 | 重复订单     | `UNIQUE constraint failed: orders.order_id`              | load 阶段失败                | 重试不能自动解决输入问题   |
| S04 | 上游服务超时 | 首次 read 阶段 ReadTimeout；child run 使用成功时间线     | 首次失败，批准重试后模拟恢复 | 区分上游不可达与 SQL 问题  |
| S05 | 证据不足     | 只提供受控的简短异常日志，不提供底层原因                 | 运行失败但信息不足           | 输出 UNKNOWN，建议补充信息 |

S04 每次新建场景获得独立 scenario_instance_id；首次运行选用 timeout 时间线，child run 选用 success 时间线。重试成功是演示设定，界面和 README 必须说明，不能作为 Agent 修复成功率的数据。无需真正访问上游 HTTP 服务。

fixture schema 至少包含 scenario_id、display_name、task_id、params、timeline、retry_timeline?。timeline 元素包含 offset_ms、step、step_status、logs、run_status?、summary?。导入时校验时间递增、状态合法、终态唯一。

评测的 expected_root_cause 存放于测试目录；scenario_id 和 retry_timeline 不通过 Tools 返回模型。模型看到的只有任务说明、参数、状态、阶段与日志；UI 的场景名称也不自动送入模型。

### 6.3 数据分类与来源标识

- 业务数据：自行构造的订单任务参数和汇总摘要。
- 运行数据：由固定日志模板和模拟时间线生成，持久化保存，标记 FIXTURE。
- 知识数据：按上述任务编写并人工校验的公开可发布 Runbook。
- 评测数据：问题、预期根因、必须引用的证据条件和禁止行为，仅供评测程序使用。
- 后续可以接真实 Python/SQL Worker 或公开数据；保留 RunRepository / TaskBackend 接口，前端不应依赖 scenario_id 判断状态或重试资格。

## 7. Agent 行为约束与接入

### 7.1 基座使用方式

参考仓库：https://github.com/Windy3f3f3f3f/claude-code-from-scratch

实现前必须核对实际源码、LICENSE 和当前接口，记录使用的 commit。优先复用模型调用、工具循环与会话上下文处理；将 CLI 输出转换为应用事件，不把终端文本正则解析作为正式协议。

定义 AgentAdapter，输入 session、turn、run_id 和取消信号；输出统一 AgentEvent。若原项目难以直接拆分，允许抽取有限模块，README 明确注明来源与修改范围。不要同时强制引入 LangGraph、另一个 Agent 服务框架或完整 CLI 能力。

### 7.2 最小 Tools

| Tool                | 入参                            | 返回内容                              | 约束                       |
| ------------------- | ------------------------------- | ------------------------------------- | -------------------------- |
| get_task_run        | run_id                          | 状态、阶段、耗时、错误摘要            | 只能读当前会话绑定运行     |
| get_task_definition | task_id                         | 阶段、输入 Schema、配置说明           | task 必须属于当前 run      |
| get_task_logs       | run_id、level?、query?、cursor? | 最多 100 条日志、next_cursor、证据 ID | 限制输出大小并支持继续查询 |
| search_runbook      | query、category?、top_k?        | 最多 5 段知识、版本、证据 ID          | 只能读取允许的文档集合     |

v0.1 无文件写入、任意 Shell、原始 SQL 执行工具。不存在真实跨任务依赖时，不添加名为 get_upstream_runs 的空壳工具；固定阶段状态已经足够。

### 7.3 执行逻辑

1. 服务端校验会话和 run_id，持久化用户消息与 turn。
2. 确定性读取最新运行摘要供模型理解当前对象。
3. 模型决定调用哪些只读 Tools，并根据返回结果继续调查或结束。
4. 每次调用先校验参数和绑定范围，再执行；返回结构化结果或错误。
5. Agent 输出结构化结论，服务端校验其引用是否来自本轮或同会话已有证据。
6. 完成结论入库并发布终态事件。

这应包含模型驱动的工具选择，而非只给固定模板填充日志后自称 Agent。基础测试可以使用脚本模型，但页面必须显示 mock 模式。

### 7.4 限额与异常

- 默认每轮最多 8 次工具调用，包含失败与重试；最多 12 次模型请求，包含一次输出格式修复机会。
- 本地 Tool 默认超时 5 秒，单次模型请求超时 45 秒，整轮最长 120 秒。
- 短暂超时可重试一次；参数错误返回给模型纠正，不无条件重试。
- 达到轮次/时间上限时保留证据，状态 FAILED，错误 code=BUDGET_EXCEEDED 或 TURN_TIMEOUT；不伪装为完整诊断。
- 若模型输出引用无效或结构错误，允许一次修复请求；仍不合法则失败，并保留原可观察 Trace。
- 日志和检索文档作为不可信数据输入，不赋予其改变系统规则或调用权限的能力。
- max_output_tokens、模型名称和上下文预算写入服务端配置。选定提供商后补充具体默认值并验证兼容性。
- provider_mode=LIVE 时，模型不可达必须报告错误，不能自动切到 MOCK。MOCK 模式从请求问题和工具输出生成可重复事件，属于前端测试辅助，不计入真实模型评测。

### 7.5 多轮上下文

- 一个 session 固定绑定一个 run_id，不能通过追问切换目标运行。
- 注入当前运行摘要、最近对话、已有证据引用和工具结果摘要。
- 默认最多保留最近 6 个完整 turn；更早轮次保留已验证诊断结论摘要，不原样塞入所有长日志。
- 上下文按完整工具调用/返回对裁剪，避免留下孤立 tool result。
- 每轮重新读取运行状态；提示用户“上次诊断时的状态”和“当前状态”不同。
- 首版不建设跨会话长期记忆；不能把其他运行或用户信息自动混入当前会话。

## 8. 知识检索与证据

### 8.1 文档要求

P0 提供任务总览、输入 Schema、上游超时和信息不足排查 4 篇 Markdown 文档；P1 增加字段缺失、SQL 列错误和重复订单文档。文档必须与演示任务规则一致，不包含具体 eval 问题的标准答案。

元数据：document_id、version、title、category、updated_at。按标题分块，每块保留 chunk_id、heading 和源文件行范围。

### 8.2 检索方案

v0.1 使用确定性关键词匹配和类别过滤，返回前 3 条结果；没有匹配项时明确返回空。可基于 SQLite FTS 或小型内存倒排索引实现，选定后在开发 README 记录。

这是向生成阶段提供检索证据的基础实现；首版简历应写“Runbook 检索与引用”，不得写成已实现向量检索、混合检索或 Rerank。

v0.2 再考虑 pgvector / Embedding。先建立人工标注的检索问题与相关 chunk 集，再比较 Recall@K 和端到端诊断表现，是否采用由实测决定。

### 8.3 证据模型

证据由服务端工具执行器登记：evidence_id、session_id、turn_id、type、source_id、source_version、locator、excerpt、created_at。

- 日志证据 locator 包含 run_id、log_id、seq。
- 文档证据 locator 包含 document_id、version、chunk_id、行范围。
- 状态证据记录读取时刻及状态快照。
- 引用内容保存快照，Runbook 后续更新不改写历史结论的依据。
- 前端直接使用证据 API 返回的定位字段；不根据模型文字自行猜文件位置。
- 证据 API 必须验证证据属于当前可访问 session。

## 9. 数据模型与状态机

### 9.1 存储策略

默认应用数据使用 SQLite，由 Node 服务统一读写，保存 fixture 运行、会话和审批。暂不要求 PostgreSQL、Redis、消息队列或 Python。需要新增持久化组件时，先说明具体解决的问题。

数据库结构使用可重复执行的迁移；种子数据导入应幂等。业务代码依赖 Repository 接口，便于后续替换数据库。

迁移脚本提交仓库并有版本记录；启动时检测数据库 schema 版本，不能靠删除数据库解决结构变化。至少验证“旧版本示例数据库 → 新迁移”后已有会话仍可读。SQLite 相关 SQL 和驱动类型只存在于数据库适配模块；更换 PostgreSQL 仍需新实现和兼容测试，不承诺无成本切换。

### 9.2 核心实体

| 实体                                | 必需字段                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| task_definition                     | id、name、description、schema_version、steps_json、created_at                                                                                                                                    |
| task_run                            | id、task_id、data_source=FIXTURE、scenario_instance_id、parent_run_id?、status、step_states_json、params_json、created_at、started_at?、finished_at?、error_code?、error_message?、summary_json? |
| simulation_state                    | run_id（唯一）、fixture_version、timeline_variant、next_event_index、elapsed_ms、updated_at                                                                                                      |
| task_log                            | id、run_id、seq、timestamp、level、step、message                                                                                                                                                 |
| diagnosis_session                   | id、run_id、title、created_at、updated_at                                                                                                                                                        |
| diagnosis_turn                      | id、session_id、status、provider_mode、model、prompt_version、error_code?、created_at、started_at?、finished_at?                                                                                 |
| message                             | id、session_id、turn_id、role、content、is_partial、created_at                                                                                                                                   |
| tool_call                           | id、turn_id、name、args_json、status、result_summary_json、error_code?、started_at、finished_at?                                                                                                 |
| evidence                            | id、session_id、turn_id、type、source_id、source_version、locator_json、excerpt、created_at                                                                                                      |
| diagnosis_result                    | id、turn_id、summary、findings_json、missing_information_json、next_steps_json、proposed_action_json?、created_at                                                                                |
| agent_event                         | id、session_id、turn_id、seq、type、payload_json、created_at                                                                                                                                     |
| request_dedup                       | scope、idempotency_key、request_hash、response_json、created_at                                                                                                                                  |
| approval_request / action_execution | 按第 12.2 节定义，属于首版持久化数据                                                                                                                                                             |

task_log(run_id, seq)、agent_event(session_id, seq)、request_dedup(scope, idempotency_key) 必须唯一。turn 和 tool_call 的 ID 使用不可猜测的稳定 UUID。时间统一存 UTC ISO 8601，前端按浏览器时区显示。

### 9.3 状态

- TaskRun：PENDING → RUNNING → SUCCEEDED / FAILED。模拟器从 simulation_state 恢复；fixture 版本不匹配无法恢复时置 FAILED，error_code=SIMULATION_INTERRUPTED，并明确该错误来自演示服务。
- Step：PENDING → RUNNING → SUCCEEDED / FAILED；上游失败后的阶段为 SKIPPED。
- Turn：QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED / INTERRUPTED。
- ToolCall：RUNNING → SUCCEEDED / FAILED / CANCELLED。
- 页面连接状态：CONNECTING / CONNECTED / RECONNECTING / OFFLINE，与 Turn 状态分开保存。

运行失败记录保持不可变；重试创建新 run_id，通过 parent_run_id 关联。Agent 停止不会取消正在进行的模拟重试。

服务重启后，将未完成 turn 标记 INTERRUPTED，并为悬挂 tool_call 生成取消状态。首版保留会话供继续追问，不承诺恢复中断前的模型内部执行位置。

## 10. REST API 契约

### 10.1 通用规则

- 前缀 `/api/v1`；JSON UTF-8。
- 成功响应 `{ "data": ... }`；列表可含 `page_info`。
- 错误响应 `{ "error": { "code": "...", "message": "...", "retryable": false, "request_id": "..." } }`。
- 所有时间 UTC；HTTP 400 参数错误、404 不存在、409 状态/幂等冲突、410 事件过期、429 活动轮次限制、503 服务暂不可用。
- 请求体和返回体需运行时 schema 校验，前后端共享 TypeScript 类型；不以 TS 类型代替服务端校验。
- packages/contracts 为 DTO、运行时 schema、事件类型和错误码的唯一来源；默认使用 Zod 定义并推导 TS 类型，不在组件中复制接口声明。
- API 路径版本为 v1；快照和事件包络额外携带 schema_version=1。新增可选字段保持兼容，删除字段或改变语义需要版本变更与迁移说明。
- 创建运行、创建会话、提交消息及审批变更使用 Idempotency-Key。相同 key+相同 payload 返回首次结果；相同 key+不同 payload 返回 409。
- 默认参数上限：列表 limit≤100、日志 limit≤200、日志搜索 query≤200 字符、单个 Tool 返回≤20KB。

### 10.2 接口列表

| 方法与路径                               | 入参/响应要点                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| GET `/health`                            | 服务可用状态，不泄露密钥                                                           |
| GET `/capabilities`                      | provider_mode、model_configured、retry_enabled=true、task_data_mode=FIXTURE        |
| GET `/tasks`                             | 返回固定任务定义列表                                                               |
| GET `/runs`                              | status?、task_id?、q?、from?、to?、page=1、limit=20                                |
| GET `/runs/:id`                          | 运行详情、阶段状态、retry_eligibility={allowed,reason_code,message}、child_run_id? |
| GET `/runs/:id/logs`                     | query?、level?、before_seq? 或 after_seq?、limit；两种方向不可同时传               |
| GET `/runs/:id/logs/:logId/context`      | 返回目标日志及前后各 20 条                                                         |
| GET `/demo/scenarios`                    | 可创建场景和说明，仅用于本地演示                                                   |
| POST `/demo/runs`                        | `{scenario_id}`；202 返回新 run                                                    |
| GET `/sessions`                          | run_id?、page、limit；用于历史记录                                                 |
| POST `/sessions`                         | `{run_id}`；201 返回 session                                                       |
| GET `/sessions/:id`                      | 一致性快照：session、turns、messages、tool_calls、results、last_event_seq          |
| POST `/sessions/:id/messages`            | `{content}`；202 返回 user_message_id、turn_id                                     |
| GET `/sessions/:id/events?after_seq=N`   | SSE 重放及后续事件                                                                 |
| POST `/turns/:id/cancel`                 | 设置取消状态；返回实际当前 turn 状态                                               |
| GET `/sessions/:id/evidence/:evidenceId` | 引用快照与定位信息                                                                 |

GET `/sessions/:id` 的快照和 last_event_seq 必须在同一数据库读取事务中生成；否则“先快照后订阅”可能漏掉中间事件。

### 10.3 提交与失败处理

- 消息提交接口只接受任务并返回 turn_id，模型执行在后台继续。
- 即使 POST 响应丢失，客户端也使用原 Idempotency-Key 重试，不能再创建一轮。
- 同一 session 活动 turn 的限制必须在服务端事务中校验，不能只依靠按钮禁用。
- 正在执行的 turn 在成功持久化事件后，才向 SSE 连接发布该事件。
- 结果落库、diagnosis.completed 和 COMPLETED 的 turn.finished 必须在同一事务中提交；取消已经胜出时不能再提交成功结论。

## 11. SSE 与前端状态同步契约

### 11.1 事件格式

```text
id: 42
event: tool.started
data: {"schema_version":1,"event_id":"ev_42","seq":42,"session_id":"ses_1","turn_id":"turn_1","timestamp":"2026-09-26T02:00:00Z","type":"tool.started","payload":{"tool_call_id":"tc_1","name":"get_task_logs","args":{"run_id":"run_1"}}}

```

以空行结束一条 SSE event。seq 在 session 内严格递增；SSE id 与 seq 相同。客户端不得把 TCP/Fetch chunk 当成完整 JSON，必须处理跨 chunk 的 UTF-8 字符、多行 data、空行边界和注释心跳。

### 11.2 事件类型

| type                | 必要 payload                                     | 前端动作                                    |
| ------------------- | ------------------------------------------------ | ------------------------------------------- |
| turn.started        | status=RUNNING                                   | 设置执行状态                                |
| message.delta       | message_id、delta                                | 追加指定 assistant message 的文本           |
| tool.started        | tool_call_id、name、args                         | 创建工具卡片                                |
| tool.completed      | tool_call_id、summary、evidence_ids、duration_ms | 更新成功状态和证据                          |
| tool.failed         | tool_call_id、code、message、retryable           | 展示工具失败                                |
| tool.cancelled      | tool_call_id                                     | 结束该工具的等待状态                        |
| diagnosis.completed | result                                           | 渲染经过校验的结构化结论                    |
| turn.finished       | status、error?                                   | 进入 COMPLETED/FAILED/CANCELLED/INTERRUPTED |

assistant message 首个 delta 可创建消息，快照与事件均使用同一 message_id。最终消息正文由后端落库；刷新后用快照替换本地内容再追事件，避免文本重复追加。

### 11.3 连接与恢复

1. 进入工作台后读取会话快照及 last_event_seq。
2. 通过 Fetch 读取 SSE，从 after_seq 开始；服务端先重放已有事件，再发送新事件。
3. 客户端只接受当前 session_id 的事件，按 seq 去重。检测到缺口时暂停应用后续事件并重新补齐。
4. 连接断开按 1、2、4、8、8 秒重连，共 5 次自动尝试；随后显示手动重连。成功连接并收到有效事件或心跳后重置重试计数。
5. 每 15 秒发送注释心跳。连接断开不取消 turn，不重新 POST 提问。
6. 原始事件保留至少 7 天。after_seq 早于保留范围时，以 HTTP 410 返回 EVENT_CURSOR_EXPIRED；客户端重新取快照，再建立连接。
7. 切换会话立即 Abort 旧流并清理监听；通过 sessionId 和连接代次双重检查防止旧回调污染新页面。
8. 一个诊断 turn 结束可关闭本次页面 SSE，下一轮重新从当前 seq 订阅。

服务端回放到实时订阅的切换不能漏事件：建立订阅与读取高水位之间提供交接缓冲或再次从数据库补齐；数据库为最终事件来源。不能“读完历史后才开始无缓冲监听”造成时间窗口丢失。

未知同版本事件记录兼容性提示并忽略其 UI 效果，但消费合法 seq；不兼容 schema_version 或已知类型的不合法 payload 进入明确协议错误，保留页面并提示刷新升级，不能无限重连。适配层升级不得使一个新 Tool 名称导致页面崩溃。

### 11.4 停止与竞态

- “停止生成”调用 cancel API，而不只是断开浏览器流。
- 服务端设置取消标志，尽可能中止模型请求，不再派发新工具。
- 进行中的只读 Tool 无法取消时允许在超时内结束，但结束结果不能把终态 turn 改回运行中。
- cancel 与完成同时发生，由数据库首次成功提交的终态决定；重复取消返回同一终态。
- UI 显示“已停止”，保留文本和证据，未结束工具卡片转 CANCELLED。

### 11.5 前端状态组织

- runStore：运行列表、详情、轮询管理；不存模型流式文本。
- sessionStore：当前 session、规范化 messages/tool_calls/results、lastSeq、turnStatus。
- 页面级 UI state：输入草稿、抽屉、筛选、滚动跟随和连接状态。
- `useAgentStream` 仅负责连接、解析、重放；事件 reducer 负责幂等更新，可脱离组件测试。
- tool_call 数据按 ID 保存，渲染器使用工具元数据和通用卡片；未知工具名也可展示参数、摘要和状态，不为每个 Tool 写页面分支。
- 流连接、轮询、AbortController 在 composable 中统一创建和销毁，组件卸载后不得继续改 store 或保留定时器。
- 密钥不进入前端；localStorage 仅用于非敏感偏好，不作为聊天记录唯一存储。

## 12. 首版必需：审批后模拟重试

用户已确认此项进入首版。批准和创建运行均是真实后端操作，业务运行过程由场景模拟器生成；不修改代码，不执行 Shell。

### 12.1 交互

- Agent 可建议重试，后端根据失败类型、当前运行和策略决定是否提供按钮。
- 首版仅允许已知短暂上游超时场景重试；缺字段、SQL 错误、重复数据、UNKNOWN、SUCCEEDED 均不允许，前端显示服务端返回的原因。
- 用户点击申请后创建审批记录，展示原 run_id、理由、固定参数和重试影响。
- 用户批准/拒绝后显示不可重复操作的状态；批准成功返回新的 run_id，并可打开新运行。
- 原会话仍绑定原运行，只展示 child run 链接；要诊断 child run，必须新建会话。

### 12.2 服务端保证

- `approval_request`：id、run_id、status、action、args_hash、run_snapshot_hash、expires_at、created_at、resolved_at。
- `action_execution`：id、approval_id（唯一）、status、child_run_id（唯一）、error、created_at。
- 审批状态：PENDING → APPROVED / REJECTED / EXPIRED / STALE。审批有效期 10 分钟。
- action_execution 状态：QUEUED → RUNNING → SUCCEEDED / FAILED，与 child run 对齐；审批批准不等于任务成功。
- 审批过期以服务器时间判定，读取和提交时都检查；运行快照变化标为 STALE。未给审批结果前，UI 不得提前展示运行已启动。
- 批准时再次检查运行仍为 FAILED、参数未变、审批未过期、相同恢复链没有活动重试。
- 一个原始 run 最多生成一个直接 child，恢复链最多 2 次重试；重复点击返回同一 child，不新建运行。
- APPROVED、action_execution 和 PENDING child run 在同一事务中创建；SceneRunner 按唯一 run_id 推进，状态和日志可恢复。
- LLM 不能提供 approved=true 绕过校验；审批权限由服务端流程决定。

接口：POST `/runs/:id/retry-proposals`（{turn_id,reason}，必须有已完成诊断）；POST `/approvals/:id/approve`；POST `/approvals/:id/reject`；GET `/approvals/:id`；GET `/runs/:id/approvals`（刷新恢复）。所有变更需幂等键。

### 12.3 前端细节

- 审批框字段包括操作名称、原运行、固定参数、建议来源、模拟执行提示和有效期。
- 批准/拒绝提交中禁用两个按钮，关闭弹窗不等于拒绝。
- 网络响应丢失时使用同一幂等键恢复结果；若服务端已批准，直接展示已有 child run。
- 两个浏览器标签页同时处理审批，以服务器先提交的终态为准，另一页刷新状态，不覆盖决定。
- child run 状态每 2 秒轮询，终态或页面不可见时暂停；日志按第 5.3 节加载。
- 原会话展示独立操作结果卡，不把模拟成功插入成模型已确认的新结论。
- S04 恢复成功后展示“模拟重试成功”，提供“查看新运行”和“诊断新运行”入口。

## 13. 技术、模块边界与扩展要求

### 13.1 进程划分

```text
Vue3 浏览器界面
  └─ Node.js / TypeScript API 服务
      ├─ AgentAdapter → 模型 API + 只读 Tools
      ├─ SQLite 应用数据库 → 历史、日志、证据、事件
      └─ SceneRunner → 按固定时间线生成模拟日志与重试结果
```

默认技术决策：pnpm workspace、TypeScript strict、Express、SQLite、Zod、Vitest、Playwright。具体版本在 M0 核验并锁定。服务端采用模块化单体，首版无需 Python、FastAPI、独立微服务或依赖注入框架。

### 13.2 推荐目录

```text
flowlens/
  apps/
    web/src/
      pages/            # runs、workspace、history、demo
      components/       # chat、tools、logs、evidence、status
      stores/
      composables/      # useAgentStream、useRunPolling
      api/
    server/src/
      routes/
      services/         # 业务用例：诊断、会话、审批
      domain/           # 状态转换、权限规则、幂等规则
      ports/            # 小范围的可替换接口
      agent/            # ToolRegistry、ToolExecutor、上下文
      adapters/         # 上游 Agent、模型、任务、检索和存储实现
      repositories/     # 持久化接口/实现；不得被路由和前端直接调用
      events/           # 持久化、订阅、回放
      runner/           # SceneRunner、时间线推进与持久化恢复
      approval/         # 策略、审批和幂等执行
  packages/contracts/   # DTO、事件、运行时 schema
  fixtures/             # 场景配置、运行时间线、日志模板
  runbooks/
  tests/                # unit、integration、e2e
  eval/                 # 输入案例、预期标签、评测脚本
  docs/                 # 架构、接口、来源归属、演示步骤
  data/                 # 本地生成数据，默认不提交
```

组件建议：RunTable、RunStatusBadge、RunStepList、LogViewer、ChatComposer、MessageList、AssistantMessage、ToolCallCard、DiagnosisCard、EvidenceDrawer、ConnectionBanner。

### 13.3 本地运行与配置

- README 给出 Windows PowerShell 可执行的安装和启动命令。
- 提供 `.env.example`，至少含 MODEL_PROVIDER、MODEL_NAME、MODEL_BASE_URL、MODEL_API_KEY、MOCK_MODEL、APP_DB_PATH、DEMO_MODE=true。
- 依赖版本在实际搭建时核验并锁定，提交 lockfile；本文不猜具体版本号。
- 提供一条开发命令启动 web/server，SceneRunner 在 Node 服务内部运行，首版不要求 Docker。
- 分别提供 seed、test、test:e2e、eval、build 脚本；命名可随包管理器调整，README 必须一致。
- 默认绑定本机，API 通过前端开发代理访问。公开部署需要另外补充登录/会话所有权与访问控制后才能开放写接口，不把本地模式称为公网生产版本。

### 13.4 明确依赖方向

```text
前端页面/组件 → composables/store → API client → contracts
HTTP routes → application services → domain + ports
adapters → ports 的实现
bootstrap → 创建具体 adapters 并传给 services
```

- routes 只做协议校验、调用用例和响应转换，不直接调用模型、运行 SQL 或推进场景。
- domain 保存状态和规则，不依赖 Express、Vue、SQLite 驱动或模型 SDK。
- services 编排流程和事务，通过构造参数注入实际需要的依赖；禁止全局单例隐藏模型/数据库。
- 上游 Agent 类型、模型 SDK 类型、数据库行类型在适配层转换，不暴露给前端和共享 contracts。
- fixture 标签、预期答案、时间线判断仅存在于 FixtureTaskBackend / SceneRunner；组件和通用 Tools 不按 S04 等场景 ID 分支。
- 不要求每个简单函数都加接口；仅对外部依赖和已知替换点设置 ports。

### 13.5 首版必须落地的扩展边界

| 边界                              | P0 实现与职责                                                     | 后续替换方式                             | P0 验证                                                    |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| AgentAdapter                      | 接收规范化会话、上下文、取消信号和注册工具；输出内部执行事件      | 更换 Agent 内核，无需改前端事件协议      | LIVE 和脚本 MOCK 都通过同一生命周期契约                    |
| ModelGateway                      | 在适配层封装当前一家模型的流式/工具调用与超时                     | 新增另一模型提供商适配，不修改业务 Tools | 用协议 fixture 验证文本分片、工具参数和提供商错误          |
| TaskBackend                       | 规范化任务/运行/日志查询、重试资格与批准后的执行；P0 对接 fixture | 对接 Python Worker 或外部调度 API        | 测试替身返回不同运行数据时，现有页面与 Tools 不变          |
| RunbookRetriever                  | 输入 query/filter/limit，返回统一 chunk、来源与排序信息           | 关键词 → 向量或混合检索，保留证据协议    | 检索实现替换后引用组件和 evidence API 仍通过测试           |
| ToolRegistry / Executor           | 注册 name/schema/handler/权限，统一超时、Trace 和输出限制         | 后续 MCP 在这里适配到同一工具模型        | 增加一个测试只读 Tool，Agent Loop 和通用 Tool 卡片无需改动 |
| Repositories + transaction runner | 集中数据库映射、事务和约束，P0 SQLite                             | 实现 PostgreSQL 适配并迁移数据           | 服务用例测试不导入 SQLite 驱动；迁移保留历史记录           |

ModelGateway 可先作为 AgentAdapter 内部的小模块，避免叠加另一套框架。MOCK 仍应使用真实 ToolExecutor 查询 fixture，并走相同持久化/SSE 路径；仅模型决策和生成事件可按脚本控制。

公共 SSE 事件由应用服务统一分配 seq 并持久化。AgentAdapter 不直接向 HTTP response 写字节，不直接修改审批或 task_run。这样模型升级不影响应用事件序号和业务状态。

TaskBackend 的执行入口接收 run_id、approval_id、action_execution_id 作为幂等关联标识，不接受模型直接传入的 approved 布尔值。当前数据库事务创建执行记录后，独立派发给后端；后续接外部任务系统时需要利用执行 ID 去重、查询和对账，不假设本地事务能覆盖外部系统。

### 13.6 状态与事务约束

- 任务运行、Agent turn、ToolCall、审批、操作执行、浏览器连接分别建模。组件不得用一个 loading/status 变量代表全部过程。
- 单会话活动 turn 限制、幂等键和批准创建 child run，必须在数据库约束/事务中保证。
- 消息增量批次、message 内容及对应事件 seq 作为一致的写入单元，避免快照有文本但 cursor 落后而重复追加。
- 模型请求、网络工具请求不占用数据库事务；工具结果回来后再做短事务，提交前检查 turn 是否已经终态。
- 同一个公共事件可能被重复投递，客户端幂等消费；不宣称网络 exactly-once。
- P0 单进程负责后台 turn 和模拟器；扩展到多实例需要另外实现领取/租约，不在首版默默开启多个后端进程。

### 13.7 可维护性与可观察性

- 统一配置读取和启动校验；API key 仅服务端环境变量，日志中脱敏。
- 结构化服务日志包含 request_id、session_id、turn_id、tool_call_id 或 action_execution_id，按实际操作携带。
- 记录模型/Prompt 版本、工具耗时、首事件延迟和错误码；不必先部署监控平台。
- 至少提供 `dev`、`typecheck`、`lint`、`test`、`test:e2e`、`build`、`start`、`db:migrate`、`db:seed`、`eval:live` 的实际可执行脚本。
- P0 配置 CI：类型检查、lint、确定性单元/集成测试、构建，以及核心 mock E2E；真实模型测试手动触发，不让 CI 依赖 API key。
- README 必须说明来源归属、启动、数据模式、模型配置、测试、已知限制；docs 至少保留架构边界、接口事件、扩展方式三份说明。
- 不允许 `TODO` 空函数、静默 catch、`as any` 绕过核心契约或硬编码“诊断成功”通过验收；必要例外必须注明原因并测试。

### 13.8 允许的后续演进

| 扩展              | 主要修改位置                              | 应保持稳定的部分                   |
| ----------------- | ----------------------------------------- | ---------------------------------- |
| 接入真实 Pipeline | TaskBackend 实现、任务配置、后端同步逻辑  | 运行详情、日志、会话和证据展示     |
| 增加 RAG          | RunbookRetriever 实现、索引流程、检索测试 | Tool 返回契约、引用卡片、审批      |
| 增加 MCP          | 工具适配模块和注册逻辑                    | ToolExecutor 策略、Trace、通用卡片 |
| 换模型            | ModelGateway/AgentAdapter 配置与适配      | 业务 Tools、API、前端              |
| 增加图表或历史页  | 前端 feature、必要的查询 API              | 诊断主流程和事件 reducer           |
| 改 PostgreSQL     | 数据库适配、迁移、事务兼容测试            | 前端 contracts 和业务用例语义      |

以上是降低耦合的目标，不承诺未来功能零成本接入。自动改代码和多 Agent 会改变产品边界，后续另开设计，不提前塞进本版运行循环。

## 14. 测试、诊断评测与验收

### 14.1 自动化测试层级

| 层级       | 工具建议                | 必测内容                                                                 |
| ---------- | ----------------------- | ------------------------------------------------------------------------ |
| 单元       | Vitest                  | SSE 跨分片解析、seq 去重、会话切换隔离、状态 reducer、引用校验、参数校验 |
| 组件       | Vue Test Utils + Vitest | 输入法发送、按钮禁用、工具状态、引用抽屉、滚动跟随                       |
| 服务集成   | Vitest + 临时 SQLite    | 请求幂等、活动 turn 限制、事件重放、取消竞态、模拟日志持久化、审批幂等   |
| 浏览器 E2E | Playwright              | 完整诊断、刷新恢复、断线重连、证据定位、切换会话、取消                   |
| Agent 评测 | 独立脚本                | 根因与证据正确性、缺证据拒绝猜测、工具越界行为                           |

确定性 CI 使用 mock 模型与固定工具返回；真实模型评测单独运行并标注模型、Prompt 版本、日期与费用（若提供商返回）。mock 成绩不能用于宣称真实模型准确率。

### 14.2 验收用例

P0 执行 AC01、AC03～AC15、AC17～AC19、AC21～AC24；AC20 在 P0 验证 S05/正常运行拒绝重试，其余场景 P1 补齐。AC02 和 AC16 属于 P1。任何 P0 用例失败必须报告，不以页面能打开代替验收。

| ID   | 场景/操作                                 | 必须观察到的结果                                      |
| ---- | ----------------------------------------- | ----------------------------------------------------- |
| AC01 | 从演示页启动正常任务                      | 按 fixture 推进阶段，演示汇总可查看，来源标识明显     |
| AC02 | 启动缺字段任务并诊断                      | 显示模拟失败，诊断引用对应 fixture 日志               |
| AC03 | 诊断正常运行                              | 不无依据声称失败，说明运行成功                        |
| AC04 | 中文字符和 JSON 在网络层被任意切分        | 字符完整，事件不丢不重复，无解析崩溃                  |
| AC05 | 同一事件被回放两次                        | 文本和工具卡片不重复                                  |
| AC06 | 流断开后重连                              | 使用 after_seq 恢复，不新增用户消息或 turn            |
| AC07 | 诊断中刷新                                | 快照恢复历史，继续显示新事件                          |
| AC08 | A 会话运行时切换到 B                      | B 不出现 A 的消息，返回 A 可恢复                      |
| AC09 | 点击引用，目标不在当前日志页              | 查询上下文并定位高亮正确 log_id                       |
| AC10 | 点击停止后工具晚到结果                    | turn 保持 CANCELLED，不跳回完成/运行                  |
| AC11 | Tool 超时或日志为空                       | 卡片给出错误，结论说明限制或轮次失败                  |
| AC12 | 模型返回不存在的证据 ID                   | 不展示可点击的伪引用，尝试修复或明确失败              |
| AC13 | 用户重复点击发送或请求响应丢失            | 同一幂等键只产生一个 turn                             |
| AC14 | 服务在诊断中重启                          | 重连显示 INTERRUPTED，可新建后续 turn                 |
| AC15 | 不配置模型 API                            | mock/未配置标志可见，不冒充真实诊断                   |
| AC16 | 1 万条日志、200 个工具事件的测试 fixture  | 分页/窗口化生效，浏览器不一次挂载全部行               |
| AC17 | 多次批准同一重试                          | 只创建一个 child run，服务端持久化校验                |
| AC18 | 拒绝或过期审批                            | 不启动模拟运行，给出明确状态                          |
| AC19 | S04 诊断后批准重试                        | 展示 PENDING/RUNNING/SUCCEEDED 与新日志，标注模拟恢复 |
| AC20 | S01/S02/S03/S05 请求重试                  | 后端拒绝，前端明确原因，不因模型建议绕过              |
| AC21 | 模拟重试中服务重启                        | 从已保存进度恢复，日志和 child run 不重复             |
| AC22 | 替换 TaskBackend / Retriever 的测试实现   | Tools、页面协议和引用格式不变，契约测试通过           |
| AC23 | 新注册一个只读测试 Tool                   | 通用卡片可展示，无需改 Agent 主循环或组件分支         |
| AC24 | 空库初始化、重复 seed、保留已有会话后迁移 | 启动可复现，不覆盖用户数据，历史记录可读              |

### 14.3 首版诊断评测

- P0 建立 6 条问题：S00/S04/S05 每场景 2 种自然表达，至少覆盖一次多轮追问。P1 扩为全部 6 场景、12 条问题。这是计划规模，不是已有成果。
- 单独保存期望原因、最低证据要求和禁止行为；不得把参考答案塞入 Runbook 或模型输入。
- 指标：根因正确率、有效证据引用率、工具执行成功率、缺证据时合理保留判断比例、端到端耗时。
- 工具路径不要求唯一；只检查是否取得必要证据以及是否越界。
- 后续调参用开发集，另留表达不同的保留集。样本较少时报告原始成功/失败数量和案例，不宣称具备生产泛化能力。
- 记录原始基线再做优化，不预填“准确率提升 XX%”。

### 14.4 前端性能与可用性目标

以下为待验证目标：

- 本地正常网络下，点击发送后 200ms 内出现本地提交反馈；模型首 token 时间单独统计，不混入前端耗时。
- 批量渲染避免每 token 全列表更新，保留性能记录用于解释。
- 操作支持键盘导航、明显焦点和可读错误；动态状态用适量 aria-live，不能每个 token 都朗读。
- P0 在 768px、1440px 验证主要流程，360px 保证内容可访问、不重叠；P1 再完善手机布局。不得出现整页无意义横向滚动。
- 测试报告注明设备、浏览器和数据规模；未测前不写性能提升数字。

## 15. 实施里程碑与交付物

| 阶段                  | 交付物                                                                      | 进入下一阶段条件                                                |
| --------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| M0 技术验证           | 核验上游源码/许可证，固定 commit；真实 API 流式与工具调用验证；记录适配边界 | 默认技术方案可运行，已知限制写入 ADR                            |
| M1 工程基础与页面     | workspace、contracts、迁移、错误处理、S00/S04/S05、列表和详情               | seed 可重入，状态/日志由服务端提供，typecheck/test/build 可运行 |
| M2 诊断—审批—重试闭环 | Agent/Tools、SSE、引用、结构化诊断、审批、child run                         | 实际跑通第 2.1 节全流程，审批幂等测试通过                       |
| M3 底座可靠性         | 刷新/断线恢复、取消、会话切换、并发审批、服务重启、适配器契约测试           | 所有 P0 验收用例通过                                            |
| M4 P0 交付            | CI、6 条真实模型评测记录、README、架构和扩展文档、录屏                      | 新环境按文档启动；可解释未通过案例；交付 P0 验收报告            |
| M5 P1 展示增强        | 其余场景、12 条评测、独立页面、压力测试、UI 精修                            | P0 已通过；每项增量有回归测试                                   |
| M6 P2 扩展            | 真实任务、向量检索、MCP 等按实际需要选择                                    | 单独明确范围与验收，再进入实现                                  |

每阶段交付可运行代码、启动方式、测试结果和已知问题。总工作量需在 M0 检查源码接入成本后重新估算；此前最小 Demo 的估时不覆盖本文全部恢复机制与自动化测试。

### 15.1 P0 完成定义

1. 新开发者从仓库 clone 后，通过 README 完成安装、迁移、seed、mock 启动与 build/start；真实模型只需补充服务端配置。
2. S04 能从诊断走到批准后的模拟恢复，S00/S05 能正确处理正常/信息不足情况；所有输出来源明确。
3. 未通过的真实模型案例记录实际错误，不更改标签或 fixture 掩盖；确定性安全和引用校验用例必须全通过。
4. 存在核心流程的 Playwright E2E、事件 reducer 单测和服务端事务集成测试。
5. 通过第 13.5 节的适配契约测试，说明“接真实任务 / 加 RAG / 换模型”分别应改哪里。
6. 交付 `docs/p0-acceptance.md`，逐项列出用例、执行命令、结果与限制；不能仅给一个总的“已完成”。

### 15.2 约束开发 AI 的节奏

- 从 M1 开始就采用共享 schema、数据库迁移和适配边界，不能到 M3 再整体重写单文件原型。
- M2 先把端到端闭环跑通，不提前做完整历史页面、图表或向量数据库。
- M3 补齐明确列出的可靠性验证；M4 通过后交付底座，P1/P2 等后续安排。
- 若需要改变公共契约或增加基础设施，先记录具体阻碍、备选方案与迁移影响；普通组件/函数拆分由开发 AI 自行决定，不反复要求用户选择。

## 16. 给开发 AI 的执行指令

1. 阅读本文和用户后续决策，按既定默认方案推进。仅对无法从文档推断且确实阻塞工作的问题集中询问一次；普通库版本、组件拆分和函数组织自行核验决定，并记录假设。
2. 先检查目标仓库实际代码、许可证和依赖，确认 Agent 基座可复用范围。不要把本文设计当成源仓库已经提供的接口。
3. 按 M0～M4 完成 P0，每阶段保持能运行；验收后交付，不自动扩展到 P1/P2。
4. 前后端共用事件和 DTO 契约，优先补 SSE、幂等、会话隔离等测试，再接真实模型。
5. task_data_mode=FIXTURE 与 provider_mode=LIVE/MOCK 独立标识。首版不建设真实任务执行器；mock 模型不能伪装真实诊断。
6. 不自动加入 Prefect、LangGraph、多 Agent、MCP、向量数据库、Diff 编辑器或任意 Shell；扩展应服务于已确认需求。
7. 默认采用单机、单用户、有限工具权限。不得复用公司资料作为测试输入。
8. 遵守开源许可证，保留必要声明；README 列出上游复用能力与个人新增能力。
9. 提交接口说明、运行说明、测试与评测报告；所有宣称的已完成功能都应有可执行证据。
10. 遇到依赖或网络阻塞时记录具体原因；可先完成独立页面与 mock 测试，但不能把真实接入标记为完成。

## 17. 讨论与变更记录

| 日期       | 版本              | 内容                                                                                                                 |
| ---------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-09-26 | v0.1 初稿         | 将项目收敛为前端主导的智能诊断工作台，定义页面、协议、状态和验收                                                     |
| 2026-09-26 | v0.1 决策更新     | 用户确认 Vue3 技术栈、固定任务数据、首版包含审批重试；移除首版 Python Worker，采用可持久化的场景模拟器               |
| 2026-09-26 | v0.1 可实施需求稿 | 用户确认真实模型 API + mock 测试模式；首版范围与核心交互已确定                                                       |
| 2026-09-26 | v0.1-r2           | 用户要求基本流程与高完成度底座优先；划分 P0/P1/P2，首轮缩为 3 场景，补充依赖边界、适配契约、事务约束、迁移和质量门禁 |

当前无必须由用户再决定的架构问题。沿用本地单用户、独立仓库、Vue3、Node.js、SQLite、pnpm workspace 默认方案。模型名称、API 地址和密钥由用户在开始真实模型接入时通过本地环境变量提供，不写入 PRD。若届时无可用凭据，先完成独立工程与 mock 测试，真实模型验收明确标为未完成。后续实现不得恢复为旧版真实 Worker 或删掉审批功能。

## 附录 A. 核心数据结构示意

以下命名作为前后端契约基础，实际实现时补齐运行时校验。可选字段使用 null 或省略的策略应全项目统一；本文 API JSON 建议明确使用 null。

```typescript
type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
type TurnStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED'
  | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
type RootCause = 'NONE' | 'SCHEMA_MISMATCH' | 'SQL_COLUMN_ERROR'
  | 'DUPLICATE_DATA' | 'UPSTREAM_TIMEOUT' | 'UNKNOWN';

interface DiagnosisResult {
  id: string;
  turn_id: string;
  summary: string;
  findings: Array<{
    cause: RootCause;
    explanation: string;
    evidence_ids: string[];
    evidence_status: 'SUPPORTED' | 'NEEDS_CONFIRMATION';
  }>;
  missing_information: string[];
  next_steps: string[];
  proposed_action: null | {
    type: 'RETRY_RUN';
    run_id: string;
    reason: string;
    evidence_ids: string[];
  };
}

interface Evidence {
  id: string;
  session_id: string;
  turn_id: string;
  type: 'LOG' | 'RUNBOOK' | 'RUN_STATE';
  source_id: string;
  source_version: string;
  locator: Record<string, string | number>;
  excerpt: string;
  created_at: string;
}
```

NONE 仅用于正常运行的结论；UNKNOWN 表示无法确定原因。动态提出的其他原因先以 UNKNOWN + explanation 表达，不能随意扩展枚举让前端出现未处理类型。

## 附录 B. S04 场景与演示脚本

### B.1 Fixture 摘要示例

```json
{
  "scenario_id": "S04",
  "version": "1",
  "display_name": "上游超时与模拟重试",
  "task_id": "order_daily",
  "params": {"business_date": "2026-09-25"},
  "timeline": [
    {"offset_ms": 0, "step": "read", "step_status": "RUNNING", "run_status": "RUNNING", "logs": [{"level": "INFO", "message": "Starting read step"}]},
    {"offset_ms": 6000, "step": "read", "step_status": "FAILED", "run_status": "FAILED", "logs": [{"level": "ERROR", "message": "ReadTimeout: upstream request exceeded 5s"}]}
  ],
  "retry_timeline": [
    {"offset_ms": 0, "step": "read", "step_status": "RUNNING", "run_status": "RUNNING", "logs": []},
    {"offset_ms": 1000, "step": "read", "step_status": "SUCCEEDED", "logs": [{"level": "INFO", "message": "Read completed"}]},
    {"offset_ms": 2000, "step": "validate", "step_status": "RUNNING", "logs": []},
    {"offset_ms": 3000, "step": "validate", "step_status": "SUCCEEDED", "logs": []},
    {"offset_ms": 4000, "step": "load", "step_status": "RUNNING", "logs": []},
    {"offset_ms": 5000, "step": "load", "step_status": "SUCCEEDED", "logs": []},
    {"offset_ms": 6000, "step": "aggregate", "step_status": "RUNNING", "logs": []},
    {"offset_ms": 7000, "step": "aggregate", "step_status": "SUCCEEDED", "run_status": "SUCCEEDED", "logs": [{"level": "INFO", "message": "Report generated (fixture)"}], "summary": {"rows": 1000, "data_source": "FIXTURE"}}
  ]
}
```

未开始的阶段初始化为 PENDING，失败后未执行阶段为 SKIPPED。场景开始后使用系统当前时间 + offset_ms 生成日志时间；run_id/log_id 不硬编码复用。step_status 更新、日志插入和 next_event_index 推进在一个事务中完成。

### B.2 3 分钟演示顺序

1. 打开运行列表的场景选择弹窗（P1 可使用场景页），确认“演示任务数据 / 模型模式”标识。
2. 启动 S04，展示运行列表和 read 阶段由 RUNNING 变为 FAILED。
3. 点击“分析失败原因”，观察工具卡片查询运行、日志与 Runbook。
4. 点击结论证据，定位到 ReadTimeout 日志和对应排查文档。
5. 追问“这个问题重试有用吗？”，查看依据和限制。
6. 点击申请重试，查看固定参数，批准后打开新运行，展示模拟恢复。
7. 返回历史诊断，刷新验证保存；补充一次工具错误或断线恢复演示。

## 附录 C. 首次打开即可演示的种子数据

- P0 seed 导入一个 order_daily 任务和 S00/S04/S05 三个终态示例运行；P1 增量导入其余 3 个，全部标记 FIXTURE。
- 固定示例 run_id 使用专用命名空间；seed 重复执行不覆盖用户已创建会话和审批。
- 不预装看似由真实模型生成的对话。诊断面板第一次打开为空，点击后才执行模型或 mock。
- 列表页场景弹窗（P1 的 `/demo`）可创建新模拟运行，使用全新 UUID；不能通过反复改写固定 run_id 表示新执行。
- 已批准重试的初始示例保持不可变；需要重新演示时创建新的 S04 实例。
- 正常演示不提供“清空数据库”按钮。测试使用独立临时数据库，不能清除开发者历史会话。
