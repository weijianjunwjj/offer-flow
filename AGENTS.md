# OfferFlow / Offer来了 · AI 协作规则

## 1. 当前状态

OfferFlow 是本地优先的 AI 求职机会决策台。

- 已有 Vue3 + TypeScript + Vite + Naive UI 前端。
- 已有 Node.js + Fastify + SQLite / better-sqlite3 本地后端。
- 已有 One-Shot Prompt 生成。
- 已有 `OFFER_FLOW_JSON` 输出协议。
- 已有 AI 原文保存和结构化解析。
- 已有 `communicationStatus` 8 态沟通状态。
- 已有 `deriveDecision` 纯函数派生跟进策略。
- 已有 Human-in-the-loop 人工确认流。
- 已有 tsx selftest 和轻量 Spec Guard 样本。
- v0.6 起已接入真实 DeepSeek LLM API（`server/llm/`）。
- v0.6.1 起支持 SSE 流式分析。
- SSE stream 路径 prompt 输入已完成修复，stream / non-stream 使用统一输入构造逻辑（`resolveAnalyzeJobInput` / `buildAnalyzeJobPrompt`）。
- v0.6.2 已建立 SQLite migration baseline、修复 tracked snapshot 一致性并统一 App 版本口径。
- 手动粘贴外部 AI 结果仍保留为备用路径。
- 已有 `docs/llm-eval.md` 说明 Prompt / Schema / Eval / 容错解析 / Human-in-the-loop 链路。

当前仍不做：

- 不接 DeepSeek 之外的其他真实 AI API（如 OpenAI / Claude / Gemini 官方 API），除非用户重新拍板。
- 不做 BYOK（不支持用户自带其他厂商 API Key）。
- 不做 Boss 自动化 / 自动投递 / 完整 AI Chat / 复杂多 Agent 平台。

## 2. 当前阶段

OfferFlow 已完成核心链路收口，进入：

- 简历更新
- Demo 录屏
- 面试项目讲法准备
- 投递沟通

阶段。除非用户重新拍板，不再继续扩展新技术栈或新增大功能。

## 3. AI 工具协作原则

- `AGENTS.md` 是 OfferFlow 唯一完整的 AI 协作规则源。
- Codex、Claude、Claude Code 或其他 AI 工具执行本项目任务时，都应优先读取并遵守本文件。
- `CLAUDE.md` 只作为 Claude 工具的入口说明，不再维护第二份完整规则。
- 如 `CLAUDE.md` 与 `AGENTS.md` 冲突，以用户最新明确指令和 `AGENTS.md` 为准。
- AI 工具不是产品经理，不重新定义产品，不扩大范围，不把 AI 建议直接变成自动动作。

## 4. 必读文件

执行任务前优先读取：

1. `README.md`
2. `AGENTS.md`
3. 与任务直接相关的 `docs/` 文件
4. `docs/llm-eval.md`
5. 涉及实现时读取对应源码和 selftest

如果文件冲突，以用户最新明确指令为最高优先级，其次是 `AGENTS.md` 和 `README.md`。`docs/v0.1/`、`docs/v0.2/`、`docs/v0.5/` 等历史目录只代表当时版本，不再代表当前唯一产品边界。

## 5. 当前产品边界

允许：

- 本地 Fastify + SQLite。
- 当前已接入的 DeepSeek LLM API 调用（`server/llm/provider.ts`），及其 SSE 流式分析。
- 手动复制 Prompt 到外部 AI、手动粘贴 AI 返回原文作为备用路径。
- 解析固定 `OFFER_FLOW_JSON`。
- 保存岗位、AI 原文、结构化分析和沟通事实。
- 基于事实字段派生跟进建议。
- 编写 selftest、规则卡、Demo 文档、证据文档、简历材料。

禁止：

- 接入 DeepSeek 之外的其他真实 AI API，除非用户重新拍板。
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
- 为了堆技术栈引入 FastAPI / RAG / LangGraph / CrewAI / AutoGen / K8s / Redis / MySQL / Postgres。

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
- 绕过 JD 导入草稿的 `pending_review` 直接派生外部动作。
- 删除 `aiRawResult` / `importedDraft` / `parseStatus` 来"清理数据"。
- OCR 或图片粘贴后自动生成 Prompt、自动分析、自动解析 `OFFER_FLOW_JSON` 或自动改变求职状态。
- 持久化 JD 截图，除非用户另行批准。
- 未经确认新增 OCR 依赖。
- 使用 macOS-only OCR、Windows-only OCR、AppleScript、PowerShell、系统截图 OCR、本地 App OCR 或任何单一操作系统能力。

## 7. Human-in-the-loop

所有高影响动作必须保留人工确认：

- 是否采纳 AI 分析。
- 是否确认导入 JD draft。
- 是否发送 Boss 话术。
- 是否跟进或止损。
- 是否改变状态。
- 是否改变 Prompt / Schema / Parser / Decision 规则。
- 是否将 JD 截图 OCR 结果写入岗位 JD 文本。

## 8. 高风险文件与测试纪律

涉及以下文件或能力时必须谨慎：

- `src/app/prompt.ts`
- `src/app/offerFlowJson.ts`
- `src/decision/deriveDecision.ts`
- `src/review/reviewWorkflow.ts`
- `src/ocr/`
- `src/storage/types.ts`
- `server/schema.ts`
- `server/repositories/`
- `server/llm/`
- `server/routes/llm.ts`
- `scripts/*.selftest.ts`
- `eval/offer-flow-json/`
- `docs/v0.5/spec-guard.md`
- `spec-lab/`
- `docs/llm-eval.md`

测试纪律：

- 涉及业务逻辑前先找对应 selftest。
- 修改 `deriveDecision` 前必须补或跑 `scripts/decision.selftest.ts`。
- 修改 `OFFER_FLOW_JSON` 协议或解析器前必须补或跑 `scripts/offerFlowJson.selftest.ts`。
- 修改 storage 类型或迁移逻辑前必须补或跑 `scripts/storage.selftest.ts`。
- 修改后端 API / repository 前必须检查 `server/` 和相关导入脚本。
- 修改 `reviewWorkflow`、`reviewStatus`、`importStatus`、`deriveDecision`、`communicationStatus`、storage types 时必须运行 `npm.cmd run selftest`。
- 修改 `OFFER_FLOW_JSON` parser / prompt / eval 时必须运行 `npm.cmd run eval:offerflow-json` 和 `npm.cmd run selftest`。
- 修改 JD 图片粘贴 / OCR adapter 时必须运行 `npm.cmd run selftest`。
- 修改 LLM / SSE / prompt 输入构造时，必须至少跑相关 selftest、eval 或手动验证，并在报告中说明验证方式。
- 未运行测试不得声称已验证。
- 不确定业务边界时先暂停并说明，不硬拍。

## 9. 当前优先级

P0：

- 更新简历。
- 录制 3-5 分钟 OfferFlow Demo。
- 准备面试项目讲法。
- 开始投递 / 沟通。

P1：

- 仅在真实面试反馈需要时，小范围补文档或修 Demo 体验问题。
- 仅修影响 Demo 或简历事实一致性的 bug。

暂停：

- Python FastAPI sidecar。
- RAG / Embedding / 向量数据库。
- LangGraph / CrewAI / AutoGen。
- Docker / K8s / Redis / MySQL / Postgres。
- Boss 自动化。
- 接入 DeepSeek 之外的新 AI API / BYOK。
- 完整 Spec 平台。
- `energy-os` / `ai-os` / `personal-os` 非必要联动。
- 继续扩 OfferFlow 大功能。

## 10. 交付格式

每次交付必须说明：

1. 修改了哪些文件。
2. 新增了哪些文件。
3. 删除了哪些文件。
4. 是否修改业务代码。
5. 是否修改数据库结构。
6. 是否安装依赖。
7. 是否运行测试；如果运行，贴关键结果；如果没运行，说明原因。
8. 是否保留 Human-in-the-loop。
9. 是否触碰 AI API / BYOK / Boss 自动化边界。
10. 是否 commit / push。
11. 遗留风险和下一步建议。

## 11. 当前推荐 Demo 与材料入口

- LLM / Prompt / Schema / Eval 工程化说明：`docs/llm-eval.md`
- 最小 Demo 路径：`docs/demo-ai-workflow.md`
- 工程证据表：`docs/ai-workflow-evidence.md`
