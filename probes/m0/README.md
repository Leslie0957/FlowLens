# M0 探针（尚非 FlowLens 应用）

在 FlowLens 仓库根目录的 PowerShell 中：

```powershell
pnpm install --dir probes/m0 --frozen-lockfile
pnpm --dir probes/m0 typecheck
pnpm --dir probes/m0 lint
pnpm --dir probes/m0 test
pnpm --dir probes/m0 build
pnpm --dir probes/m0 probe:mock
pnpm --dir probes/m0 probe:failure
```

`probe:mock` 应返回 `COMPLETED`，并显示真实只读工具调用和 `MOCK` 标识。`probe:failure` 故意给出无效证据，预期返回 `FAILED/INVALID_EVIDENCE`、退出码 1。两种探针的业务数据都是合成 fixture，不是生产运行。

日志以 JSONL 写入 stderr，普通结果写 stdout。需要保留脱敏的失败轨迹时：

```powershell
New-Item -ItemType Directory -Force logs/m0 | Out-Null
node probes/m0/dist/cli.js failure 2> logs/m0/failure.jsonl
Get-Content logs/m0/failure.jsonl | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.trace_id -eq '<stdout 中的 trace_id>' } |
  Select-Object timestamp,event,outcome,tool_call_id,error_code,duration_ms
```

`logs/` 已被 Git 忽略。探针默认不写日志文件、无远程遥测；手工保存的日志由操作者决定保留期并按需删除。不要上传未检查的日志。结构化日志采用字段白名单，不输出 Key、Prompt、用户文本或工具结果。

真实调用可使用仓库根目录的 `.env.local`：先执行 `Copy-Item .env.example .env.local`，在自己的编辑器中填入 `MODEL_API_KEY`。该文件被 Git 忽略，内容为本机明文，请勿发送或提交。`probe:live` 会自动读取它；也可继续在当前 PowerShell 中设置进程环境变量，进程变量优先于文件。同一终端设置的变量不会自动传给 Codex 的独立执行进程。

`FLOWLENS_LIVE_MAX_REQUESTS=3` 是一次探针调用次数的示例上限，可调整为 1～12；`FLOWLENS_LIVE_MAX_OUTPUT_TOKENS` 为每次模型输出上限 1～2048。它们用于避免工具循环意外消耗额度，并非产品永久限制或精确金额上限。仅在明确同意真实调用后，将 `FLOWLENS_LIVE_APPROVED` 改成 `1`，然后手动运行 `pnpm --dir probes/m0 probe:live`。无批准标志、无有效上限或无 Key 都会在发请求前拒绝。2026-09-26 已由获授权的执行进程完成 LIVE 验证；脱敏记录及请求次数见 [实施进度](../../docs/implementation-progress.md)。不在文档中放置密钥。



首个有效流事件（非空文本或工具调用 delta）的延迟记录为 `model.completed.first_event_ms`；整次模型请求耗时为 `duration_ms`。查看已保存的真实探针日志：

```powershell
Get-Content logs/m0/live-m0-3-final.jsonl | Where-Object { $_ -match '^\{' } | ConvertFrom-Json |
  Where-Object { $_.trace_id -eq '9246001a-e43a-4919-a069-e4f06e5dc15a' } |
  Select-Object timestamp,event,first_event_ms,duration_ms,usage,error_code
```
