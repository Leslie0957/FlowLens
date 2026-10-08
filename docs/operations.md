# FlowLens 运行与配置

当前主入口为车辆 Pipeline，配合[项目首页](../README.md)、[演示稿](pipeline-demo-script.md)和[架构](architecture.md)使用。以下命令以 Windows PowerShell、Node.js 24.14.1、pnpm 11.5.0 为验证环境。

## 独立演示环境

首次运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:MODEL_MODE = 'MOCK'
pnpm demo:pipeline
```

打开 <http://127.0.0.1:5180/pipeline>。API 默认 4180，前端默认 5180；端口已被占用时明确失败。演示目录为 `data/pipeline-demo/`，内含主库、项目数据、服务日志与 `manifest.json` 入口清单。A/B 初次准备实际失败执行，C 待运行；重启复用原项目和历史，不重置已有 SQL 或批次。

终端中显式设置 MOCK 可覆盖已有 `.env.local` 的模型模式，且不会修改配置文件。创建项目、准备失败现场不请求模型，点击 Agent 后才进入诊断。Ctrl+C 停止两项演示服务。

修改端口可在启动前设置：

```powershell
$env:FLOWLENS_DEMO_API_PORT = '4181'
$env:FLOWLENS_DEMO_WEB_PORT = '5181'
pnpm demo:pipeline
```

## 日常开发与构建启动

```powershell
$env:MODEL_MODE = 'MOCK'
pnpm dev
```

打开 <http://127.0.0.1:5173/pipeline>；开发 API 默认仅监听 `127.0.0.1:4173`。服务启动自动迁移和初始化种子数据，已有数据保留；也可单独运行 `pnpm db:migrate`、`pnpm db:seed`。浏览器依赖仅用于 E2E / 评测，不是日常开发启动的前置条件。

查看构建产物时，停止 dev，先运行 `pnpm build`，在两个终端分别执行 `pnpm start` 和 `pnpm preview`；模型模式在后端终端设为 MOCK。preview 默认使用 5173，供本地展示。后端端口由 `APP_PORT` 控制，前端 API 代理由 `FLOWLENS_API_TARGET` 控制。

主库默认 `data/flowlens.sqlite`，可通过 `APP_DB_PATH` 指定路径。其相邻 `pipeline-projects/` 保存各项目源库、目标库与旧流程遗留数据；`local-projects/` 保存早期订单实验。备份时应保留主库及项目目录，迁移旧数据不需要删库重建。数据、日志、密钥和构建产物不纳入 Git。

## LIVE 模型

从仓库根目录的 [.env.example](../.env.example) 创建被 Git 忽略的 `.env.local`，配置 `MODEL_API_KEY`、`MODEL_MODE=LIVE`、`FLOWLENS_LIVE_APPROVED=1` 与正整数 `FLOWLENS_LIVE_MAX_REQUESTS`。在没有终端 MOCK 覆盖的环境启动后端。

LIVE 会实际请求付费模型，页面展示实际来源。仅在明确接受持续调用时使用 `unlimited`；请求额度有限模式当前在进程内计数，重启会重置，不能作为持久费用账本。服务端读取密钥，MCP 工具子进程不继承模型密钥。

车辆诊断的默认预算如下；新会话持久保存生效值，旧记录未知预算不按新默认推断：

| 配置                                       | 默认值                |
| ------------------------------------------ | --------------------- |
| `FLOWLENS_PIPELINE_DIAG_MAX_REQUESTS`      | 100 次模型请求        |
| `FLOWLENS_PIPELINE_DIAG_MAX_TOOL_CALLS`    | 200 次工具调用        |
| `FLOWLENS_PIPELINE_DIAG_TIMEOUT_MS`        | 900000 ms             |
| `FLOWLENS_PIPELINE_DIAG_MAX_STALL_ROUNDS`  | 连续 3 轮无新增观测   |
| `FLOWLENS_PIPELINE_DIAG_MAX_CONTEXT_BYTES` | 262144 字节消息上下文 |

全部配置须为正整数，仍受共享 LIVE 授权预算限制。每轮工具反馈、引用和原回复保留在历史中；达到预算明确停止，LIVE 失败不会静默改用 MOCK。

## 测试与评测

Playwright 依赖通过 `pnpm exec playwright install chrome ffmpeg` 安装；E2E、`check:pipeline:start`、P0 / M5 MOCK 评测使用独立数据库和端口，保留开发库。完整离线检查命令如下：

```powershell
pnpm exec playwright install chrome ffmpeg
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm check:pipeline:start
pnpm eval:mock
pnpm eval:mock --m5
```

以下是显式 LIVE 评测入口，调用前须配置上述授权和预算：

- `pnpm eval:pipeline:live`：隔离库中的 A/B 诊断、测试批准、校验、入库与撤销。
- `pnpm eval:pipeline:live:browser`：隔离浏览器操作与录屏。
- `pnpm eval:pipeline:feedback`：保存实际请求、公开调查说明、工具结果和多轮反馈依赖。
- `pnpm eval:live` / `pnpm eval:live --m5`：只打印旧 P0 / M5 评测计划；添加 `--execute-live` 才实际调用模型。

车辆 LIVE 评测每次共享请求上限默认 8，仍受已有授权预算约束。测试中的自动批准仅属于隔离验收，不能写成用户人工验收通过。MOCK / 机械评测结果也不能换算为 LIVE 推理准确率。

## 定位问题与早期入口

服务端输出白名单 JSON 结构化日志，使用 `request_id`、`session_id`、`turn_id` 等关联请求与诊断；日志不输出密钥、完整 Prompt 或工具正文。工具正文与原模型回复在绑定会话的证据 / 调查历史中核对。

早期入口保留为 `/runs`、`/diagnoses`、`/demo` 和 `/local`，统一收在侧栏“早期实验与历史”。它们的 FIXTURE 模拟重试和订单有限修复循环有各自授权及预算，详见[阶段文档索引](README.md)，不能与车辆流程的当前能力混用。

常见核对：

- **撤销后预检仍通过**：数据撤销保留修复后的 SQL，预检只读；重新入库仍需批准。
- **首轮工具暂缓**：本次诊断尚无首份工具观测时，批量读取收到调度反馈；先选择一项，返回后可批量读取独立信息。
- **服务重启**：浏览器恢复持久历史，活动诊断明确中断；已批准写入核对目标库凭证，不自动重放没有提交凭证的写入。
- **界面停留在处理中**：先看请求日志与状态核对结果；SSE 断开后客户端会重连并重新读取快照，切换项目时清理旧请求。
