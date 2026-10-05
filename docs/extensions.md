# P0 扩展位置与限制

2026-10-01。这些是现有替换接口与后续工作说明，不代表已实现 P1/P2。Agent Continue / checkpoint 本阶段暂缓。

2026-10-03补充：M5已交付，M6仅完成[独立需求稿](FlowLens_M6_PRD.md)、[验收计划](m6-acceptance-plan.md)和[实施交接](m6-ai-handoff.md)，没有真实执行或修复代码。下表仍描述现有替换接口；M6.1设计采用独立本地执行契约，M6.2再明确与诊断持久化的适配，不能把替换TaskBackend当作真实执行器已经完成。

后续 M6.1 已按单独授权实现并通过人工验收：`local_project`、`local_revision`、`local_execution` 等 v5 表及 `/api/v1/local-*` 接口独立于上述 FIXTURE 适配点。仅固定订单聚合 SQL 由可信 Node 子进程实际查询内存 SQLite。M6.2 采用独立 v6 本地修复会话、受限只读工具和一次审批/真实验证；v7 修复已应用迁移缺列问题。M6.3 使用 v8 独立有限循环记录，v9 增加停止请求状态，显式授权后最多自动应用并验证三份 `task.sql` 候选；均待人工验收。

| 目标 | 已有接口/文件 | 后续需要做什么 | 已验证边界 |
|---|---|---|---|
| 接真实任务只读查询 | diagnosis-tools.ts 的 TaskBackend：getRun/getDefinition/getLogs | 增加后端适配与状态/日志同步，映射共享 Run/TaskLog；保证稳定 log_id、seq、源版本、绑定运行和取消/超时。 | m3-contracts 用替换实现验证工具/证据协议和越界拒绝。运行列表、审批资格和模拟器仍直接依赖 SQLite；替换工具 backend 并不等于整个平台接入真实执行器。 |
| 增加 RAG | RunbookRetriever.search 返回 RunbookChunk[] | 添加索引、检索实现、稳定 document/version/chunk ID，明确范围与可信来源；仍通过 createTools 注入。 | 当前关键词检索、最多三段；替换检索器证据版本可追溯。未接向量库或 Rerank。 |
| 换模型 | ModelGateway.complete(messages,signal,onDelta?,onFirstDelta?) | 新增网关，将流式正文、工具参数、finishReason、usage 转为 Completion；传递取消和首 delta，处理新模型格式差异。 | 当前 DeepSeek Chat Completions SSE + JSON Output / Mock；注入网关测试用例覆盖修复/暂时失败/取消。不能直接把任意提供商 baseURL 填给 DeepSeek 网关（只允许官方域名）。 |
| 新增只读工具 | ToolRegistry.register({description,schema,execute}) | 可信代码注册，并把同一 registry 传给 Agent；检查作用域、参数、20KB 结果与证据注册。 | m3-contracts 新工具无需改 Agent 循环；通用卡显示名称、用途、ID、时间、状态/耗时，可展开参数与有界结果；未知工具仍可展示。旧记录只保留摘要时显示摘要。 |
| 换数据库 | db.ts、store.ts、diagnosis-store.ts | 抽离当前 SQLite 调用，迁移事务/唯一约束/分页与并发语义；重跑恢复及幂等集成。 | 实际 SQLite v9，旧库升级/重复 seed 已验证；不存在已完成 PostgreSQL 适配。 |

注入入口 `runDiagnosis(...,{gateway,tools})` 与 `createTools(db,{backend,retriever})` 是函数参数，不是开放的 HTTP 插件配置。注册描述、运行时 schema 与执行器要保持一致；新增工具不能绕过现有权限和审批。Agent 四个读工具不接受任意 SQL、文件路径或 Shell。

例如测试中的替换方式：

```typescript
const tools = createTools(db, {backend: readOnlyBackend, retriever: retriever});
await runDiagnosis(db, {
  turnId, sessionId, runId, question, mode: 'MOCK', model: 'test',
  tools, gateway: testGateway,
});
```

这里的变量需要实现现有 TypeScript 接口，并由应用可信入口构造；代码片段只说明注入方式。模式决定来源标识和 LIVE 预算，不得在实际 LIVE 页面注入 Mock 再冒充真实请求。

后续若接真实执行器，需要另行设计授权、幂等副作用、任务恢复、凭据和审计；模拟重试成功不能验证这些能力。模型 loop 的 checkpoint/Continue 同样需要单独范围与验收，当前 SSE after_seq 只负责事件续传。
