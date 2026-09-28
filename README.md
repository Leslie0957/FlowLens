# FlowLens

基于 Vue 3 和 TypeScript 的数据任务 Agent 诊断工作台。用户可查看模拟任务的运行状态与日志，让 DeepSeek 或确定性 Mock 调用只读工具分析故障、追溯证据，并在人工审批后执行**模拟**重试。当前为 Windows 本地单用户演示，任务数据均为独立构造的 FIXTURE，不连接真实业务系统。

## 功能

- S00 正常、S04 上游超时、S05 信息不足三个演示场景；运行状态和日志由 SQLite 持久化。
- 诊断会话、流式事件、只读工具轨迹、结构化结论与日志/Runbook 引用定位。
- 断流续传、事件去重、取消与服务重启恢复；审批、幂等请求和模拟 child run。
- MOCK 模式无需密钥；LIVE 模式需在服务端显式配置 DeepSeek 和调用上限。

## 技术栈

Vue 3、TypeScript、Vite、Pinia、Element Plus；Node.js、Express、SQLite、Zod；SSE、Vitest、Playwright。前后端与共享契约使用 pnpm workspace。

## 本地运行

需要 Node.js 24 与 pnpm 11。Windows PowerShell 中执行：

```powershell
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 <http://127.0.0.1:5173/runs>。默认 `MODEL_MODE=MOCK`，无需 API Key。进入 S04，创建会话提问“这次为什么失败？”，可查看证据并申请模拟重试；S00 是正常任务，S05 故意缺少根因信息，不允许重试。开发 API 默认仅监听本机 `127.0.0.1:4173`。

如需 LIVE，在仓库根目录从 [.env.example](.env.example) 创建被 Git 忽略的 `.env.local`，自行填写 `MODEL_API_KEY`，并设置 `MODEL_MODE=LIVE`、`FLOWLENS_LIVE_APPROVED=1` 与 `FLOWLENS_LIVE_MAX_REQUESTS`，随后重启服务。密钥仅由后端读取；任务数据仍为 FIXTURE。调用计数目前仅在进程内有效，服务重启会重置。请自行控制真实 API 用量。

## 检查与定位

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

`test:e2e` 使用本机 Chrome、独立临时 SQLite 和测试端口，不修改开发库。最近一次 M3 离线回归：服务端 52/52、前端 14/14、Chrome 11/11；M3 仍待人工验收。服务端输出不含密钥、完整 Prompt 和工具正文的 JSON 结构化日志，可用 `request_id`、`session_id`、`turn_id` 关联问题；`logs/`、`data/`、`.env.local` 不纳入仓库。

## 当前边界

- S05 的真实模型多轮回答曾重复建议获取演示环境不存在的详细日志，也容易使人误以为可批准重试；这是待修的 M3 人工验收问题。后端会拒绝 S05 重试。
- M3 的自动化可靠性检查已通过；真实 DeepSeek 多轮质量、网络故障和跨浏览器表现尚未完成正式验收。M4 的 6 条真实模型评测、CI、录屏和 P0 验收报告尚未交付。
- 不提供登录/RBAC、真实任务执行器、文件修改、Shell、向量检索或公网部署。故障手册使用确定性关键词检索与引用。

## 文档与来源

- [产品需求](docs/FlowLens_PRD_v0.1.md) · [架构](docs/m2-architecture.md) · [M3 验收记录](docs/m3-acceptance-plan.md) · [阶段进度](docs/implementation-progress.md)
- [Runbook](docs/runbooks) · [场景数据](fixtures/scenarios) · [测试](tests/e2e)
- miniClaude 教程项目只作为架构参考；FlowLens 的 Agent Loop 和产品代码自行实现。[来源说明与上游 MIT 许可](third_party/mini-claude/NOTICE.md)仅说明参考项目的来源，不代表 FlowLens 整体采用 MIT 许可。
