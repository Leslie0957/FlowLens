# 调查说明未触发工具调用：离线回归与定向反馈（2026-11-03）

后续验证：[开发集小规模 LIVE 回归](pipeline-protocol-recovery-live-regression.md)中 D01/D02/D07 三例自动检查通过，未触发本错误分支；真实纠错恢复率仍未测得。下文的零 LIVE 请求描述仅指本次离线修复阶段。

## 真实问题与原因

[首次保留集 LIVE](pipeline-holdout-first-live-result.md) 的 H02 连续两次返回只有 `investigation` 的 JSON，`finish_reason=stop`，没有原生 `tool_calls`。现有 Agent 将其当作最终答案校验，正确拒绝了缺少诊断字段的回复；但第一次纠错只提示字段不符合约定，没有明确说明“调查文字没有调用工具”。模型随后又返回调查说明，达到原有一次纠错限制后失败。

这是模型的工具协议输出错误，以及后端纠错反馈缺乏针对性共同暴露的恢复问题。HTTP、MCP、SQL 阈值规则和评分条件没有证据显示故障。不能将 H02 推断为“模型不会判断速度边界”，也不能把这次离线修复称为已提升真实模型恢复率。

## 最小修改

`apps/server/src/pipeline-agent.ts` 增加对“仅包含有效 investigation 的 JSON，且没有原生工具调用”的窄范围识别。在既有 `REPAIR_RESPONSE_SCHEMA` 一次纠错分支中加入 `feedback_type=INVESTIGATION_WITHOUT_TOOL_CALL`，并明确告知：

- 调查说明不是工具执行；若仍需证据，应通过原生 `tool_calls` 选择已注册只读工具，正文中的工具名或计划不会执行。
- 已有证据足够时可直接提交符合现有格式的最终结论，包括有依据的非修改建议；不强制继续调用工具。
- 不得编造工具结果或证据；原有请求、工具、总时限和一次纠错限制继续生效。

没有从文字自动构造工具调用，没有增加重试或纠错机会，没有放宽最终答案、证据或权限校验。普通非法 JSON、其他字段错误及已有完整答案的严格格式纠正继续走原分支。

生产 System Prompt `grounded-actions-v1` 的文本和哈希未改，MCP 与 SQL 白名单未改。**运行时的纠错反馈发生了变化，因此行为版本仍应结合代码哈希区分，不能仅凭 System Prompt 哈希认为整段模型上下文相同。**

## 回放与验证

新增 `fixtures/regressions/pipeline-investigation-only-v1.json`，从 H02 原始记录提取两条回复，只将本次执行的证据 UUID 规范化为占位符。已逐条与原报告核对一致；原始报告 SHA256 仍为 `2fc286e94d8db4ff4b02f2c15066111487b18108e231769654d04b9b2f2017e1`。

新增 `apps/server/test/pipeline-investigation-recovery.test.ts`，在独立临时数据库的已有 B 场景回放。**没有重新执行保留集 Agent，也没有调用真实模型。**

7 项测试覆盖原始两条回复仍会有界失败、收到定向反馈后原生工具恢复、恢复不重置纠错次数、请求耗尽停止，以及三种其他错误回复的兼容路径。恢复路径使用明确标记的受控网关和实际 MCP；人工处理结论只用于检验协议收尾，不作为 B 场景诊断质量或准确率。

修复前 7 项测试中 5 项通过、2 项因缺少定向反馈失败；修复后这 7 项全部通过。连同既有 Agent、工具编排、安全执行、预算、Prompt 与 D07 冲突回归，共 **65/65 通过**。服务端类型检查及修改文件 ESLint 通过。

原始离线报告：

- `logs/pipeline/effect/investigation-recovery-before-20261103.json`
- `logs/pipeline/effect/investigation-recovery-after-20261103.json`

结构化记录见[本次结果摘要](evals/pipeline-investigation-recovery-20261103.json)。本轮新增真实模型请求为 0；未自动补跑 H02，没有覆盖首次保留集失败。后续如验证真实恢复率，应使用新的独立验收资料；已用于此次工程修复分析的 H02 属于回归依据，不能再宣称是未参与改进的保留样本。
