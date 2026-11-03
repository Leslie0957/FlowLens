# 信息不足时的动作判断：评估层 Prompt 实验

## 当前接入状态（2026-10-30）

用户要求先接入网页后，已将逐字验证过的 grounded-actions-v1 提升为 PipelineAgent 的默认指令。共用来源为 `apps/server/src/pipeline-prompts.ts`；原版与新版 hash 分别保持 be6d5b00… 和 5b5425cb…。未加入尚未验证的后续措辞改动。

新建的默认网关诊断保存 prompt_version 和 prompt_sha256，网页展开“本次诊断上限”即可查看；旧记录不补标，新规则不自动重跑旧诊断。版本字段为可选 JSON 属性，无需数据库迁移。测试注入的自定义网关不冒称生产默认策略。

评估脚本仍可显式使用 baseline，并在 Agent 默认指令已更新时准确恢复原版；grounded-actions-v1 不会叠加两次。历史报告及冻结数据不改。下文“仅评估层、尚未接入”的文字描述此前实验阶段，不是当前状态。

接入验证：后端定向 76/76、前端 49/49、构建和 lint 通过。实际 HTTP 测试证明网页诊断端点使用新默认指令并保存版本；页面测试覆盖新版显示与旧记录兼容。没有在用户项目里创建测试任务或自动批准入库。

本机检查时 5173 被另一项目占用，FlowLens 实际使用 `http://127.0.0.1:5174/pipeline`，代理后端 4173。已确认页面加载新版本显示及模板 API。以后启动以 Vite 实际输出端口为准，不能仅凭页面可打开认定 5173 是 FlowLens。

## 问题与范围

原生产 Prompt 在 D07 effect LIVE 中看到 SQL 和校验通过，却猜测 SQL 应增加 task_id，生成五列输出并被平台拒绝。真实平台只允许四列；目标 task_id 由平台注入。工具同时展示四列契约与六列目标 Schema，但没有字段来源说明。这是有价值的文档语义缺口；模型在已承认关键事实未知时仍提出修改，也是独立的决策问题。

本次先验证通用的决策提示，不扩展工具或业务，也不修改生产 Prompt、冻结案例和答案。`scripts/pipeline-eval-prompts.mjs` 提供两个显式版本：baseline（原样）和 grounded-actions-v1（评估时补充）。默认仍为 baseline。变体不包含案例 ID、错误码、正确 SQL 或具体 task_id 映射答案。

补充规则要求：分清事实/假设/缺口；区分任务输出与目标存储结构；提出 SQL_PATCH 时说明已观察到的 SQL 缺陷及其违反的规则；关键事实不可得时人工交接；有明确列名/投影/条件错误时仍可以修复。没有按某个错误码强制人工处理，也没有要求读取全部工具。

## 使用与记录

```powershell
# 默认仅输出计划，不调用模型
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs --profile=effect --prompt-variant=grounded-actions-v1 --cases=D07

# 离线接入验证，不衡量真实模型推理
pnpm --filter @flowlens/server exec tsx ../../scripts/eval-pipeline-controlled.mjs --profile=effect --prompt-variant=grounded-actions-v1 --simulate --cases=D07
```

实际 LIVE 继续使用现有显式执行开关、独立运行 ID 和有限预算。用户已对必要的 DeepSeek 测试给予持续授权；每次仍保存具体计划与范围，不自动循环调参或运行冻结保留集。

core 的网关适配在每次调用前克隆消息，仅把通用补充规则附加到首条 system 消息。原 Agent 内部消息与生产源文件不改。请求日志的 messages/system_prompt_sha256 记录实际发送内容；agent_system_prompt_sha256 单独保存原指令 hash。wire 日志和逐案例请求里的有效 hash 必须一致；variant 名与补充规则 hash 进入计划，源码快照可复查。

这属于 Prompt 变体实验，不可把与 baseline 的差异说成仅模型随机性变化，也不能在生产工作台未接入时宣称线上行为已修复。仅改变提示仍不能获得工具未提供的目标来源或冲突行细节；正确边界是承认缺口，后续若需定位这些事实，应另行设计受限真实观测。

## 验证方法

离线测试检查 baseline 不变、未知变体拒绝、输入消息不被修改、Prompt 无案例/答案注入、实际网关消息及 hash 一致，并保留预算、停止和隔离测试。受控 MOCK 只证明接入，不证明模型理解。

LIVE 固定模型 deepseek-flash、effect 档、评分 v2 和原开发输入。先执行 D01/D02/D04/D07，再各一次执行剩余 D03/D05/D06，检查保守交接没有抑制 SQL 修复。没有运行 H01—H03 Agent，没有为通过而修改标准答案。

结果见 `docs/evals/pipeline-grounded-actions-live-20261030.json`。所有原始基线、失败、格式纠错与本轮记录均保留。机械检查通过、引用合法、候选正确与自然语言语义正确须分别解释；人工复核字段保持未完成，不把单次开发集结果写成稳定准确率。

## 本轮结果与限制

离线 20/20 通过。LIVE 七个开发案例各一次，共 37 次模型请求；六个 SQL 候选均通过固定、保留、鲁棒性及平台原生校验，D07 返回 MANUAL_REQUIRED 无候选，所有源/目标数据保持不变。D07 的 baseline effect 为错误 SQL_PATCH，本变体使用同一模型、预算与评分得到正确动作，但不能用单次结果证明稳定提升。

五例（D02/D03/D04/D05/D06）先输出 JSON 之外的说明或代码围栏，经一次纠错后完成。诊断文字仍存在将行数一致解释过强、或将目标字段填充来源说得比现有工具证据更确定的情况。不能因候选正确和引用合法就把所有语义判为通过。

生产默认 Prompt 保持不变，当前变体供复核和后续对照。下一步优先审查输出格式及事实边界，不新增业务功能，也不通过隐藏失败或反复改参考答案来提高分数。
