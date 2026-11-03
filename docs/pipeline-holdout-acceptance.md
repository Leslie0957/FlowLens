# 保留集首次 LIVE 验收准备（2026-11-03）

后续状态：用户已明确允许首次验收，并已执行 H01～H03。自动检查 H01/H03 通过、H02 协议失败，完整结果见[首次 LIVE 验收记录](pipeline-holdout-first-live-result.md)。下文保留执行前准备说明；不是当前尚未执行状态。

当前状态：执行入口与离线回归完成，**尚未运行 H01～H03 的 LIVE 评估**。既有 DeepSeek 持续测试授权没有自动解除此前“不执行保留集 Agent 评估”的范围限制。本轮不读取密钥、不调用模型；后续首次 LIVE 需用户明确允许保留集验收。

## 执行范围与防误运行

- 默认仍为开发集、baseline、first 档及仅输出计划。没有默认批量运行，也不默认改成生产 Prompt。
- 保留集必须同时指定 `--split=holdout --allow-holdout` 和显式案例；禁止 `all`、开发/保留案例混用、重复 ID 或省略 ID。
- LIVE 还需要 `--execute-live`、新的一次性 `--approval-id`、`FLOWLENS_EVAL_LIVE_APPROVED=1`，以及独立的 `FLOWLENS_EVAL_HOLDOUT_APPROVED=1`。CLI 和底层评估入口均检查授权。
- 本次拟采用 `grounded-actions-v1`，Prompt SHA256 为 `5b5425cb0f1bf9c454076c6c8336b6f493862a8091cc19f04368067764f8b07b`。H01/H02/H03 分别覆盖不存在的时间列、速度阈值误含等号、微秒时长误用秒阈值。
- 本轮不更改生产 Agent、Prompt、MCP、SQL 白名单、冻结案例、参考答案或历史报告。离线替身执行仅检验协议和夹具，不能当作真实模型效果。

## 冻结与预算

计划快照在 `logs/pipeline/controlled/holdout-plan-20261103.json`，包含 Prompt、评分规则、案例、数据和相关源文件的哈希。实际执行前重新输出计划并核对；若代码或配置改变，旧快照不代表新版本。开始运行后沿用每次模型请求前的版本漂移检查，原始源文件副本保存在实际运行目录的 `source-snapshot/`。

采用已有 `effect` 档：每例最多 20 次请求，配置全局上限 80 次；只选三个案例时实际次数上限为 60。每次输出最多 2048 tokens，工具最多 30 次/例，连续无进展 3 轮停止。单请求/案例/整轮时限为 60/300/1200 秒，HTTP 自动重试为 0。输出 token 配置上界为 122880，输入用量、缓存计费及中断用量不能预先精确确定，这不是费用保证。

## 命令

在仓库根目录 PowerShell 先输出计划，零 API 请求：

```powershell
pnpm --filter @flowlens/server exec node --import tsx ../../scripts/eval-pipeline-controlled.mjs --plan --split=holdout --allow-holdout '--cases=H01,H02,H03' --profile=effect --prompt-variant=grounded-actions-v1 --model=deepseek-flash
```

以下为**尚未执行**的首次 LIVE 命令，仅在用户明确允许保留集验收后使用。审批 ID 若已被使用，不能重复使用；不要自动换 ID 补跑。

```powershell
$env:FLOWLENS_EVAL_LIVE_APPROVED = '1'
$env:FLOWLENS_EVAL_HOLDOUT_APPROVED = '1'
try {
  pnpm --filter @flowlens/server exec node '--env-file=D:/Downloaad/FlowLens/.env.local' --import tsx ../../scripts/eval-pipeline-controlled.mjs --execute-live --split=holdout --allow-holdout '--cases=H01,H02,H03' --profile=effect --prompt-variant=grounded-actions-v1 --model=deepseek-flash --approval-id=holdout-v1-first-live-001
} finally {
  Remove-Item Env:FLOWLENS_EVAL_LIVE_APPROVED -ErrorAction SilentlyContinue
  Remove-Item Env:FLOWLENS_EVAL_HOLDOUT_APPROVED -ErrorAction SilentlyContinue
}
```

每例均使用独立临时数据库，候选只授权隔离验证，不提交目标写入。报告记录 split、计划及实际 Prompt 哈希、真实/模拟保留案例运行次数、原始模型响应、工具轨迹、用量与三组候选校验。失败或预算耗尽仍保留记录，不自动调 Prompt、改答案或重复运行。

## 验收口径

分别检查真实故障是否触发、失败阶段、证据来源、允许动作、固定/留出/鲁棒性候选校验及数据隔离。根因判断和证据语义充分性仍需复核；机械检查通过不等于诊断准确率。未运行、超时和模型错误均保留在完整分母中，不能删去失败后统计成功率。

这三个案例与开发集为相近故障变体，且已被维护者查看，不是外部盲测或生产分布样本。若根据首次结果继续调优，应将已使用案例转为开发资料并另建保留集，不能反复使用同一组结果宣称独立验证。

离线回归：新增 6 项测试，连同相关执行器、Prompt、复核回归共 **32/32 通过**。原始结果为 `logs/pipeline/effect/holdout-entry-offline-20261103.json`。三例受控模拟使用真实 SQLite/MCP，实际 LIVE API 请求为 0，冻结文件保持不变。
