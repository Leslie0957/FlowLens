# M1 工程边界

日期：2026-09-26。M1 只提供演示运行的工程基础和页面，尚无诊断、证据、审批、child run 或公共 SSE。

```text
Vue3 页面 → Pinia/API client → @flowlens/contracts (Zod DTO)
                                 ↓
Express routes → SQLite 查询/场景用例 → node:sqlite + fixture
                                  ↑
                              SceneRunner 定时推进
```

- 根 pnpm workspace 包括 `apps/web`、`apps/server`、`packages/contracts`，M0 探针保留在 `probes/m0`。共享契约由 Zod 定义并推导 TS 类型；页面不导入服务器行类型或 fixture。
- 服务启动时先迁移、再幂等 seed；`db:migrate`/`db:seed` 也可显式执行。迁移通过 `PRAGMA user_version` 记录版本：v1 建任务、运行、日志；v2 建模拟进度和请求去重。测试验证从 v1 样例库升级保留已有运行。后续 M2 的会话、事件、审批表应新增迁移，不清空已有库。
- `task_run` 与 `task_log` 是页面事实来源。S00/S04/S05 JSON fixture 经运行时校验后驱动新实例；最多两个活动 run，其余按插入顺序排队。每次时间线推进将阶段、状态、日志和 `next_event_index` 放在同一事务。重启后读取保存进度继续推进；M3 还需完整验证诊断和审批期间的服务重启竞态。
- `POST /api/v1/demo/runs` 要求 Idempotency-Key；同 key 同请求返回首次快照，变更 payload 返回 409，由 SQLite 唯一约束和事务保证。前端在失败后重试同一场景时复用本次 key。
- 页面使用本机系统字体、无远程字体请求，通过 Vite 代理请求本地 API。后端默认绑定 `127.0.0.1:4173`，前端 `127.0.0.1:5173`；`data_source=FIXTURE` 与 `provider_mode` 分别展示。M1 仅查询模型是否配置，不调用 DeepSeek。
- 当前 API：`GET /health`，`GET /api/v1/capabilities`、`/tasks`、`/runs`、`/runs/:id`、`/runs/:id/logs`、`/demo/scenarios`；`POST /api/v1/demo/runs`。响应使用 `{data}`，错误使用 `{error:{code,message,retryable,request_id}}`。日志读取支持级别/文本筛选、before_seq/after_seq 与上限 200；运行列表默认 20、上限 100。
- 服务端日志是白名单 JSONL，含时间、模块、事件、outcome、request_id、run_id、错误码、状态与耗时；不记录 Key、Prompt、完整请求、完整日志内容。业务运行和日志存在数据库中，不以控制台日志作为状态事实。

选择 `node:sqlite` 是为了当前 Node 24/Windows 本地单机版本避免原生扩展构建；它仍标 Experimental，M2/M3 应继续关注稳定性。SQLite 同步 API 在高并发下会阻塞事件循环；当前仅面向本地单用户与固定演示场景，不宣称可公网部署。Vue/Vite/Express/Element Plus 已在本机实际安装并构建；公开写接口和多用户鉴权不在 P0 本地模式范围内。

参考 miniClaude 的来源与 MIT 许可仍按 [M0 ADR](adr/0001-m0-technical-validation.md)保留。M1 没有复制上游新代码，也没有引入文件修改、Shell 或通用执行工具。
