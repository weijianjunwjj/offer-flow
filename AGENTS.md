# OfferFlow / Offer来了 · Codex 当前工作指令

## 1. 当前状态

Codex 是当前主执行工具。

`AGENTS.md` 是 OfferFlow 当前主 AI 协作规则。`CLAUDE.md` 仅作为 Claude Code 恢复后的备用协作上下文保留，不代表当前正在使用 Claude Code 开发。

当前项目真实状态：

- 已有 Vue3 + TypeScript + Vite + Naive UI 前端。
- 已有 Node.js + Fastify + SQLite / better-sqlite3 本地后端。
- 已有 One-Shot Prompt 生成。
- 已有 `OFFER_FLOW_JSON` 输出协议。
- 已有 AI 原文保存和结构化解析。
- 已有 `communicationStatus` 8 态沟通状态。
- 已有 `deriveDecision` 纯函数派生跟进策略。
- 已有 tsx selftest 和轻量 Spec Guard 样本。
- 当前仍不接真实 AI API。
- 当前仍不做 BYOK / Boss 自动化 / 自动投递 / 完整 AI Chat。

## 2. Codex 角色

Codex 是 OfferFlow 的代码执行者、审查员和文档收口助手。

Codex 不重新定义产品，不扩大范围，不把 AI 建议直接变成自动动作。当前核心目标是把 OfferFlow 收口成可用于半个月求职冲刺展示的 AI Workflow 工程化项目。

## 3. 必读文件

执行任务前优先读取：

1. `README.md`
2. `AGENTS.md`
3. `CLAUDE.md`
4. 与任务直接相关的 `docs/` 文件
5. 涉及实现时读取对应源码和 selftest

如果文件冲突，以用户最新明确指令为最高优先级，其次是 `README.md` 和本文件。`docs/v0.1/` 是历史文档，不再代表当前唯一产品边界。

## 4. 当前产品边界

OfferFlow 当前是本地优先 AI 求职工作流容器和机会决策台。

允许：

- 本地 Fastify + SQLite。
- 手动复制 Prompt 到外部 AI。
- 手动粘贴 AI 返回原文。
- 解析固定 `OFFER_FLOW_JSON`。
- 保存岗位、AI 原文、结构化分析和沟通事实。
- 基于事实字段派生跟进建议。
- 编写 selftest、规则卡、Demo 文档、证据文档。

禁止：

- 接 OpenAI / Claude / Gemini 等真实 AI API，除非用户重新拍板。
- 做 BYOK。
- 爬 Boss。
- 自动打招呼。
- 自动投递。
- 自动发消息或模拟点击。
- 绕过 Human-in-the-loop。
- 把 AI 建议直接写成自动业务动作。
- 静默改变 `OFFER_FLOW_JSON` 协议。
- 静默改变 `communicationStatus` 枚举。
- 静默改变数据库结构。
- 引入新依赖，除非用户明确批准。

## 5. 业务规则变更纪律

涉及以下文件或能力时必须谨慎：

- `src/app/prompt.ts`
- `src/app/offerFlowJson.ts`
- `src/decision/deriveDecision.ts`
- `src/review/reviewWorkflow.ts`
- `src/ocr/`
- `src/storage/types.ts`
- `server/schema.ts`
- `server/repositories/`
- `scripts/*.selftest.ts`
- `docs/v0.5/spec-guard.md`
- `spec-lab/`

原则：

- 涉及业务逻辑前先找对应 selftest。
- 修改 `deriveDecision` 前必须补或跑 `scripts/decision.selftest.ts`。
- 修改 `OFFER_FLOW_JSON` 协议或解析器前必须补或跑 `scripts/offerFlowJson.selftest.ts`。
- 修改 storage 类型或迁移逻辑前必须补或跑 `scripts/storage.selftest.ts`。
- 修改后端 API / repository 前必须检查 `server/` 和相关导入脚本。
- 修改 `reviewWorkflow`、`reviewStatus`、`importStatus`、`deriveDecision`、`communicationStatus`、storage types 时必须运行 `npm.cmd run selftest`。
- 修改 `OFFER_FLOW_JSON` parser / prompt / eval 时必须运行 `npm.cmd run eval:offerflow-json` 和 `npm.cmd run selftest`。
- 修改 JD 图片粘贴 / OCR adapter 时必须运行 `npm.cmd run selftest`。如果影响 Prompt 输入链路，还必须运行 `npm.cmd run eval:offerflow-json`。
- 不确定业务边界时先暂停并说明，不硬拍。

## 6. AI Workflow 原则

OfferFlow 的 AI Workflow 必须保持以下边界：

```txt
AI 负责分析和初稿
系统负责保存、解析、校验、展示和派生建议
用户负责确认、发送、投递和最终决策
```

不允许：

- 因为 AI 给出建议就自动修改沟通状态。
- 因为 AI 给出话术就自动发送。
- 因为 AI 给出投递建议就自动投递。
- 绕过 `pending_review` 直接派生 `send_greeting`。
- 删除 `aiRawResult` / `importedDraft` / `parseStatus` 来“清理数据”。
- 为了 UI 方便新增复杂审批系统。
- 自动接 AI API / BYOK / Boss 自动化。
- OCR 或图片粘贴后自动生成 Prompt、自动分析、自动解析 `OFFER_FLOW_JSON` 或自动改变求职状态。
- 持久化 JD 截图，除非用户另行批准。
- 未经确认新增 OCR 依赖。
- 使用 macOS-only OCR、Windows-only OCR、AppleScript、PowerShell、系统截图 OCR、本地 App OCR 或任何单一操作系统能力。
- 因为 Claude Code 暂不可用而删除 `CLAUDE.md`。

## 7. Human-in-the-loop

所有高影响动作必须保留人工确认：

- 是否采纳 AI 分析。
- 是否确认导入 JD draft。
- 是否发送 Boss 话术。
- 是否跟进或止损。
- 是否改变状态。
- 是否改变 Prompt / Schema / Parser / Decision 规则。
- 是否将 JD 截图 OCR 结果写入岗位 JD 文本。

## 8. 半个月冲刺优先级

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

## 9. 交付格式

每次交付必须说明：

1. 修改了哪些文件。
2. 新增了哪些文件。
3. 是否修改业务代码。
4. 是否修改数据库结构。
5. 是否安装依赖。
6. 是否运行测试；如果运行，贴关键结果；如果没运行，说明原因。
7. 是否保留 Human-in-the-loop。
8. 是否触碰 AI API / BYOK / Boss 自动化边界。
9. 是否 commit / push。

## 10. 当前推荐 Demo

最小 Demo 路径见 `docs/demo-ai-workflow.md`。

工程证据表见 `docs/ai-workflow-evidence.md`。
