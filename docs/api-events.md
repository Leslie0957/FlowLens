# HTTP 与 SSE 契约

2026-10-01。基础路径 `/api/v1`，默认本机 API 4173；代码权威为 packages/contracts/src/index.ts 与 apps/server/src/http.ts。

## HTTP

成功 `{data:...}`，列表附 page_info；失败 `{error:{code,message,retryable,request_id}}`，响应头 X-Request-Id 可关联日志。POST 只接受已声明字段，不能通过附加 approved/tool 等字段提升权限。

| 方法和路径 | 输入/结果 |
|---|---|
| GET /health | 服务状态（基础路径外）。 |
| GET /capabilities | provider_mode=MOCK/LIVE/UNCONFIGURED，task_data_mode=FIXTURE；LIVE 标志不代表真实业务数据。 |
| GET /tasks、/demo/scenarios | 预置定义和三个场景。 |
| GET /runs | page、limit、status、task_id、q（任务名）；见 listQuerySchema。 |
| GET /runs/:id | 状态、步骤、参数、retry_eligibility、child_run_id。 |
| GET /runs/:id/logs | before_seq 或 after_seq、level、query、limit≤200；两个游标互斥。 |
| GET /runs/:id/logs/:logId/context | 目标 log_id 前后各 20 条，绑定当前 run，超出可见页也能定位。 |
| POST /demo/runs | `{scenario_id}`，202；场景时间线推进。 |
| POST /sessions | `{run_id}`，201；会话绑定运行。 |
| GET /sessions?run_id=... | 工作台历史会话选择器，最多 100 条。 |
| GET /sessions/:id | schema_version=1，session/turns/messages/tool_calls/results/last_event_seq，一致快照。 |
| POST /sessions/:id/messages | `{content}`，去空白后 1～2000 字；202 返回 user_message_id、turn_id。 |
| GET /sessions/:id/events?after_seq=n | SSE 回放后继续读取新事件。 |
| GET /sessions/:id/evidence/:evidenceId | RUN_STATE/LOG/RUNBOOK 的来源、版本、locator、excerpt；跨会话不存在。 |
| POST /turns/:id/cancel | 保留历史、将活动 turn 置 CANCELLED；终态不能被晚到结果覆盖。 |
| POST /runs/:id/retry-proposals | `{turn_id,reason}`，201；服务端验证建议/资格，产生 PENDING 审批。 |
| GET /runs/:id/approvals、/approvals/:id | 审批事实、到期状态和 child ID。 |
| POST /approvals/:id/approve 或 /reject | 按钮动作；批准事务创建新的模拟 child，拒绝不执行。 |

创建运行、会话、消息、重试申请及审批使用 Idempotency-Key。相同作用域+键+请求体回放原响应；同键不同体返回 409 IDEMPOTENCY_CONFLICT。取消已是状态幂等，不要求该请求头。同会话一个活动 turn，应用最多两个活动 turn。

## SSE

```text
id: 42
event: message.delta
data: {"schema_version":1,"event_id":"...","seq":42,"session_id":"...","turn_id":"...","timestamp":"...","type":"message.delta","payload":{"message_id":"...","delta":"片段"}}

```

| 事件 | payload | 消费行为 |
|---|---|---|
| turn.started | status | 将已有 turn 置 RUNNING。 |
| message.delta | message_id、delta | 聚合助手文本；尚非验证结论。 |
| message.reset | message_id、content | 模型请求失败重试/修复时替换未验证片段。 |
| tool.started | tool_call_id、name、args | 创建通用工具轨迹卡。 |
| tool.completed | tool_call_id、summary、可选 output、evidence_ids、duration_ms | 工具成功；证据和20KB内的查询结果已保存，可展开。旧事件不含output仍可读。 |
| tool.failed | tool_call_id、code、message、retryable | 明确失败；模型可在剩余预算内说明限制。 |
| diagnosis.completed | result | Zod 检查后生成稳定结论；不从流式文本授权。 |
| turn.finished | status、可选 error.code | COMPLETED/FAILED/CANCELLED/INTERRUPTED，保留已有内容。 |

前端 reducer 能消费 tool.cancelled；当前取消/重启主要通过终态快照更新工具记录，并不承诺每个取消都会单独发这个事件。心跳是 SSE 注释，15 秒一次，不增加 seq。当前 event envelope 的 type/payload 较宽，reducer 对使用字段作类型检查；不是每个 payload 都有独立严格 schema。

服务端每批最多 500 条，终态仍把未读事件发完；客户端严格检测 seq 缺口并重拉快照。重连由 fetch 流与 AbortController 管理，使用 after_seq，而非依赖浏览器自动 Last-Event-ID。恢复间隔 250ms 至 5s；切会话中止旧连接。重复事件和其他 session 事件不修改当前状态。

2026-10-01 用户要求只看到最终答案：message.delta/reset 仍用于协议与历史恢复，但页面不从它们显示初稿正文。只有 diagnosis.completed 或有效结果快照进入答案卡；当前提交的新 turn 在前端分批展示已校验结果，历史直接显示。同一 turn 的 SSE/快照结果 ID 替换不重播，组件卸载时停止展示计时器；该调整不增加模型请求或改变审批资格。

## 错误定位

INVALID_ARGUMENTS/INVALID_JSON（400）、RUN_NOT_FOUND/SESSION_NOT_FOUND（404）、ACTIVE_TURN_EXISTS/IDEMPOTENCY_CONFLICT/RETRY_NOT_ALLOWED/STALE（409）、TURN_LIMIT（429）、MODEL_NOT_CONFIGURED（503）；具体审批错误见 DomainError。Agent 错误落在 turn.error_code，例如 MODEL_TIMEOUT、TOOL_TIMEOUT、INVALID_RESULT、INVALID_EVIDENCE、SERVER_RESTARTED。复制 request_id 或 turn_id 到 JSON 日志查找，不需要暴露密钥。
