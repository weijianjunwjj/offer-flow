# LLM 分析链路：Prompt / Schema / Eval 工程化说明

> **状态说明**
>
> 本文档主要描述现有 v0.6～v0.7 的 `OFFER_FLOW_JSON` / Prompt / Parser / Eval 工作流。
>
> OfferFlow v0.8 岗位雷达分析引入独立的 `JobMatchAiPayload` 和服务端 Analysis Envelope 契约。
>
> 两套契约不得静默合并或互相替代使用。
>
> v0.8 相关内容请参见：
>
> - `docs/technical/offerflow-v0.8-technical-design.md`
> - `docs/evaluation/offerflow-v0.8-evaluation-plan.md`

本文档说明 OfferFlow 的 LLM 分析链路是如何工程化的：Prompt 如何构造、输出如何约束、解析如何容错、如何用固定样本集验证链路没有退化，以及 AI 输出最终如何经过人工保存门禁。

## 1. 链路目标与边界

OfferFlow 的 LLM 分析链路只做一件事：对 JD、公司信息、求职者画像做结构化分析，输出匹配度、公司评估、机会评分和沟通建议。它不做，也不允许做的事情：

- 不自动把分析结果写成最终的 `communicationStatus` 或 `reviewStatus`。
- 不自动发送 Boss 话术、不自动投递。
- 不在解析失败时静默丢弃或伪造数据。

链路产出先在前端展示为 AI 原文和 `parsed` 预览；只有用户点击“确认并保存分析结果”，`aiRawResult`、解析状态和可用结构化字段才写入岗位记录（见第 6 节）。

## 2. Prompt 模板设计

Prompt 由 `src/app/prompt.ts` 的 `buildAnalysisPrompt()` 构造，是一个纯函数：输入求职者画像（`JobSeekerProfile`）、岗位信息（`PromptJobInput`：公司/岗位/城市/薪资/JD 原文）、公司补充信息（`CompanyInput`：规模/融资阶段/通勤等），拼出完整的 Prompt 文本，不做网络请求、不做副作用。

Prompt 分三段：

1. **上下文**：求职者全局信息 + 目标岗位信息 + 公司与机会补充，字段缺失时统一用 `（未填写）` 兜底，不让 AI 自由发挥缺失字段。
2. **人看的 Markdown 简报**：限定最多 5 段、每段不超过 3 行，第一行强制输出 `综合匹配度：XX%`。
3. **机器解析的 `OFFER_FLOW_JSON` 数据块**：附带一份完整的 few-shot 示例 JSON（`OFFER_FLOW_JSON_EXAMPLE`），并在 Prompt 末尾列出每个枚举字段的允许取值和硬性格式要求（必须用标记包裹、不允许注释、分数必须是 0-100 整数、不知道的字段标 `unknown` 而不是编造）。

当前只有一套模板，`version: "0.2.0"` 是烘焙在 few-shot 示例里的协议版本号，用来标注 `OFFER_FLOW_JSON` 的字段结构版本，不是独立的 Prompt 版本管理系统——项目规模上暂时不需要多模板 A/B。

Prompt 构造逻辑目前被 `server/llm/analyzeJob.ts` 的 `buildAnalyzeJobPrompt()` 包装了一层，供非流式（`/api/llm/analyze-job`）和流式（`/api/llm/analyze-job-stream`）两条路由共用，确保两条路径拿到完全一致的 profile / companyInput 输入（见 `docs/llm-eval.md` 之外的代码变更说明，或直接看 `server/routes/llm.ts` 的 `resolveAnalyzeJobInput()`）。

## 3. OFFER_FLOW_JSON 结构化输出协议

`src/app/offerFlowJson.ts` 定义了这套协议的提取与解析逻辑。

核心字段：

- `matchScore`：顶层整体匹配度（0-100），缺失时会回退到 `opportunityRadar.matchScore`。
- `companyAssessment`：公司评估对象，包含 `sizeTier`（枚举）、`staffRange`、`companyType`、`financingStage`、`stabilityLevel`（枚举）、`growthPotential`（枚举）、`summary`、`confidence`（枚举）。
- `opportunityAnalysis`：机会分析对象，包含 `opportunityScore`、`opportunityRadar`（6 维评分：薪资/稳定性/成长/匹配/通勤/风控）、`applyAdvice`（枚举）、`riskLevel`（枚举）、`decisionSummary`、`interviewFocus`（字符串数组）、`bossGreeting`。

枚举字段（`sizeTier` / `stabilityLevel` / `growthPotential` / `confidence` / `applyAdvice` / `riskLevel`）都有固定允许值列表，非法或缺失值会被归一为 `unknown`（`confidence` 归为 `low`），不会让非法枚举值流入下游。

会被归一化的字段：`matchScore`、`opportunityScore`、`opportunityRadar` 的 6 个维度分数，全部通过 `normalizeScore()` 归一到 0-100 整数区间，超出范围会被 clamp 并记一条 warning，不是直接拒绝。

解析失败时的降级路径：

- 完全没有可提取的 JSON → `not_found`。
- JSON 语法错误 → `invalid_json`。
- JSON 合法但字段缺失/非法 → `partial`（保留能解析出的部分，不整体判定失败）。
- 字段齐全且合法 → `success`。

为什么不能直接信任 LLM 原文：LLM 输出可能夹杂解释性文字、Markdown 包裹、多个 JSON 代码块，甚至枚举值拼写错误或分数超界。这套协议假设 AI 输出天然不可信，所有解析路径都不抛异常，任何输入都能得到一个确定的 `ParsedOfferFlowResult`。

## 4. 容错解析机制

`extractOfferFlowJson()`（`src/app/offerFlowJson.ts:44-69`）：

1. 优先取 `---OFFER_FLOW_JSON_START---` / `---OFFER_FLOW_JSON_END---` 标记之间的内容。
2. 标记缺失时兜底取最后一个 ` ```json ` 代码块（多个代码块时取最后一个，因为最终结构化结果通常在长回复末尾）。
3. 都没有则返回 `null`，交给上层判定为 `not_found`。

`parseOfferFlowJson()`（`src/app/offerFlowJson.ts:87-292`）：

- 字段校验：逐字段检查是否存在、类型是否正确、枚举是否合法，每个问题都会追加到 `warnings` 数组并标记为"硬问题"。
- 分数归一：所有分数字段统一走 `normalizeScore()`，超界会 clamp 并保留 warning，不会因为一个分数越界就整体判失败。
- 状态降级：只要出现硬问题（字段缺失/非法枚举）或 `companyAssessment` 与 `opportunityAnalysis` 同时缺失，状态从 `success` 降为 `partial`；解析过程本身永不抛异常。
- 保留原始文本：无论解析成功与否，`rawText`（AI 原文）都会被完整保留在 `AnalyzeJobOutput.rawText` 中——即使结构化解析失败，用户仍能看到 AI 说了什么，自行判断，而不是被静默吞掉。

## 5. Eval 测试集

样本集在 `eval/offer-flow-json/cases/001-happy-path.md` 到 `010-realistic-noisy-ai-response.md`，共 10 个 case，每个 case 配一份 `eval/offer-flow-json/expected/*.json` 期望结果。覆盖的场景：

| Case | 验证点 |
|---|---|
| 001-happy-path | 标记完整包裹的标准输出，稳定解析为 success |
| 002-markdown-with-json-block | 大量 Markdown 解释文字不影响标记内 JSON 解析 |
| 003-missing-markers-but-json-codeblock | 缺少 START/END 标记时按代码块兜底解析 |
| 004-invalid-json | 标记存在但 JSON 语法错误，判定 invalid_json |
| 005-partial-required-fields | 缺少关键对象时降级为 partial，保留可用部分 |
| 006-score-out-of-range | 分数越界时归一并记 warning，结构完整仍判 success |
| 007-invalid-enum-values | 非法枚举归一为 unknown/空值，降级为 partial |
| 008-multiple-json-blocks | 多个 JSON 代码块、无标记时取最后一个代码块 |
| 009-no-structured-json | 完全没有结构化 JSON，判定 not_found |
| 010-realistic-noisy-ai-response | 接近真实的长回复噪音，标记内 JSON 仍稳定解析 |

运行方式：

```bash
npm run eval:offerflow-json
```

`scripts/offerFlowJson.eval.ts` 会逐个读取 case/expected 文件对，跑通 `extractOfferFlowJson` + `parseOfferFlowJson`，比较实际状态与期望状态、以及关键 warning 是否命中，最终输出 PASS/FAIL 列表和总体通过率。当前实测结果：

```
total: 10
passed: 10
failed: 0
passRate: 100.00%
```

除了这套面向 `OFFER_FLOW_JSON` 协议的 eval，项目还有一套更基础的单元自测（`npm run selftest`），链式跑 storage、解析、评分、决策、Review、OCR adapter、migration 和 snapshot/sync 相关 selftest，用来判断结构化输出链路、决策链路与本地数据基础设施是否退化。

## 6. Human-in-the-loop 边界

当前有两条都遵守 Human-in-the-loop、但实现机制不同的路径：

1. **普通 LLM 岗位分析**：AI 生成结果后，前端先展示原文和解析预览；用户点击“确认并保存分析结果”后，结果才写入岗位记录。该按钮是人工保存门禁，不会设置 `reviewStatus=pending_review`，也不会自动覆盖 JD 原始事实、发送消息、投递或联系 HR。当前没有这条路径的正式 `ReviewRecord` 历史。
2. **JD 导入草稿 Review**：外部草稿以 `importedDraft` 进入 `reviewStatus=pending_review`；`src/review/reviewWorkflow.ts` 只接受 `confirm` / `defer` / `reject` 三种动作。`deriveDecision` 对这类 pending review 优先派生 `manual_review`，确认前不会给出主动跟进动作。当前主要保存最终 `reviewStatus`，同样没有完整 `ReviewRecord` 历史。

Review 状态机边界由 `scripts/reviewWorkflow.selftest.ts` 和 `scripts/decision.selftest.ts` 覆盖，包括“pending_review 阻止直接问候”和“reject 不删除 aiRawResult / importedDraft / parseStatus”等场景。v0.7 计划让画像变更和策略建议采用正式提案审核记录，但 v0.6.2 不开发该能力。

## 7. 面试表达口径

这条链路可以概括为：

> 真实 LLM API 接入（DeepSeek，OpenAI 兼容协议）+ SSE 流式分析 + 结构化输出协议（OFFER_FLOW_JSON）+ 容错解析（标记提取 → 代码块兜底 → 字段校验 → 分数归一 → 状态降级）+ Eval 回归样本（10 个 case，100% 通过）+ 普通分析人工保存门禁；外部 JD 导入草稿另走 pending_review Review。

这套链路要表达的核心工程判断是：LLM 输出不可信任、不可假设格式稳定，所以在"解析"和"状态变更"之间必须插入确定性的校验层和人工确认层——AI 负责分析和初稿，系统负责保存、解析、校验、展示和派生建议，用户负责确认、发送、投递和最终决策。
