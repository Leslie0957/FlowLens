# M6 实现 AI 交接

2026-10-03。本文是最初的实施交接记录；下文推荐顺序保留当时的历史语境。后续 M6.1 已通过人工验收，M6.2 与 M6.3 均已开发；一个固定合成样本的 LIVE 有限循环实际修复并独立验证 3/100。当前实现、自动化结果与待验收状态以 [M6 验收计划](m6-acceptance-plan.md)末尾记录为准，Agent checkpoint/Continue 未实施。

## 1. 接手顺序

1. 工作目录为 `D:\Downloaad\FlowLens`，当前分支main。先执行git status和diff，保留接手时全部用户改动；不要用reset/clean覆盖本地工作。
2. 阅读README、[v0.1 PRD](FlowLens_PRD_v0.1.md)、[当前进度](implementation-progress.md)、[M6 PRD](FlowLens_M6_PRD.md)、[M6验收计划](m6-acceptance-plan.md)、[架构](architecture.md)和[扩展说明](extensions.md)。
3. 遵循 [acceptance-first-build](../skills/acceptance-first-build/SKILL.md) 与 [change-impact-guard](../skills/change-impact-guard/SKILL.md)。范围来自用户与PRD，不能从miniClaude参考项目引入任意文件修改/Shell能力。
4. 对照已授权阶段工作。第一批建议用户指令为“按M6文档实现M6.1，完成自动化检查后给我人工验收”，不要把整个M6设计稿当作一次性实施M6.2/M6.3的授权。

基准交付：M5完整功能头abe084f，最终文档与main头b88e7cf；最终[CI](https://github.com/Leslie0957/FlowLens/actions/runs/37099663545)通过服务端86/86、前端23/23、Chrome25/25及P0六问/M5十二问MOCK。接手时重新核对HEAD和远端，不能假设仍停在该提交。

## 2. M6.1 推荐实施顺序

| 顺序 | 工作 | 完成依据 |
|---|---|---|
| 1 | 固定L01～L22中的关键验收目标，建立真实执行与独立oracle样例 | 故障/正常/语义错误样例可区分；测试能因能力缺失而失败 |
| 2 | 增量迁移与独立LocalProject/Revision/Execution契约 | 旧库和重复迁移/seed通过，原FIXTURE记录完整 |
| 3 | 实验目录、SQL范围校验和可信Node运行器 | 真实列错误、真实3/100成功和语义错误均可观测 |
| 4 | 生命周期与幂等：启动、取消、超时、重启收尾、限流/输出限制 | 实际进程退出证据与持久化终态一致 |
| 5 | HTTP项目/执行/日志/产物API | 参数/归属/幂等/冲突校验，客户端无command/path/env能力 |
| 6 | 本地执行页面、历史执行选择、来源说明和响应式交互 | Chrome用户路径可操作，刷新不重跑、请求不串场 |
| 7 | dev/start/preview、隔离检查、旧流程回归与实际记录 | 构建包含模板/运行器，P0/M5保持可用，等待用户验收M6.1 |

目录和表名可以按代码风格调整，行为要求不能省略。M6.1不接LLM，不需要消耗付费请求，不修改既有模型Prompt或模拟审批语义。

## 3. 已核对的接入限制

- `packages/contracts/src/index.ts` 的Run、capabilities来源为FIXTURE字面量，scenario_id为S00～S05。不要给真实执行硬贴FIXTURE标签或擅自把本地项目加入六场景枚举。
- `apps/server/src/db.ts` 当前user_version=4，task_run的CHECK只允许FIXTURE，diagnosis_session有task_run外键。M6.1建议独立表、递增迁移，不重建旧任务表；实际版本以接手代码为准。
- `apps/server/src/store.ts` 的advanceDue按fixture时间线推进；真实执行不能通过它生成假日志或切换成功时间线。
- `apps/server/src/diagnosis-store.ts` 的S04审批创建唯一模拟child/action_execution；不能复用该批准来授权真实执行或写源码。
- `diagnosis-tools.ts` 的TaskBackend接口仍使用既有Run类型。M6.2本地诊断接入需要明确契约、持久化和证据绑定，单独换getRun实现不够。
- `apps/server/src/main.ts` 负责启动、恢复和停止，新增运行器必须接入生命周期，不留后台任务或仅改数据库状态。
- `apps/web/src/api.ts` / `router.ts` / `App.vue` 提供API客户端、页面和导航入口；沿用AbortController、请求序号与错误request_id处理。
- `scripts/verify-clean.ps1` 复制当前tracked及非ignored untracked文件到隔离目录，保留开发库/密钥。新增运行器和模板须实际包含在构建交付中；提交前检查新文件是否遗漏。

## 4. 现有数据、模型与质量边界

本机`.env.local`的持续LIVE授权已由用户确认：允许持续对话及按需测试，取消累计总请求上限，每次输出最多2048 tokens。不得打印Key、提交env或清空用户聊天。该授权不意味着自动修复可以无限执行；M6.2/M6.3仍遵守各自阶段预算及审批规则。用户撤销或改变授权时以最新指令为准。

CI和离线验证必须使用MOCK/无Key配置，不能用Mock代表DeepSeek质量；M6.1真实执行测试仍用实际子进程。当前任务输入是合成数据，新执行器只是本地实验，不是真实业务连接。

过去的真实DeepSeek失败样本、措辞风险和有限复核记录保留在M3/M4/M5文档，不宣称生产准确率。Agent Continue/checkpoint由用户暂缓，M6状态收尾不得改写为已实现Continue。

## 5. 阶段收尾

按验收计划记录实际PASS/FAIL/NOT_RUN/BLOCKED、命令、计数、源码版本与日志。更新当前进度，保留原历史。自动化完成时写“开发完成，等待M6.1人工验收”，给用户可直接操作的清单；用户确认后才进入M6.2。未获交付指令时，不因为本文含有基准提交信息就自动提交/推送。

如果拟扩大SQL语法、写文件范围、可执行命令、自动循环或接生产业务，先提供具体范围/验收变更，不把这些当作常规实现选择。其余可逆局部实现选择自行处理，无需反复询问。
