# FlowLens · 数据任务智能诊断工作台

FlowLens 是一个本地 SQL 数据任务诊断工作台。项目受实习中的排障流程启发，使用合成车辆数据在 SQLite 中执行查询、校验业务结果，并为失败任务提供 Agent 取证、修复建议与人工审批。

- **Agent 取证**通过 MCP 读取当前执行的 SQL、表结构、日志和输出。后端校验证据引用与执行版本，模型可以提出修复，也可以说明信息缺口并交给人工处理。
- **审批与执行**绑定具体 SQL 候选。后端独立校验候选，复用结果事务入库，并记录批次以支持撤销实际新增的数据。
- **工作台**关联展示日志、工具轨迹、证据与 SQL Diff，通过 SSE 同步状态并处理断线恢复、事件去重和项目切换。
- **评估**使用 10 个结构化故障案例和隔离数据库，分别检查证据、处理动作、候选 SQL 和写入约束，支持受控 LIVE 与 Prompt 版本对比。

## 运行与演示

已验证环境为 Windows PowerShell、Node.js 24.14.1、pnpm 11.5.0。在仓库根目录运行以下命令。

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:MODEL_MODE = 'MOCK'
pnpm demo:pipeline
```

打开 <http://127.0.0.1:5180/pipeline>。MOCK 模式使用预设模型响应，SQL、SQLite 和 MCP 实际运行。演示库位于 `data/pipeline-demo/`，API 默认端口为 `4180`。可通过 `FLOWLENS_DEMO_WEB_PORT` 和 `FLOWLENS_DEMO_API_PORT` 修改端口，使用 `Ctrl+C` 停止服务。

1. 打开 **A（列名错误）**，运行预检并发起 Agent 诊断。查看证据和 SQL Diff，批准后查看入库结果，再撤销该批次的数据。
2. 新建 **D07（目标数据冲突）**，运行预检。SQL 结果通过校验，目标库中的同键记录触发冲突。打开诊断查看人工处理建议。

首页还提供 **B（输出契约错误）** 和 **C（正常与幂等重跑）**。LIVE 配置从 [.env.example](.env.example) 复制到 `.env.local`，填入 API Key 和请求预算后启用。

## 评估与验证记录

7 个开发案例用于调试，3 个保留案例用于冻结版本后的验收。执行器复用 Pipeline 和 MCP，在独立 SQLite 中执行候选 SQL，用业务规则计算参考结果，再分别核对固定、留出和边界数据。案例标签仅供评分使用。[案例与评分规则](fixtures/evals/pipeline-v1)

```powershell
# 仅查看开发集计划，不调用模型
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline.mjs --plan

# 开发集的受控离线协议检查，不代表真实模型准确率
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline.mjs --controlled --split=dev

# 只验证候选 SQL 的数据鲁棒性，不调用 Agent 或模型
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-robustness.mjs

# 查看指定案例的受控 LIVE 计划，不发起模型请求
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs --plan --cases=D07 --profile=effect --prompt-variant=grounded-actions-v1
```

2026 年 10 月 30 日，改进版 Prompt 的 7 个开发案例通过自动检查。D07 的原版试验曾给出缺乏依据的 SQL 修改，改进版在该次试验中选择了人工处理。11 月 3 日的首次保留验收中，H01、H03 通过，H02 因模型未发出实际工具调用而失败。增加定向反馈后，3 个开发案例的 LIVE 回归通过，真实模型在该失败分支上的恢复效果仍待验证。

自动检查覆盖证据来源、动作约束和候选结果。根因判断与证据是否充分需语义复核。评估器保存模型请求、工具轨迹、版本和用量到本地 `logs/`。[受控评估入口](scripts/eval-pipeline-controlled.mjs)

## 代码与测试

- Vue 3、TypeScript、Vite、Pinia 和 Element Plus 工作台。[前端](apps/web)
- Node.js、Express、SQLite、Zod 和 MCP 服务。[后端](apps/server)
- 前后端共用的 Zod 数据契约。[契约](packages/contracts)
- Vitest 单元和集成测试、Playwright 浏览器测试及 MOCK 评估。[GitHub Actions](.github/workflows/p0.yml)
