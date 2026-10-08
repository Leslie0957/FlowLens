# FlowLens

基于 Vue 3 和 TypeScript 的数据任务 Agent 诊断工作台。主入口 `/pipeline` 使用自行生成的车辆事件：编辑 SQL → 真实 SQLite 查询与独立校验 → Agent 工具取证与 Diff → 人工一次批准修复并入库 → 后端候选 SQL 执行与校验、只读预检、事务入库 → 自动打开结果复查 → 必要时撤销最新有效批次。当前为 Windows 本地单用户 Demo，车辆链路标记 SYNTHETIC，不连接公司环境。

旧 `/runs` FIXTURE 模拟任务、诊断历史和 `/local` 订单实验继续保留，入口折叠在侧栏“早期实验与历史”中；这些历史诊断属于早期模拟链路。车辆 Pipeline 的执行、诊断、版本与入库记录在各项目工作台查看。真实车辆执行与模型来源 LIVE/MOCK 分别显示，不把旧模拟时间线当作真实执行证据。

## 车辆 Pipeline Demo

- 每个项目独立只读源库和目标库；10 条合成事件含速度/时长边界与对照，Demo 规则为速度 < 1 m/s、持续 ≥ 3 秒，独立验证期望 4 行及完整字段值。
- A 列错误由 SQLite 实际报错；B 查询成功后因输出别名缺 `car_series` 校验失败；C 正常预检及重复入库实际跳过重复业务键。
- Pipeline Agent 根据初始真实失败和上一轮工具返回自主选择下一步，可同轮请求多个工具，无固定六工具清单。SQL 候选必须引用基础 SQL 和实际失败证据；仅凭初始错误给出保守人工建议也可结束。工具轨迹保存轮次/call ID、真实返回和失败，最终回复最多纠正一次，原始回复与具体校验原因保留。旧历史兼容，来源校验不代表自动证明自然语言因果结论。
- SQL 新版本不可变，只有 `task.sql` 可编辑。Agent 复用现有模型网关、共享 LIVE 预算与 ToolRegistry，经官方 MCP SDK 的独立 stdio 服务读取本次 SQL、实际 Schema、日志、输出和固定规则；工具由真实 `tools/list` 发现，模型调用经 `tools/call`，服务端核对来源、登记证据并计算 Diff。每次诊断绑定项目、执行和版本，服务只读且不迁移数据库；连接失败明确停止，旧工具历史仍按旧记录显示。
- `get_logs` 默认读取最近 20 条、最多 100 条，支持排他 `before_seq` 游标、阶段和级别筛选。原始 `seq` 保持稳定，每页内部升序，完整工具响应限制 20 KiB，按整条日志分页并提供续读信息；单条日志超限返回错误。每页范围、内容 hash 和调用参数保存在证据及历史中，换参数重复读取相同日志不算新增取证进展。
- “批准修复并入库”一次授权当前候选与校验通过后的业务写入，授权绑定批准时目标版本和数据摘要。后端持久记录授权，候选 SQL 只执行一次，结果校验与只读预检通过才发布 SQL；复用这次执行的输出，在目标未变化且绑定仍有效时事务入库。此流程不创建独立验证目标库，不做试入库或幂等重跑，也不再次执行候选 SQL；失败/取消/目标变化均停止。成功后直接进入结果页，无第二次批准。旧的仅验证审批保持原权限；不会从历史记录追加写入。服务重启用目标提交凭证确认已完成批次，没有凭证的中断授权不自动重放写入。
- 正常SQL或旧的仅验证审批仍可在预检卡片“批准本次入库”，这是单独的数据写入入口。所有入库均绑定执行、SQL/input/output hash、目标版本和10分钟预检有效期。参数化写入、实际新增行的增量事件、入库前历史元数据、批次凭证、数据版本推进同事务提交；失败显式回滚。成功后自动进入批次结果复查页，实际查询目标数据；可完成复查或撤销最新有效批次，恢复后结果自动更新。“完成”仅结束复查，事务已在批准时提交。提交响应丢失时先核对真实凭证，不凭前端状态假定成功。
- “只撤销本次数据”在事务内校验并仅删除本批次实际新增行，恢复入库前数据，保留当前 SQL 版本、原有行及诊断和审批历史。再次预检只读，重新入库需要再次批准。只允许最新尚未撤销且有实际新增的批次；零新增重跑不移动数据头。新目标历史使用一次基线、可校验增量事件和常量大小的快照元数据，不重复保存整表 JSON；旧 FULL 快照保留且可查询和撤销。目标库在服务启动或可写入口独立迁移至 schema v2，重复迁移不新增基线。恢复版本单调增长，损坏历史/旧头/数据漂移/活动操作会拒绝恢复。整表 hash 与历史重建仍有读取成本，目标凭证用于重启与响应丢失后的事实核对。
- `/pipeline/projects/:projectId/database` 独立只读查询源表、当前目标表和选定入库前数据；新批次从基线及事件重建，旧批次读取保留的 FULL 快照。支持字段、WHERE、ORDER BY、LIMIT、COUNT；单条小语法 + 表白名单 + 只读 SQLite，禁写入/系统表/跨库/多语句。默认200、最多500行，子进程10秒超时及256 KiB输出限制。源数据固定小规模，只读查询不迁移目标库、不推进业务数据版本。
- 持久 SSE 游标、同读事务快照、重连/去重/缺口同步；游标只在快照成功应用后推进。活动任务每秒只读核对状态，空闲时每5秒核对；状态读取5秒超时后重试，避免事件漏收或请求失败后停在“处理中”。项目切换/卸载清理核对与连接，执行选择 URL、取消与迟到请求保护。浏览器 sessionStorage 保存不确定响应的幂等键，重复批准仍由后端执行/批次唯一凭证保护。

2026-10-07 的实际验收、失败修正与限制见 [Pipeline 验收记录](docs/pipeline-acceptance.md)，演示见 [五分钟操作稿](docs/pipeline-demo-script.md)。LIVE A/B 脚本及 A 浏览器实测共6次 DeepSeek 请求、9712 usage tokens，每例6个实际只读工具，均经过隔离验证、入库、查询与撤销。这些测试使用隔离数据和自动化批准，人工验收等待用户进行。[A/B报告](docs/evals/pipeline-live-20261007.json)、[LIVE浏览器报告](docs/evals/pipeline-live-browser-20261007.json) 与 [录屏](docs/demos/pipeline-live-browser-20261007.webm) 可核对。

主页面按当前 SQL 版本提示下一步，旧执行仍保持独立历史。Agent 区按工具取证、诊断结论、修复候选排列，正文证据编号可打开实际工具返回内容；原始编号与版本可展开核对。“批准修复并入库”会完成候选 SQL 校验、预检和真实事务入库，无需第二次批准。旧的仅验证审批记录仍不继承入库权限。撤销时先展示恢复范围，点击“确认只撤销数据”才提交恢复操作。

## 保留的早期实验

- S00 正常、S01 缺字段、S02 SQL 列错误、S03 重复订单、S04 上游超时、S05 信息不足六个演示场景；运行状态和日志由 SQLite 持久化。
- 诊断会话、流式事件、只读工具轨迹、结构化结论与日志/Runbook 引用定位。
- 断流续传、事件去重、取消与服务重启恢复；审批、幂等请求和模拟 child run。
- MOCK 模式无需密钥；LIVE 模式需在服务端显式配置 DeepSeek、批准标志和请求预算（有限次数或已授权的持续使用）。
- 独立历史诊断页、六场景演示页与创建时间范围筛选；历史链接恢复指定会话，日志窗口最多200行、工具轨迹展开每页最多20项。
- M6.1 独立本地执行实验：预置故障 SQL 和正常对照在 Node 子进程中查询内存 SQLite，保存不可变版本、实际日志、退出码、产物及独立 3 笔/总额 100 验证。合成输入标记 SYNTHETIC；本步骤不调用模型。
- M6.2 在失败的本地执行上进行一次 Agent 诊断：只读工具绑定当前 SQL、日志与执行，展示来源标记、证据和服务端计算的 Diff；页面审批后才产生新版本并实际验证一次。
- M6.3 在单独勾选并批准后启动有限修复循环：至多自动应用/验证 3 份候选，失败结果回传下一轮；每轮保留版本、Diff、证据、日志与真实验证结果。

回答展示：查询与校验期间只显示进度，初稿及修正过程不作为正文显示。最终结论通过服务端校验后，新消息按顺序逐步呈现；刷新或切换会话后直接显示已完成历史。该效果由前端逐步展示已校验的完整结果实现，因此正文开始前仍需等待模型生成和校验；开启系统“减少动态效果”时直接显示全文。

车辆 Pipeline 的新诊断也在校验后逐步呈现正文，随后显示处理类型、Diff 与批准按钮；刷新及切换旧执行直接恢复全文，重复快照不重放。SSE 同步真实任务状态和工具记录，正文逐步呈现由前端完成，未实现模型 token 的实时 SSE 推送。

## 技术栈

Vue 3、TypeScript、Vite、Pinia、Element Plus；Node.js、Express、SQLite、Zod；SSE、Vitest、Playwright。前后端与共享契约使用 pnpm workspace。

## 本地运行

直接验收可使用独立持久演示库，保留默认开发数据库和用户历史：

```powershell
pnpm build
pnpm demo:pipeline
```

打开 <http://127.0.0.1:5180/pipeline>。该命令在 `data/pipeline-demo/` 中准备 A/B 真实失败现场与 C 正常任务；初始化只运行 SQL，不调用模型。模型沿用现有配置，点击 Agent 后才请求。Ctrl+C 停止两项服务，重新运行保留演示历史；端口4180/5180已被占用时明确失败。需要其他端口可在当前终端设置 `FLOWLENS_DEMO_API_PORT`、`FLOWLENS_DEMO_WEB_PORT`。当前入口与项目链接记录在 `data/pipeline-demo/manifest.json`。

验证环境为 Node.js 24.14.1、pnpm 11.5.0、Windows 与 Chrome。Windows PowerShell 中执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chrome ffmpeg
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 <http://127.0.0.1:5173/pipeline>（根路径自动跳转）。选择 A/B/C 模板创建车辆任务，按按钮完成真实链路。无 `.env.local` 时 `MODEL_MODE=MOCK`，无需密钥；已有 `.env.local` 沿用其配置。若仅希望本次终端离线演示，启动前设置 `$env:MODEL_MODE='MOCK'`，不需修改持久配置。开发 API 默认仅监听本机 `127.0.0.1:4173`。

旧模拟入口 <http://127.0.0.1:5173/runs>：进入 S04 创建会话提问“这次为什么失败？”，可申请模拟重试；S00 正常、S05 信息不足且不允许重试。新迁移 v10 增加 Pipeline 表，保留原数据库与用户历史。源库、目标库及旧流程遗留的验证库保存在应用数据库旁的 `pipeline-projects/`，请连同主库一起保留，不要删除旧库重建。

侧栏的“历史诊断”打开 `/diagnoses`，支持按标题、任务名或运行ID搜索，打开后URL携带指定session；“演示场景”打开 `/demo`，创建任意一个新模拟运行。运行列表的创建时间范围按本地时间填写，包含起止时刻，和状态/任务搜索组合生效。M5 具体操作见 [人工验收清单](docs/m5-manual-acceptance.md)。

侧栏的“本地执行实验”打开 `/local`。创建“SQL 列错误”或“正常对照（预置）”项目后，进入项目页点击“运行任务”；故障项目不改源码重复运行仍失败，对照应输出 3 笔、总额 100。每次执行的源码快照、日志、结果与产物保存在数据库旁的 `local-projects/`，刷新不会重新执行。活动执行可取消；默认同时只运行 1 个、30 秒超时。普通 SQL 很快完成，取消功能的人工验收可按 [M6 验收计划](docs/m6-acceptance-plan.md)使用受控测试任务。

M6.2 在故障执行详情点击“诊断并生成候选”，查看 LIVE/MOCK 来源、三个绑定的只读工具、证据及 `task.sql` Diff。点击“批准并实际验证”才会应用这一份候选并产生一次新执行；拒绝、过期、版本变化或候选篡改均不写入。新验证即使 SQL 退出码为 0，仍须通过独立 3/100 断言。预置正常对照仍不是 Agent 修复；聊天文字和旧 FIXTURE 模拟审批不能批准本地补丁。

M6.3 在当前版本的失败执行下，先阅读“Agent 有限修复循环”的范围并勾选授权，再点击“批准有限修复循环”。此授权允许当前合成项目自动应用最多 3 份 `task.sql` 候选并分别实际验证；固定命令 `orders-sql-v1`，整个循环最多 10 分钟、36 次模型请求。通过独立 3/100 验证才显示成功；失败、达到上限、取消或服务重启均停止，刷新可看每轮历史。没有自由 SQL 编辑器、任意 Shell 或 Agent checkpoint/Continue。

`pnpm-workspace.yaml` 已声明允许锁定的 esbuild 依赖运行构建脚本；无需交互执行 approve-builds。Chrome/ffmpeg 用于 E2E 和评测录屏，日常打开工作台不需要录屏工具。

验证构建产物时，先停止 dev，再执行 `pnpm build`、`pnpm start`；另开终端执行 `pnpm preview`，仍打开 5173。start 运行后端 dist，preview 提供前端 dist 并代理 API；Vite preview 用于本地演示，不是公网部署。端口可分别用 APP_PORT、FLOWLENS_API_TARGET 和 `pnpm preview --port 5177` 调整。迁移/seed 可重复执行，不覆盖已有运行和会话。

如需 LIVE，在仓库根目录从 [.env.example](.env.example) 创建被 Git 忽略的 `.env.local`，自行填写 `MODEL_API_KEY`，并设置 `MODEL_MODE=LIVE`、`FLOWLENS_LIVE_APPROVED=1` 与 `FLOWLENS_LIVE_MAX_REQUESTS`，随后重启服务。总请求上限可以是正整数；明确授权持续使用时可设为 `unlimited`，不再因累计超过 12 次停止对话。旧 FIXTURE/订单链路的单轮上限保持原配置；车辆 Pipeline 诊断默认最多 100 次模型请求、200 次实际工具调用、900000 ms、连续 3 轮无新增观测及 262144 字节消息上下文。用 `FLOWLENS_PIPELINE_DIAG_MAX_REQUESTS`、`MAX_TOOL_CALLS`、`TIMEOUT_MS`、`MAX_STALL_ROUNDS`、`MAX_CONTEXT_BYTES`（后四项均加同一 `FLOWLENS_PIPELINE_DIAG_` 前缀）配置为正整数；每个新会话保存有效快照，旧记录未知上限不按新默认推断。重复观测按工具名/规范化参数/来源版本/实际输出识别，不因新 UUID 重置；日志按绑定执行中的原始序号及实际内容去重，改变读取量、筛选或 MCP 外层元数据不算新增日志。达到上限明确停止，工具失败计入次数，默认每次输出最多 2048 tokens。密钥仅由后端读取；旧诊断任务数据为 FIXTURE，本地修复使用 SYNTHETIC 合成输入。全局 LIVE 有限调用计数目前仅在进程内有效，重启会重置；M6.3 单个循环的轮次/请求数持久化，重启将活动循环标为中断，不自动继续。旧诊断的模型用量在 `model.completed.usage` 日志中记录，本地修复会话保存请求数与 usage，不将 token 数写成实际金额。

## 检查与定位

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm check:pipeline:start       # build 后运行；隔离库 + MOCK 验证 start/preview
```

已配置并授权 LIVE 时，可运行 `pnpm eval:pipeline:live` 或 `pnpm eval:pipeline:live:browser`：**会实际调用付费模型**。前者在独立库以脚本测试批准验证 A/B；后者以浏览器点击验证 A 的完整操作并录屏。每次进程总上限为现有预算与8次取较小值，不改 `.env.local`。完整 SQL、工具与结果保存为报告；测试批准不能标成用户人工审批验收。普通 `pnpm test`、Playwright 与 `check:pipeline:start` 都使用 MOCK，不产生模型费用。

`test:e2e` 使用本机 Chrome、独立临时 SQLite 和测试端口，不修改开发库。实际 M4 命令与环境证据见 [P0 验收报告](docs/p0-acceptance.md)；M3 已于 2026-10-01 获用户人工确认。服务端输出不含密钥、完整 Prompt 和工具正文的 JSON 结构化日志，可用 request_id、session_id、turn_id 关联问题；logs/、data/、.env.local 不纳入仓库。

新的自主取证机制与两条真实工具路线见 [验收记录](docs/pipeline-agent-adaptive-acceptance.md)。普通测试使用受控网关/MOCK，不以此宣称 LIVE 推理质量；LIVE 评测默认共享上限 8，可通过 `FLOWLENS_PIPELINE_EVAL_LIVE_MAX_REQUESTS` 显式配置隔离评测上限，仍不得超过既有付费授权。

2026-10-08 完成 [四项维护改造及验收](docs/pipeline-maintenance-acceptance.md)：Prettier 及 CI 格式检查、日志分页取证、基线加增量历史与最新批次撤销、六个只读工具的真实 MCP stdio 接入。最终通过 167 后端 / 48 前端测试、45 个 MOCK E2E、build/start 及两组离线评测；实际协议和模型回写证据已保存。本轮未调用 LIVE。`pnpm format` 可重复整理项目源码、配置和文档，忽略生成报告、媒体、数据库和依赖；编辑器使用同一规则。

2026-10-08 已补充 [LIVE 多轮取证与历史面板修复记录](docs/pipeline-feedback-history-acceptance.md)：首份观测前只允许单项取证，全部工具仍可供模型选择，后续可同轮读取多项。页面按实际模型请求展示调查问题、已有证据及调用结果；切换执行历史时明确原始失败、关联验证或批准预检，普通重跑不沿用旧诊断。`pnpm eval:pipeline:feedback` 在新建隔离合成库中运行付费 LIVE 取证、验证、测试入库和撤销，要求已有 LIVE 授权；每次最多 8 个共享请求，不修改用户业务库。

## 六问评测与 CI

```powershell
pnpm build
pnpm eval:mock                  # 独立库、MOCK，不读 .env.local，不产生付费请求
pnpm eval:live                  # 只打印固定问题及判定要求，不调用模型
pnpm eval:live --execute-live   # 显式运行；先配置 LIVE、批准、预算和 2048 输出上限
```

六问使用 fixtures/evals/m4-p0.json，参考要求只参与脚本判定，不传给 Agent。三个场景各两问，另加 S04 按钮批准后追问；会创建独立评测库和临时本机服务（前端 5175），不修改开发库。每次运行写入新的 logs/m4/live-* 或 mock-*，包括原始回答、来源核对、服务端 JSONL、请求数、usage、首 delta、页面反馈、截图和浏览器录屏；机械检查通过后仍需读回答检查误导措辞。金额未由提供商返回。

M5 第一批扩展使用独立的 `fixtures/evals/m5-p1.json`，六场景各两问，另加 S04 批准后追问。执行 `pnpm eval:mock --m5` 做离线检查；`pnpm eval:live --m5` 只打印计划，`pnpm eval:live --m5 --execute-live` 才进行付费评测。产物保存在新的 `logs/m5/` 子目录，原 P0 oracle 和历史评测保留。当前范围与实际结果见 [M5 记录](docs/m5-acceptance-plan.md)。

[正式记录与失败基线](docs/evals) 和 [35.64 秒 LIVE 浏览器录屏](docs/demos/p0-live-20261001.webm) 已保留。三个阶段实际共 30 次 DeepSeek 请求、73,557 usage tokens（输入+输出）；最终六问及额外追问为 14 次、37,821 tokens，每次输出最多 2048。固定样本最终 6/6 根因与最低证据检查通过，S05 2/2 合理保留判断；不宣称生产准确率。

[离线 CI](.github/workflows/p0.yml) 在 push/PR/手动触发时执行 format:check、typecheck、lint、test、build、Chrome MOCK E2E、P0六问eval:mock及M5十二问eval:mock --m5；不使用模型密钥或调用 LIVE。M5完整代码abe084f已推送main，[远端CI](https://github.com/Leslie0957/FlowLens/actions/runs/37099175510)全部通过，交付证据见[最终版本记录](docs/evals/m5-release-20261003.json)。本机可用 `powershell -NoProfile -File scripts/verify-clean.ps1` 复制当前交付到不含 node_modules、密钥或数据库的新目录，执行锁定安装及全套检查，并验证实际 start/preview；产物保留在 logs/m4/clean-*。这是同一 Windows 设备上的干净目录验证，不冒充另一台机器实测。E2E 前端使用系统分配的可用本机端口并启用 strictPort；需要固定端口时可设置 FLOWLENS_E2E_WEB_PORT，API 测试端口仍为4174。

## 当前边界

M5 页面与压力检查使用 `pnpm test:e2e -- tests/e2e/m5-pages.spec.ts`：验证历史/场景/时间筛选、10000条日志和200工具记录及400工具事件、360/768/1440宽度。压力数据只写测试临时库，不进入开发库；合成工具轨迹不代表真实模型执行200次查询，付费请求0。JSON报告及布局截图/指标保存在新的 `logs/m5/e2e-*.json`，不据此宣称生产负载能力。构建后的本地演示沿用 start/preview；当前设备未检测到Docker命令，容器部署未验证。

- S05 已增加能力提示、重试资格与原因语义校验，NONE 仅允许正常运行；S04 模型上下文明确模拟重试不能验证真实上游恢复。2026-09-30 m3-2 有限 LIVE 复测中，两处主要问题未重现，S04 审批后也未重复建议重试；m3-3 独立提供模型来源，真实复测已区分 DeepSeek LIVE 与 FIXTURE 任务。实际失败基线、修复与剩余措辞问题见 M3 记录。后端始终拒绝 S05 重试。
- M3、M4/P0 已于 2026-10-01 获用户人工确认。M4 增加 JSON Output、UNKNOWN 待确认语义校验、已知失败原因的日志引用要求与独立计时；失败基线和最终实际评测均保留。仍依赖一次输出修复，真实网络故障、跨浏览器、保留集及回答稳定性未验收；版本交付结果见报告与 GitHub Actions。
- m3-4 明确区分模型的只读工具与平台的审批后模拟执行。聊天里说“执行一次模拟重试”只会得到建议；实际需点击“申请重试”→“批准模拟重试”。真实三轮已复测按钮流程与批准后无重复建议；新运行结果可点击“查看模拟重试运行”核对。
- 不提供登录/RBAC、通用任务执行器、任意 Shell、向量检索或公网部署。M6.2 的单次批准及 M6.3 的单独有限循环授权均只允许修改当前本地项目的 `task.sql`；执行器仍只运行固定结构的订单聚合 SQL，不连接真实业务。故障手册使用确定性关键词检索与引用。
- SSE 续传和历史恢复已实现；M6.3 循环重启后只保留历史并标记中断，Agent checkpoint/Continue 继续暂缓。

## 文档与来源

- [产品需求](docs/FlowLens_PRD_v0.1.md) · [当前架构](docs/architecture.md) · [API 与事件](docs/api-events.md) · [扩展方式](docs/extensions.md)
- [M3 验收记录](docs/m3-acceptance-plan.md) · [M4 交付计划](docs/m4-delivery-plan.md) · [P0 验收报告](docs/p0-acceptance.md) · [M5 记录](docs/m5-acceptance-plan.md) · [阶段进度](docs/implementation-progress.md)
- [工程问题记录与面试素材](docs/engineering-cases.md)：真实失败样本、定位依据、修复取舍、回归证据与讲解边界。
- M6.1 已通过人工验收；M6.2 与 M6.3 已开发、待人工验收：[需求与阶段范围](docs/FlowLens_M6_PRD.md) · [验收计划和实际检查](docs/m6-acceptance-plan.md) · [实施交接](docs/m6-ai-handoff.md)。
- [Runbook](docs/runbooks) · [场景数据](fixtures/scenarios) · [测试](tests/e2e)
- miniClaude 教程项目只作为架构参考；FlowLens 的 Agent Loop 和产品代码自行实现。[来源说明与上游 MIT 许可](third_party/mini-claude/NOTICE.md)仅说明参考项目的来源，不代表 FlowLens 整体采用 MIT 许可。
