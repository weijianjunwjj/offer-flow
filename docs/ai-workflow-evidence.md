# OfferFlow AI Workflow 工程化证据表

| 能力 | 当前证据 | 文件路径 | 面试表达 |
|---|---|---|---|
| 结构化 Prompt | `buildAnalysisPrompt()` 将求职者信息、岗位 JD、公司补充拼成 One-Shot Prompt，并要求输出 Markdown + JSON | `src/app/prompt.ts` | 我不是直接把 JD 丢给模型，而是先把输入模板化，让模型按固定任务和字段输出。 |
| 输出协议 | `OFFER_FLOW_JSON` 使用 START / END 标记、固定字段、枚举和 0-100 分数 | `src/app/prompt.ts` | 我给 AI 输出定义了机器可解析协议，避免纯自然语言结果无法落库和复盘。 |
| AI 原文承接 | 岗位记录保存 `aiRawResult`、`aiPastedAt`、`parseStatus` | `src/storage/types.ts`、`src/pages/BattlefieldPage.vue` | 原文永远优先落盘，解析失败也保留审计依据。 |
| JSON 解析 | `extractOfferFlowJson()` 和 `parseOfferFlowJson()` 支持标记提取、代码块兜底、非法 JSON 状态、partial warnings | `src/app/offerFlowJson.ts` | 我把 AI 输出不稳定当成常态处理，解析器永不把失败包装成成功。 |
| OFFER_FLOW_JSON Eval | 10 个 AI 返回样本验证结构化输出协议稳定性，覆盖正常解析、代码块兜底、缺字段、非法 JSON、枚举异常、无结构化输出等情况 | `eval/offer-flow-json/cases`、`eval/offer-flow-json/expected`、`scripts/offerFlowJson.eval.ts`、`npm.cmd run eval:offerflow-json` | 我用 Eval 样本证明协议不是只在 happy path 可用，而能处理真实模型噪音和降级路径。 |
| 状态流转 | `CommunicationStatus` 定义 8 态 Boss 沟通事实状态 | `src/storage/types.ts` | 业务动作不是散落的字符串，而是有限状态驱动的工作流。 |
| Human-in-the-loop Review | AI / 导入结果先进入 `pending_review`，用户确认、暂缓或拒绝后才影响后续决策 | `src/review/reviewWorkflow.ts`、`scripts/reviewWorkflow.selftest.ts`、`src/decision/deriveDecision.ts`、`scripts/decision.selftest.ts`、`src/pages/JobListPage.vue`、`src/pages/BattlefieldPage.vue` | AI / 导入结果不会直接进入自动动作，而是先进入 `pending_review`，由用户确认、暂缓或拒绝。系统通过 `reviewWorkflow` 纯函数和 selftest 约束状态流转，并让 `deriveDecision` 在确认前优先提示人工确认，避免 AI 建议绕过人直接触发跟进。 |
| 人工确认 | Manual / Semi-manual Loop 要求人手动复制 Prompt、粘贴结果、修改状态、决定是否发送 | `README.md`、`src/pages/BattlefieldPage.vue` | AI 只给建议，发送、投递和状态更新仍由人确认。 |
| 规则自测 | `npm.cmd run selftest` 覆盖 storage、`OFFER_FLOW_JSON`、目标画像评分、`deriveDecision`、`reviewWorkflow` | `scripts/storage.selftest.ts`、`scripts/offerFlowJson.selftest.ts`、`scripts/targetProfileScore.selftest.ts`、`scripts/decision.selftest.ts`、`scripts/reviewWorkflow.selftest.ts` | 我用轻量自测证明高风险规则没有被 AI 协作时顺手改坏。 |
| Spec Guard | v0.5 将高风险规则收口为中文规则卡、YAML spec、conformance、differential gate、trace | `docs/v0.5/spec-guard.md`、`spec-lab/README.md`、`spec-lab/traces/2026-06-30-derive-decision-001.json` | 对核心规则，我用 Spec Guard 防止规则漂移，而不是依赖“感觉没问题”。 |
| 本地后端 | Fastify routes + SQLite DB，默认 DB 文件为 `data/offerflow.sqlite3` | `server/index.ts`、`server/db.ts`、`server/schema.ts`、`server/routes/jobs.ts` | 这是本地优先内部工具，不依赖云账号，数据在项目内 SQLite。 |
| 可视化工作台 | 岗位详情页展示 Prompt、AI 原文、解析状态、机会雷达、跟进决策、Review 面板；列表页展示决策筛选和待人工确认标识 | `src/pages/BattlefieldPage.vue`、`src/pages/JobListPage.vue`、`src/components/OpportunityRadarChart.vue` | AI 分析不是停在文本里，而是进入可视化、可筛选、可确认、可跟进的工作台。 |
| Codex 协作规则 | 当前主 AI 协作规则说明 Codex 工作边界、selftest 要求、禁止事项和半个月优先级 | `AGENTS.md` | 我用上下文规则限制 AI 编码工具，避免它扩范围或改错协议。 |
| Claude Code 备用协作规则 | Claude Code 当前暂不可用，`CLAUDE.md` 保留为备用上下文 | `CLAUDE.md` | 多 AI 协作上下文有主备关系，Claude Code 恢复后也必须遵守边界和验收。 |
