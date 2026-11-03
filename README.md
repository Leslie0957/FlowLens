# FlowLens · 数据任务智能诊断工作台

受实习期间数据任务排障场景启发，基于合成车辆数据构建本地 SQL 执行与 Agent 诊断工作台，将任务执行、故障取证、修复审批和数据管理串联起来。

## 功能概览

| 功能           | 说明                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- |
| SQL 执行与校验 | 编辑 SQL，在 SQLite 中实际执行查询，校验输出字段与业务结果，展示执行状态和日志。                  |
| Agent 智能诊断 | 接入 LLM API 与 MCP 工具服务，支持多轮按需取证、证据追溯和信息不足时的人工处理。                  |
| SQL 修复审批   | 生成修复候选与 Diff，经人工审批后执行校验，通过后发布 SQL 版本并事务入库。                        |
| 数据查询与撤销 | 只读查询源数据、目标结果及入库前数据，支持最新有效批次的数据撤销。                                |
| 执行历史回溯   | 关联 SQL 版本、执行结果、诊断证据与审批记录，刷新后可继续查看历史。                               |
| Agent 效果评估 | 结构化故障案例、隔离数据库、独立业务校验及候选 SQL 鲁棒性验证，支持受控 LIVE 与 Prompt 版本对比。 |

## 工程亮点

- **执行与诊断联动**：基于 Vue 3 + TypeScript 构建工作台，关联展示 SQL、日志、证据与 Diff，支持按执行历史查看对应诊断。
- **实时状态与异步控制**：封装 SSE 通信，实现断线恢复、事件去重与项目隔离，处理项目切换、请求取消和迟到响应。
- **MCP 多轮取证**：封装工具参数校验、调用及结果回写流程，模型根据实际返回继续取证；校验执行版本和诊断引用，识别重复观测并限制无进展循环。
- **可重复的诊断评估**：建立 10 个故障案例（7 个开发案例、3 个保留案例）及隔离执行器，分别检查证据来源、处理动作、候选 SQL 和数据安全；通过阈值、数量与顺序变体识别固定数据上的偶然通过。
- **审批与数据一致性**：候选 SQL 单次执行，校验后复用结果入库；通过版本绑定、幂等控制与事务回滚，防止失效或重复提交。
- **增量历史与精确撤销**：采用基线与增量事件保存可重建历史，撤销时仅删除最新有效批次的实际新增行，保留原有数据及当前 SQL 版本。
- **异常回归验证**：使用 Vitest、Playwright 覆盖单元、集成与端到端测试，结合结构化日志验证引用拒绝、请求竞态、事务失败及历史恢复等异常分支。

## 技术栈

| 层级       | 技术                                         |
| ---------- | -------------------------------------------- |
| 前端       | Vue 3、TypeScript、Vite、Pinia、Element Plus |
| 后端与数据 | Node.js、Express、SQLite、Zod                |
| AI 与通信  | LLM API、MCP、SSE                            |
| 测试与工程 | Vitest、Playwright、pnpm workspace           |

项目使用合成车辆数据，在本地真实执行 SQL；支持 MOCK 与 LIVE 模型模式，未接入公司业务系统。

## 运行与演示

已验证环境为 Windows PowerShell、Node.js 24.14.1、pnpm 11.5.0。从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:MODEL_MODE = 'MOCK'
pnpm demo:pipeline
```

打开 <http://127.0.0.1:5180/pipeline>。MOCK 不调用付费模型，SQL、SQLite 和 MCP 仍真实运行。首页提供 A（列名错误）、B（输出契约错误）、C（正常与幂等重跑）、D07（目标数据冲突）四个入口；D07 需在首页新建项目。

推荐先演示 A 的“失败 → 取证 → SQL Diff → 人工审批 → 入库 → 批次撤销”，再用 D07 展示 SQL 校验通过但目标存在冲突时，Agent 应说明信息缺口并交人工处理。真实 LIVE 输出可能失败，不由场景 ID 强制决定动作。

详细配置与启动见[运行文档](docs/operations.md)，演示步骤见[五分钟展示稿](docs/pipeline-demo-script.md)。

## 评估与验证记录

评估案例通过现有 Pipeline 产生真实失败，不要求每个案例新增网页入口。参考标签不进入模型上下文，候选 SQL 在独立 SQLite 中与代码计算的业务参考结果对比；固定数据、留出数据与鲁棒性结果分别保存。

```powershell
# 仅查看开发集计划，不调用模型
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline.mjs --plan

# 开发集的受控离线协议检查，不代表真实模型准确率
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline.mjs --controlled --split=dev

# 只验证候选 SQL 的数据鲁棒性，不调用 Agent 或模型
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-robustness.mjs
```

已开展真实 DeepSeek 开发集评估及 [Prompt 版本对比](docs/evals/pipeline-grounded-actions-live-20261030.json)。首次保留集验收中 H01/H03 自动检查通过，H02 因只返回调查说明、未调用工具而失败；后续保存原失败并补充有界协议反馈及离线回归。修复后的 D01/D02/D07 三例 LIVE 回归通过自动检查，但未触发新纠错分支，真实恢复率仍未知。

这些结果是有限样本的执行记录，不能作为稳定诊断准确率。引用合法、候选验证通过和根因判断正确分别评判；MOCK 不计入真实模型效果。仓库保存结果摘要、版本与哈希，原始请求、SSE 和隔离数据库保留于本地忽略的 `logs/`、临时目录，不随仓库上传。

- [案例、评分与评估运行说明](docs/pipeline-agent-evaluation.md)
- [受控 LIVE 的预算、隔离与停止机制](docs/pipeline-controlled-evaluation.md)
- [首次保留集验收：包含 H02 失败](docs/pipeline-holdout-first-live-result.md)
- [协议反馈修复后的开发集 LIVE 回归](docs/pipeline-protocol-recovery-live-regression.md)
- [工程问题记录与定位过程](docs/engineering-cases.md)
