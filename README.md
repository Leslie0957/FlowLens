# FlowLens

数据任务智能诊断工作台。当前仅完成仓库与本机工具准备，产品功能尚未实现。

## 开始前必读

1. [产品需求](docs/FlowLens_PRD_v0.1.md)：决定产品范围与验收标准。
2. [验收先行开发规范](skills/acceptance-first-development/SKILL.md)：决定测试、日志、实现和排错方式。
3. [实施进度与交接](docs/implementation-progress.md)：记录实际状态和下一步。

目标为 PRD 的 P0：固定任务数据 S00/S04/S05、真实模型与 Mock 双模式，以及诊断、证据展示、人工审批、模拟重试闭环。当前不实施 P1/P2。

默认方案为 Windows 本地单用户、Vue3 + TypeScript、Node.js、SQLite 和 pnpm workspace。工程依赖尚未安装或锁定，没有可执行的应用启动、测试或构建脚本。

每阶段先明确验收场景和验证方式，取得用户确认后实施；结束时更新进度记录并等待确认。模型密钥仅放在服务端本地环境变量中，不提交到 Git。现有本地历史及实习资料不作为产品实现输入，也不纳入首次提交。
