# FlowLens 文档导航

当前展示主线为车辆 Pipeline：真实 SQL 执行 → MCP 多轮取证 → 修复候选或人工交接 → 人工批准 → 校验入库 → 查询 / 数据撤销。更新时间：2026-11-03。

## 先看这些

| 文档                                       | 适合了解                                          |
| ------------------------------------------ | ------------------------------------------------- |
| [项目首页](../README.md)                   | 项目定位、功能概览、工程亮点与技术栈。            |
| [五分钟展示稿](pipeline-demo-script.md)    | 现场操作顺序与面试讲述口径。                      |
| [当前架构](architecture.md)                | 模块、MCP 调用链、审批、事务与 SSE 状态恢复。     |
| [运行与配置](operations.md)                | MOCK / LIVE、端口、数据库、启动、检查与故障定位。 |
| [HTTP / SSE 契约](api-events.md)           | 当前车辆接口与持久事件，及旧接口历史。            |
| [工程问题与面试素材](engineering-cases.md) | 实际失败、定位、取舍与回归依据。                  |

## 当前车辆链路的实现与证据

- [Agent 评估体系](pipeline-agent-evaluation.md)：10 个真实故障案例、独立参考规则和候选 SQL 验证。
- [受控 LIVE 执行器](pipeline-controlled-evaluation.md)：显式案例、预算、隔离、停止及版本用量追溯。
- [首次保留集 LIVE](pipeline-holdout-first-live-result.md)：H01/H03 自动检查通过，H02 协议失败。
- [协议失败回放与修复](pipeline-investigation-recovery.md) · [修复后开发集 LIVE 回归](pipeline-protocol-recovery-live-regression.md)：真实失败、定向反馈、离线验证及本轮未触发纠错分支的边界。

- [流水线初期验收](pipeline-acceptance.md)：历史 LIVE 样本与当时的流程。
- [自主取证验收](pipeline-agent-adaptive-acceptance.md)：按工具反馈选择后续读取。
- [多轮反馈与历史展示](pipeline-feedback-history-acceptance.md)：实际模型样本、调查说明和历史绑定。
- [四项维护改造验收](pipeline-maintenance-acceptance.md)：格式、日志分页、增量撤销和真实 MCP 通信。
- [重复取证与最终回复纠错](pipeline-observation-fix-acceptance.md)：原失败样本、一次纠错及 Windows 长测试时限。
- [维护计划](pipeline-maintenance-plan.md) · [完成待办](todo.md) · [证据归档](evals)：计划、完成范围与各轮实际产物。

各记录保留当时状态与测试数量；当前入口和实现以首页、架构为准，不能把历史 LIVE 结果写成当前版本的新验收。

## 早期阶段与参考

- [P0 / M6 架构历史](architecture-p0-m6.md) · [初期 PRD](FlowLens_PRD_v0.1.md) · [扩展记录](extensions.md)
- [阶段进度](implementation-progress.md) · [M3](m3-acceptance-plan.md) · [P0 交付](p0-acceptance.md) · [M5](m5-acceptance-plan.md)
- [M6 需求](FlowLens_M6_PRD.md) · [M6 验收](m6-acceptance-plan.md) · [实施交接](m6-ai-handoff.md)
- [故障手册](runbooks) · [合成场景](../fixtures/scenarios) · [浏览器测试](../tests/e2e)
- [上游参考与许可](../third_party/mini-claude/NOTICE.md)
