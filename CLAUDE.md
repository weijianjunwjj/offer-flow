# OfferFlow / Offer来了 · Claude Code 备用协作上下文

## 0. 当前状态说明

- 当前状态：备用 / 暂停使用。
- 原因：Claude Code 当前暂不可用。
- 当前主执行工具：Codex。
- 当前主规则文件：`AGENTS.md`。
- 本文件用途：保留 Claude Code 恢复后的协作边界、任务格式、验收标准和禁止事项。

本文件不代表当前正在使用 Claude Code 开发。Claude Code 恢复后，可参考本文件执行小步任务；在此之前，以 `AGENTS.md` 和用户最新指令为准。

## 1. Claude Code 恢复后的角色

Claude Code 恢复后适合作为局部实现和文档同步助手，而不是产品边界决策者。

适合做：

- 局部功能实现。
- 类型补齐。
- selftest 编写。
- 文档同步。
- 小范围 UI 修复。
- Prompt / Schema / Parser 相关的小步迭代。

不适合做：

- 大范围重构。
- 擅自改变产品边界。
- 自动接 AI API。
- 自动改数据库结构。
- 自动引入新依赖。
- 自动生成无法验证的大段功能。
- 绕过 Human-in-the-loop。

## 2. 项目真实状态

OfferFlow 当前不是早期纯 v0.1 localStorage 工具，而是本地优先 AI 求职工作流与机会决策台。

当前已有：

- Vue3 + TypeScript + Vite + Naive UI。
- Node.js + Fastify + SQLite / better-sqlite3 本地后端。
- One-Shot Prompt 生成。
- `OFFER_FLOW_JSON` 输出协议。
- AI 原文保存和结构化解析。
- `communicationStatus` 8 态沟通状态。
- `deriveDecision` 纯函数派生跟进策略。
- selftest 和轻量 Spec Guard 样本。

当前仍不做：

- 不接真实 AI API。
- 不做 BYOK。
- 不爬 Boss。
- 不自动打招呼。
- 不自动投递。
- 不做完整 AI Chat。
- 不做复杂多 Agent 平台。

## 3. Claude Code 任务格式

每次任务必须包含：

- 目标。
- 不做事项。
- 涉及文件。
- 验收标准。
- 需要运行的测试命令。
- 风险说明。

如果任务没有给出这些信息，Claude Code 恢复后应先补齐任务简报，不能直接大范围改动。

## 4. 必读文件

Claude Code 恢复后，执行任务前应读取：

1. `README.md`
2. `AGENTS.md`
3. `CLAUDE.md`
4. 与任务直接相关的 `docs/` 文件
5. 涉及实现时读取对应源码和 selftest

如果文档冲突，以用户最新明确指令和 `AGENTS.md` 为准。`docs/v0.1/` 是历史资料，不再代表当前唯一产品边界。

## 5. 高风险文件

以下文件变更必须谨慎，并优先补或跑测试：

- `src/app/prompt.ts`
- `src/app/offerFlowJson.ts`
- `src/decision/deriveDecision.ts`
- `src/storage/types.ts`
- `server/schema.ts`
- `server/repositories/`
- `scripts/*.selftest.ts`
- `docs/v0.5/spec-guard.md`
- `spec-lab/`

测试对应关系：

- Prompt / `OFFER_FLOW_JSON` 解析：`npm.cmd run selftest` 或 `tsx scripts/offerFlowJson.selftest.ts`。
- 决策规则：`npm.cmd run selftest` 或 `tsx scripts/decision.selftest.ts`。
- 存储和迁移：`npm.cmd run selftest` 或 `tsx scripts/storage.selftest.ts`。
- 目标画像评分：`npm.cmd run selftest` 或 `tsx scripts/targetProfileScore.selftest.ts`。

## 6. AI Workflow 边界

OfferFlow 的 AI Workflow 必须保持：

```txt
AI 负责分析和初稿
系统负责保存、解析、校验、展示和派生建议
用户负责确认、发送、投递和最终决策
```

禁止：

- 自动把 AI 建议变成状态更新。
- 自动发送 Boss 话术。
- 自动投递。
- 静默改变 `OFFER_FLOW_JSON` 字段或枚举。
- 静默改变 `communicationStatus`。
- 静默改变数据库结构。
- 为了“更智能”绕过人工确认。

## 7. 交付要求

Claude Code 恢复后，每次交付必须说明：

1. 改动文件列表。
2. 本次实现内容。
3. 是否修改业务逻辑。
4. 是否修改数据库结构。
5. 是否引入依赖。
6. 自测命令。
7. 自测结果。
8. 遗留风险。
9. 是否触碰 AI API / BYOK / Boss 自动化边界。
10. 建议 commit message。

未运行测试不得声称已验证。

## 8. 当前冲刺优先级

P0：

- 文档收口。
- Workflow Trace / Demo 证据。
- `OFFER_FLOW_JSON` eval 样本。
- `deriveDecision` selftest。
- Human-in-the-loop review 闭环。

P1：

- `ai-os` Skill 文档。
- `personal-os` 事件流 contract。
- 最小 FastAPI prototype。

暂停：

- `energy-os`。
- Boss 自动化。
- AI API / BYOK。
- 完整 Spec 平台。

## 9. 保留原因

不要删除 `CLAUDE.md`。

原因：

- 它保留 Claude Code 恢复后的协作边界。
- 它记录 Claude Code 适合和不适合承担的任务。
- 它可作为多 AI 协作时的备用上下文。
- 当前 Codex 主用不等于 Claude Code 上下文没有价值。
