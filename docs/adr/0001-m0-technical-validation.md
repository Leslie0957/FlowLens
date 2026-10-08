# M0 技术验证决策

日期：2026-09-26。状态：M0 技术探针离线与真实 DeepSeek 往返均通过，待用户阶段验收；不代表 P0 应用完成。

## 来源与许可

参考仓库 `https://github.com/Windy3f3f3f3f/claude-code-from-scratch`，本地候选 commit `0b452360866433fde0dc77cd37ada9d303546592`。详见 [只读核验](../m0-upstream-review.md)。根许可证 MIT，版权 `(c) 2025 Windy3f3f3f3f`；[完整许可](../../third_party/mini-claude/LICENSE)及 [来源说明](../../third_party/mini-claude/NOTICE.md)保留在仓库。本轮无整文件复制、无上游源码改动；FlowLens 探针重新实现受限循环、流参数累加、工具结果配对。后续如逐段复制，需在 NOTICE 增列原文件、目标文件及改动范围，并核验所有实际依赖许可证。

## DeepSeek 协议选择

2026-09-26 对照官方[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)及[工具调用指南](https://api-docs.deepseek.com/guides/tool_calls/)：M0 候选使用 `https://api.deepseek.com/chat/completions`、`deepseek-flash`、非思考模式、`stream:true` 和函数工具。流应以 `data: [DONE]` 结束；工具参数为 JSON 字符串，必须本地再校验。旧 `deepseek-chat` 不作为默认模型。规范可能变化，LIVE 时再次核对。随后用户配置了本地 Key 并授权调用；真实 m0-2 与最终复验已证明此配置下流式工具往返可用。

探针使用原生 fetch 而非引入整个上游 Agent 或双 SDK。供应商协议集中于 `probes/m0/src/gateway.ts` 和 `stream.ts`。上线型应用所需公共 SSE、数据库事件、审批及页面不属于 M0。M0 不提供文件写入、Shell、通用读取、MCP、记忆、技能、子 Agent。Tool 注册限四个业务只读名称，运行时 Zod 校验、run/task 绑定、20KB 输出限制和服务端证据登记。

## Windows 与依赖

本机 Windows 10.0.26200 x64、Node 24.14.1、pnpm 11.5.0。M0 probe 锁定 Zod 4.1.12、TypeScript 5.9.3、Vitest 3.2.4、ESLint 9.36.0 等版本，见 `probes/m0/pnpm-lock.yaml`。pnpm 11 仅批准 esbuild 安装脚本。`node:sqlite` 在当前 Node 版本能执行事务、回滚、唯一约束和关闭重开文件测试，但 Node 标注 Experimental；M1 选择正式驱动前需评估 API 稳定性及 Windows 打包，不视为产品数据库决策。

只读查询 npm registry 得到的当前版本/声明：Vue 3.5.43（TS peer `*`）、Vite 8.3.1（Node `^20.19.0 || >=22.12.0`）、Express 5.2.1（Node `>=18`）、Playwright 1.63.0（Node `>=20`）、Vitest 5.0.2（Node `^22.12.0 || ^24.0.0 || >=26.0.0`）；当前 Node 24 落入这些声明，但尚未安装/运行 Vue、Vite、Express、Playwright。M1 仍需锁定和实际 smoke。当前 M0 只运行探针工具链。

## 未验证边界

- 已验证合成任务上的真实 DeepSeek 流式工具往返、首事件/总耗时及 token 用量；费用金额未经账单核实，其他场景准确率未验证。
- MOCK 使用真实只读 ToolExecutor 和合成 fixture，不评估模型诊断质量。
- 无服务端持久化、公共 SSE、幂等、审批或 UI；这些属于 M1—M3。探针的进程内取消/预算测试不能证明数据库并发裁决。
- 没有上游构建/测试结果；固定 commit 的远端 Git 对象已由 GitHub API 与本地 SHA 对照确认。

第一次 LIVE 失败、修复与两次成功 LIVE 结果见 [实施进度](../implementation-progress.md)。
