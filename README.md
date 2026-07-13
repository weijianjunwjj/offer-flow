# OfferFlow | AI 求职工作流与机会决策台

OfferFlow 是一个用于验证 AI Workflow 工程化能力的求职工具。它不是普通求职台账，也不是全自动招聘平台；它把 JD 分析和 Boss 跟进拆成一条可控、可追踪、可复盘的半自动工作流，覆盖 LLM 分析、`OFFER_FLOW_JSON` 结构化承接、Human-in-the-loop 门禁、`communicationStatus` 状态流转、`deriveDecision` 决策派生，以及 SSE 流式分析体验。

核心链路：

```txt
JD / 岗位输入
-> LLM 分析 / One-Shot Prompt
-> Markdown + OFFER_FLOW_JSON
-> SSE 流式返回
-> 展示 AI 原文和解析结果
-> 用户确认并保存分析结果
-> communicationStatus 状态流转
-> deriveDecision 决策面板
-> selftest / Eval / Spec Guard 兜底
```

外部 JD 导入草稿走另一条 Review 路径：`importedDraft -> pending_review -> confirmed / deferred / rejected`。两条路径都保留人工门禁，但普通 LLM 分析不会自动进入 `pending_review`。

早期外部 AI 粘贴模式曾用于验证协议与承接流程，当前主流程以 LLM / SSE 为准。

当前版本为 v0.6.2：前端使用 Vue3 / TypeScript / Vite / Naive UI，后端使用 Node.js / Fastify / SQLite / better-sqlite3；在保留 DeepSeek LLM 与 SSE 流式分析链路的基础上，补齐 SQLite migration baseline、snapshot 一致性验证和版本收口。数据默认写入本机运行库 `data/offerflow.sqlite3`，跨设备同步使用 `sync/offerflow.snapshot.json`。

## 项目定位

OfferFlow 的目标不是替用户自动投递，也不是把 AI 直接接成黑盒 Agent。它验证的是：当 AI 参与真实业务判断时，系统如何约束输入、承接输出、保存原文、解析结构化结果、保留人工确认，并把后续行动沉淀为可测试的状态流转规则。

早期版本的模型推理由用户自带的外部 AI 完成，例如 ChatGPT / Claude / Gemini，用于验证协议设计；v0.6 起演进为内置 DeepSeek LLM 分析。无论推理来自哪里，OfferFlow 负责：

- 把简历、偏好、JD、公司补充信息整理成结构化 Prompt。
- 要求 AI 返回给人看的 Markdown 报告和给机器解析的 `OFFER_FLOW_JSON`。
- 保存 AI 返回的完整原文，解析失败也不丢数据。
- 将结构化结果展示为机会雷达、匹配度、风险点和话术建议。
- 通过 `communicationStatus` 和 `deriveDecision` 派生下一步跟进行动。
- 用 selftest 和 Spec Guard 约束高风险规则，避免 AI 协作时悄悄改坏协议或状态规则。

## 当前核心能力

- 结构化 Prompt 生成：`src/app/prompt.ts` 的 `buildAnalysisPrompt()`。
- `OFFER_FLOW_JSON` 输出协议：固定 START / END 标记、枚举、分数和字段层级。
- AI 原文承接：岗位详情页保存完整 AI 返回内容，原文优先落盘。
- JSON 解析与容错：`src/app/offerFlowJson.ts` 支持标记提取、json 代码块兜底、枚举归一、分数归一、partial warnings。
- 机会雷达 / 匹配分析展示：`src/pages/BattlefieldPage.vue` 和 `src/components/OpportunityRadarChart.vue`。
- `communicationStatus` 8 态沟通状态：未沟通、已打招呼未读、已读未回、已回复、面试推进中、暂停观察、已结束、已拒绝。
- `deriveDecision` 跟进策略派生：`src/decision/deriveDecision.ts` 根据事实字段派生策略、下一步动作、止损判断和话术场景。
- 普通 LLM 人工保存门禁：AI 原文和解析结果先展示，用户点击“确认并保存分析结果”后才写入岗位记录；该路径当前不设置 `reviewStatus=pending_review`。
- JD 导入草稿 Review：`importedDraft` 进入 `pending_review` 后，必须由用户确认、暂缓或拒绝。
- Review 决策门禁：`pending_review` 不会直接触发主动跟进建议，`deriveDecision` 会优先派生 `manual_review` / 先人工确认。
- 人工处理结果：`confirmed` / `deferred` / `rejected` 当前保存导入草稿的最终状态并影响后续 `deriveDecision`，但尚无正式 `ReviewRecord` 历史，也不会把 AI 建议直接变成自动动作。
- Human-in-the-loop 人工确认边界：AI 只给分析和建议，用户手动确认、调整状态、决定是否跟进或发送。
- v0.5.1 JD 输入体验增强：新建岗位默认苏州 / 自研业务 / 未融资或不明确，岗位 JD 输入区支持直接粘贴多张截图、预览、删除，并通过手动“转换文字”按钮调用跨端 OCR adapter。
- 本地 Fastify + SQLite 持久化：`server/index.ts`、`server/db.ts`、`server/schema.ts`、`server/routes/`。
- OFFER_FLOW_JSON Eval 样本：`eval/offer-flow-json/` 覆盖真实 AI 返回噪音、异常和降级路径。
- selftest / Spec Guard 证据：`scripts/*.selftest.ts`、`docs/v0.5/spec-guard.md`、`spec-lab/`。
- DeepSeek LLM 分析链路：`server/llm/provider.ts`、`server/llm/analyzeJob.ts`、`server/routes/llm.ts`。
- SSE 流式分析体验：岗位分析结果支持流式返回和前端渐进渲染，减少长时间静默等待。
- 双阶段 AI 演进：早期 One-Shot Prompt / 外部 AI 粘贴用于验证协议，当前主流程已切换为内置 LLM 分析，并复用同一套 `OFFER_FLOW_JSON` 解析、保存和人工确认流程。

## 技术栈

- Vue3
- TypeScript
- Vite
- Naive UI
- Node.js
- Fastify
- SQLite / better-sqlite3
- tsx selftest

## AI 接入策略

早期版本采用 Manual / Semi-manual AI Loop：用户复制 Prompt 到外部 AI，再把 AI 返回结果粘贴回系统。这样做是有意收敛范围，先验证 AI 输出结构化承接、解析、校验、人工确认和状态流转能力，避免过早引入 API Key、费用、模型差异、网络失败等问题干扰核心工程目标。

v0.6 起已接入 DeepSeek API，采用 Chat Completions 兼容格式接入。后端通过 `server/llm/provider.ts` 的 provider adapter 调用模型，`server/llm/analyzeJob.ts` 负责组装请求和解析响应，`server/routes/llm.ts` 提供 SSE 流式分析接口。模型输出仍然复用既有的 `OFFER_FLOW_JSON` 协议、解析器和人工保存门禁，没有另起一套通路。

无论是早期外部 AI 粘贴还是当前内置 DeepSeek 分析，都遵守同一个边界：

- AI 只负责分析和生成建议，不直接执行投递、打招呼、跟进等真实动作。
- 普通 LLM 输出必须由用户检查并点击“确认并保存分析结果”后才写入岗位记录，但不会自动进入 `pending_review`。
- 外部 JD 导入草稿才进入 `pending_review`，由用户 confirm / defer / reject；确认记录当前仅保留最终状态。

## AI 协作与工程治理

本项目开发过程中使用 Codex / Claude Code 等 AI Coding 工具辅助实现，但核心约束通过 Git 版本、README 叙事、selftest、Eval 样本和 Spec Guard 固化，不依赖单一 AI 工具。

## Demo 路径

面试时可以按下面路径演示最小闭环：

1. 启动项目：`npm run dev`。
2. 新增岗位 / 导入 JD。
3. 填入岗位 JD、公司规模、公司类型、通勤、机会备注等补充信息。
4. 触发 LLM 分析。
5. 观察 SSE 流式返回，分析结果打字机式渐进渲染。
6. 检查 AI 原文和解析预览，点击“确认并保存分析结果”。
7. 查看机会雷达、匹配度、风险点和话术建议。
8. 修改 `communicationStatus`，观察跟进决策变化。
9. 查看 `deriveDecision` 生成的下一步建议、策略和止损提示。
10. 如需演示导入 Review，另选一条 `importedDraft`，展示 `pending_review -> confirmed / deferred / rejected`。
11. 运行 `npm.cmd run selftest` 与 `npm.cmd run eval:offerflow-json` 验证自测和 Eval 样本。

早期外部 AI 粘贴模式（生成 One-Shot Prompt，复制到 ChatGPT / Claude / Gemini 等外部 AI，再把返回结果粘贴回岗位详情）曾用于验证协议与承接流程，当前 Demo 以上述 v0.6.2 LLM / SSE 链路为准。

更详细的 Demo 检查清单见 `docs/demo-ai-workflow.md`。

## 本地运行

要求 Node 18+。

```bash
npm install
npm run dev
```

常用命令：

```bash
# 同时启动 Fastify 后端和 Vite 前端
npm run dev

# 仅启动后端 / 仅启动前端
npm run server
npm run web

# 初始化项目内 SQLite DB
npm run db:init

# 检查本机 SQLite 健康
npm run db:doctor

# 一键同步：doctor -> merge snapshot -> export snapshot -> backup
npm run db:sync

# Mac/Windows 之间用 Git 传快照时：
# 有新数据的机器执行：导出 snapshot -> commit -> push
npm run db:publish

# 另一台机器执行：git pull -> merge snapshot -> doctor
npm run db:pull

# 单独导出 / 合并 JSON 快照
npm run db:export
npm run db:import

# 生成安全备份（VACUUM INTO + snapshot 备份）
npm run db:backup

# 导入浏览器 localStorage JSON 备份
npm run import:backup -- path/to/offerflow-web-backup.json

# 导入 personal-os 推来的 JD draft
npm run import:jd-drafts

# 类型检查
npm run typecheck

# OFFER_FLOW_JSON Eval
npm.cmd run eval:offerflow-json

# 自测
npm.cmd run selftest

# 生产构建
npm run build
```

说明：Windows PowerShell 可能拦截 `npm.ps1`，可以使用 `npm.cmd run selftest`。

## 本地数据同步

OfferFlow 默认本地数据优先，不再把 `data/offerflow.sqlite3` 当作跨 Windows / Mac 的同步对象。SQLite 文件只作为每台机器的本地运行库；跨机器同步的是稳定 JSON 快照：

- `data/offerflow.sqlite3`：本机运行库，已从 Git 跟踪中移除。
- `sync/offerflow.snapshot.json`：可同步的数据快照。
- `sync/offerflow.manifest.json`：快照元信息与 SHA-256 hash。
- `backups/`：本机备份目录，不入库。
- `data/corrupted/`：坏库隔离目录，不入库。

启动后端时会先检查本机 SQLite。如果数据库健康且存在 snapshot，会自动做一次保守合并；如果数据库损坏，会把坏库和 sidecar 文件隔离到 `data/corrupted/`，再尝试从 snapshot 恢复。关闭后端时会自动导出最新 snapshot。

## 项目边界

当前不做：

- 不爬 Boss。
- 不自动打招呼。
- 不自动投递。
- 不让 AI 绕过人工确认。
- 不把模型建议直接变成真实动作。
- 不因 JD 截图粘贴或 OCR 自动生成 Prompt、自动分析或自动解析 `OFFER_FLOW_JSON`。
- 不持久化 JD 截图。
- 不做完整 CRM。
- 不做复杂多 Agent 平台。
- 不做真实招聘平台替代品。
- 不替用户做最终求职决策。
- 不把 `strategy`、`nextAction`、`stopLoss`、`scenario`、`companyWarning` 等派生结果持久化为事实。

## 工程证据

能力证据清单见 `docs/ai-workflow-evidence.md`。

已存在的关键文件：

- `src/app/prompt.ts`
- `src/app/offerFlowJson.ts`
- `src/decision/deriveDecision.ts`
- `src/storage/types.ts`
- `src/review/reviewWorkflow.ts`
- `src/ocr/jdImageOcr.ts`
- `src/pages/BattlefieldPage.vue`
- `src/pages/JobListPage.vue`
- `server/db.ts`
- `server/schema.ts`
- `scripts/offerFlowJson.selftest.ts`
- `scripts/decision.selftest.ts`
- `scripts/reviewWorkflow.selftest.ts`
- `scripts/jdImageOcr.selftest.ts`
- `docs/v0.5/spec-guard.md`
- `spec-lab/traces/2026-06-30-derive-decision-001.json`

当前验证重点：

- `scripts/reviewWorkflow.selftest.ts` 覆盖 `confirm` / `defer` / `reject` 状态流转，并约束拒绝后保留 `aiRawResult` / `importedDraft` / `parseStatus`。
- `scripts/decision.selftest.ts` 覆盖 `pending_review` 不直接派生 `send_greeting` 或 `main_attack`，而是先进入 `manual_review`。
- `npm.cmd run eval:offerflow-json` 覆盖 AI 输出样本稳定性，验证 Markdown 噪音、代码块兜底、缺字段、非法 JSON、异常枚举和无结构化输出等路径。
- `scripts/jdImageOcr.selftest.ts` 覆盖 OCR adapter 未配置时必须显式失败，避免页面误以为已完成识别。

## 面试讲法

90 秒版本：

> OfferFlow 是我做的一个 AI 求职工作流与机会决策台。它不是简单调用大模型，也不是自动投递工具，而是把 JD 分析和求职跟进拆成一个可控的 AI Workflow。用户先录入 JD 和公司补充信息，系统触发 LLM 分析，通过 SSE 流式返回 Markdown 报告和固定 `OFFER_FLOW_JSON`；前端先展示原文和解析预览，用户点击确认保存后才写入岗位记录。早期通过外部 AI 粘贴验证协议设计，后来演进为内置 DeepSeek LLM 与 SSE。外部 JD 导入草稿则走独立的 `pending_review` 状态机，由用户确认、暂缓或拒绝；沟通状态再通过 `communicationStatus` 维护，系统通过 `deriveDecision` 纯函数派生下一步建议、跟进策略和止损判断。两条路径都保留 Human-in-the-loop，但实现机制不同，且系统不会自动替用户打招呼或投递。

## Roadmap

当前阶段：

- App 版本仍为 v0.6.2。
- v0.7.0-A 页面与读取基建已完成、合并并推送：Hash Router、JobDetailPage、Page Scope、Runtime Gate 1 与异步竞态/销毁测试均已落地。
- 下一阶段只进入 v0.7.0-B 范围消歧与技术设计，不直接开始代码实施。
- v0.7.0-B 聚焦 ResumeVersion、Job / Application 分离、FeedbackEvent、事件时间线与旧数据兼容。
- 历史补录、基础漏斗和 Runtime SSE Gate 2 属于 v0.7.0-C，不提前实施。

中期可能方向：

- 多 Provider Adapter。
- BYOK。
- 可部署服务版。
- 更稳定的跨端同步方案。

## 版本说明

- v0.1.0：Manual Mode，验证本地求职台账和 AI 原文承接。
- v0.2.0：One-Shot Prompt + `OFFER_FLOW_JSON` + 机会雷达。
- v0.3.0：`communicationStatus` 8 态 + `deriveDecision` 半自动跟进决策。
- v0.4.0：Node Fastify + SQLite，本地后端和项目内数据库。
- v0.4.1：项目内 SQLite 数据库导入真实备份数据。
- v0.5.0：轻量 Spec Guard，针对高风险规则保留规则卡、测试、差分门禁和 trace 样本。
- v0.5.1：JD 输入体验增强，支持截图粘贴、预览和跨端 OCR adapter 入口；当前不内置真实 OCR 引擎。
- v0.5.2：Tesseract.js OCR POC 已在 macOS Chrome 验证通过；方案理论上跨端，Windows 端待补测。
- v0.6.0：DeepSeek LLM 基础接入，基于 Chat Completions 兼容格式实现后端模型调用，对岗位 JD 生成结构化分析，并复用 `OFFER_FLOW_JSON` 解析与人工确认保存流程。
- v0.6.1：DeepSeek LLM SSE 流式分析体验，支持岗位分析结果打字机式渲染，复用统一 `API_BASE`，补齐 SSE CORS，本地分析体验由约 17s 静默等待优化为约 10s 首屏可见并持续流式输出。
- v0.6.2：v0.7 前置稳定性收口，建立 SQLite migration baseline，修复本地 SQLite 与 tracked snapshot 一致性，统一 App 版本并校正普通 LLM 保存与 JD 导入 Review 的文档边界。

当前项目状态：App 版本仍为 v0.6.2，v0.7.0-A 已作为内部实施阶段完成；下一项工程任务是先完成 v0.7.0-B 技术设计，不直接开始代码实施。
