# FlowLens

基于 Vue 3 和 TypeScript 的数据任务 Agent 诊断工作台。用户可查看模拟任务的运行状态与日志，让 DeepSeek 或确定性 Mock 调用只读工具分析故障、追溯证据，并在人工审批后执行**模拟**重试。当前为 Windows 本地单用户演示，任务数据均为独立构造的 FIXTURE，不连接真实业务系统。

## 功能

- S00 正常、S01 缺字段、S02 SQL 列错误、S03 重复订单、S04 上游超时、S05 信息不足六个演示场景；运行状态和日志由 SQLite 持久化。
- 诊断会话、流式事件、只读工具轨迹、结构化结论与日志/Runbook 引用定位。
- 断流续传、事件去重、取消与服务重启恢复；审批、幂等请求和模拟 child run。
- MOCK 模式无需密钥；LIVE 模式需在服务端显式配置 DeepSeek、批准标志和请求预算（有限次数或已授权的持续使用）。
- 独立历史诊断页、六场景演示页与创建时间范围筛选；历史链接恢复指定会话，日志窗口最多200行、工具轨迹展开每页最多20项。

回答展示：查询与校验期间只显示进度，初稿及修正过程不作为正文显示。最终结论通过服务端校验后，新消息按顺序逐步呈现；刷新或切换会话后直接显示已完成历史。该效果由前端逐步展示已校验的完整结果实现，因此正文开始前仍需等待模型生成和校验；开启系统“减少动态效果”时直接显示全文。

## 技术栈

Vue 3、TypeScript、Vite、Pinia、Element Plus；Node.js、Express、SQLite、Zod；SSE、Vitest、Playwright。前后端与共享契约使用 pnpm workspace。

## 本地运行

验证环境为 Node.js 24.14.1、pnpm 11.5.0、Windows 与 Chrome。Windows PowerShell 中执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chrome ffmpeg
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 <http://127.0.0.1:5173/runs>。默认 `MODEL_MODE=MOCK`，无需 API Key。进入 S04，创建会话提问“这次为什么失败？”，可查看证据并申请模拟重试；S00 是正常任务，S05 故意缺少根因信息，不允许重试。开发 API 默认仅监听本机 `127.0.0.1:4173`。

侧栏的“历史诊断”打开 `/diagnoses`，支持按标题、任务名或运行ID搜索，打开后URL携带指定session；“演示场景”打开 `/demo`，创建任意一个新模拟运行。运行列表的创建时间范围按本地时间填写，包含起止时刻，和状态/任务搜索组合生效。M5 具体操作见 [人工验收清单](docs/m5-manual-acceptance.md)。

`pnpm-workspace.yaml` 已声明允许锁定的 esbuild 依赖运行构建脚本；无需交互执行 approve-builds。Chrome/ffmpeg 用于 E2E 和评测录屏，日常打开工作台不需要录屏工具。

验证构建产物时，先停止 dev，再执行 `pnpm build`、`pnpm start`；另开终端执行 `pnpm preview`，仍打开 5173。start 运行后端 dist，preview 提供前端 dist 并代理 API；Vite preview 用于本地演示，不是公网部署。端口可分别用 APP_PORT、FLOWLENS_API_TARGET 和 `pnpm preview --port 5177` 调整。迁移/seed 可重复执行，不覆盖已有运行和会话。

如需 LIVE，在仓库根目录从 [.env.example](.env.example) 创建被 Git 忽略的 `.env.local`，自行填写 `MODEL_API_KEY`，并设置 `MODEL_MODE=LIVE`、`FLOWLENS_LIVE_APPROVED=1` 与 `FLOWLENS_LIVE_MAX_REQUESTS`，随后重启服务。总请求上限可以是正整数；明确授权持续使用时可设为 `unlimited`，不再因累计超过 12 次停止对话。每轮仍限制 12 次模型请求、8 次工具调用和 120 秒，默认每次输出最多 2048 tokens。密钥仅由后端读取；任务数据仍为 FIXTURE。有限调用计数目前仅在进程内有效，重启会重置；模型用量在 `model.completed.usage` 日志中记录，不将 token 数写成实际金额。

## 检查与定位

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

`test:e2e` 使用本机 Chrome、独立临时 SQLite 和测试端口，不修改开发库。实际 M4 命令与环境证据见 [P0 验收报告](docs/p0-acceptance.md)；M3 已于 2026-10-01 获用户人工确认。服务端输出不含密钥、完整 Prompt 和工具正文的 JSON 结构化日志，可用 request_id、session_id、turn_id 关联问题；logs/、data/、.env.local 不纳入仓库。

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

[离线 CI](.github/workflows/p0.yml) 在 push/PR/手动触发时执行 typecheck、lint、test、build、Chrome MOCK E2E、P0六问eval:mock及M5十二问eval:mock --m5；不使用模型密钥或调用 LIVE。M5完整代码abe084f已推送main，[远端CI](https://github.com/Leslie0957/FlowLens/actions/runs/37099175510)全部通过，交付证据见[最终版本记录](docs/evals/m5-release-20261003.json)。本机可用 `powershell -NoProfile -File scripts/verify-clean.ps1` 复制当前交付到不含 node_modules、密钥或数据库的新目录，执行锁定安装及全套检查，并验证实际 start/preview；产物保留在 logs/m4/clean-*。这是同一 Windows 设备上的干净目录验证，不冒充另一台机器实测。E2E 前端使用系统分配的可用本机端口并启用 strictPort；需要固定端口时可设置 FLOWLENS_E2E_WEB_PORT，API 测试端口仍为4174。

## 当前边界

M5 页面与压力检查使用 `pnpm test:e2e -- tests/e2e/m5-pages.spec.ts`：验证历史/场景/时间筛选、10000条日志和200工具记录及400工具事件、360/768/1440宽度。压力数据只写测试临时库，不进入开发库；合成工具轨迹不代表真实模型执行200次查询，付费请求0。JSON报告及布局截图/指标保存在新的 `logs/m5/e2e-*.json`，不据此宣称生产负载能力。构建后的本地演示沿用 start/preview；当前设备未检测到Docker命令，容器部署未验证。

- S05 已增加能力提示、重试资格与原因语义校验，NONE 仅允许正常运行；S04 模型上下文明确模拟重试不能验证真实上游恢复。2026-09-30 m3-2 有限 LIVE 复测中，两处主要问题未重现，S04 审批后也未重复建议重试；m3-3 独立提供模型来源，真实复测已区分 DeepSeek LIVE 与 FIXTURE 任务。实际失败基线、修复与剩余措辞问题见 M3 记录。后端始终拒绝 S05 重试。
- M3、M4/P0 已于 2026-10-01 获用户人工确认。M4 增加 JSON Output、UNKNOWN 待确认语义校验、已知失败原因的日志引用要求与独立计时；失败基线和最终实际评测均保留。仍依赖一次输出修复，真实网络故障、跨浏览器、保留集及回答稳定性未验收；版本交付结果见报告与 GitHub Actions。
- m3-4 明确区分模型的只读工具与平台的审批后模拟执行。聊天里说“执行一次模拟重试”只会得到建议；实际需点击“申请重试”→“批准模拟重试”。真实三轮已复测按钮流程与批准后无重复建议；新运行结果可点击“查看模拟重试运行”核对。
- 不提供登录/RBAC、真实任务执行器、文件修改、Shell、向量检索或公网部署。故障手册使用确定性关键词检索与引用。
- SSE 续传和历史恢复已实现；Agent 中断后 checkpoint/Continue 按用户要求暂缓，不属于当前 M4。

## 文档与来源

- [产品需求](docs/FlowLens_PRD_v0.1.md) · [当前架构](docs/architecture.md) · [API 与事件](docs/api-events.md) · [扩展方式](docs/extensions.md)
- [M3 验收记录](docs/m3-acceptance-plan.md) · [M4 交付计划](docs/m4-delivery-plan.md) · [P0 验收报告](docs/p0-acceptance.md) · [M5 记录](docs/m5-acceptance-plan.md) · [阶段进度](docs/implementation-progress.md)
- [工程问题记录与面试素材](docs/engineering-cases.md)：真实失败样本、定位依据、修复取舍、回归证据与讲解边界。
- [Runbook](docs/runbooks) · [场景数据](fixtures/scenarios) · [测试](tests/e2e)
- miniClaude 教程项目只作为架构参考；FlowLens 的 Agent Loop 和产品代码自行实现。[来源说明与上游 MIT 许可](third_party/mini-claude/NOTICE.md)仅说明参考项目的来源，不代表 FlowLens 整体采用 MIT 许可。
