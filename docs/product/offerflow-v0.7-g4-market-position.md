# OfferFlow v0.7 G4：MarketPositionProfile 与 EvidenceSufficiency 范围冻结

- 日期：2026-07-16
- 上位契约：`docs/product/offerflow-v0.7-release-contract.md` §2.5、§2.6
- 追踪矩阵：`docs/product/offerflow-v0.7-traceability.md`（R3 条目）
- 对应阶段：R3（MarketPositionProfile 与 EvidenceSufficiency）
- 当前结论：G4 工程开始，尚未完成，尚未验收；v0.7 继续禁止发布

## 1. G4 目的

在 G1（岗位匹配画像）、G2（能力基线）、G3（历史与基础漏斗）之上，构建一个统一、形式化、可解释、版本化的市场位置判断系统：MarketPositionProfile + EvidenceSufficiency + DecisionGate。这不是新的职业建议生成器，也不是对 G3 漏斗的再优化——它是把已有三份事实分别读取后的正式判断层。

系统不得自动决策、不得自动降薪、不得自动放弃方向、不得自动触发搬迁。

## 2. 输入边界

只读取：

- G1 的当前 active JobMatchProfile 版本（不读被拒绝/稍后处理的提案）；
- G2 的当前 active CapabilityBaseline 与已接受（accepted / modified_and_accepted）的 CandidateEvidence；
- G3 的正式 Job / Application / FeedbackEvent 与 `aggregateFunnel` 聚合结果（排除未投递、已作废、sandbox 记录）。

不读取：外部招聘网站、Boss 自动化、未授权抓取、临时聊天情绪、未被接受的 AI 草稿、G5 StrategyWindow 结果。

## 3. 城市证据隔离

- 全局画像 + 苏州/无锡/上海/杭州四个独立城市画像；
- 城市级市场反馈只能来自该城市自己的正式流程数据；不得借用其他城市回复作为本城市证据，不得把全局漏斗复制进每个城市，不得把"该城市暂无数据"等同于"该城市不适合"，不得把岗位匹配画像误当作真实市场反馈；
- 跨城市能力证据借用仅允许显式标注 `sourceScope`/`sourceEvidenceId`/`borrowedReason`/`downweight`/`applicability`/`uncertainty`，借用证据永远不构成该城市的真实市场验证。

## 4. 复用而非重建的既有能力

明确禁止建立第二套并行实现，本阶段必须复用：

- 岗位族分类：`src/domain/funnel/jobFamily.ts` 的 `JOB_FAMILIES`/`deriveJobFamily`（五类：ai_applications / fullstack_node / data_platform_frontend / frontend / uncategorized）；
- 漏斗聚合与置信度分级：`src/domain/funnel/aggregate.ts` 的 `aggregateFunnel`/`deriveConfidenceTier`/`deriveProcessStatus`，作为 EvidenceSufficiency 计数（applicationCount/validReplyCount/interviewCount/terminalOutcomeCount/各置信度计数）的唯一来源；
- 城市代码：复用 G1 `src/domain/job-match-profile/types.ts` 的 `JOB_MATCH_CITY_CODES`（苏州/无锡/上海/杭州），不新建第二套城市口径；
- 提案 → 审核 → 正式版本状态机模式：复用 G1/G2 已验收的 `幂等 idempotencyKey + requestHash`、`乐观并发 expectedStateVersion`、`commandReceipts 审计`、`NO_EFFECTIVE_CHANGE 保护` 架构；
- G3 sandbox 基础设施模式（`scripts/g3SandboxPrepare.ts`/`scripts/devG3Sandbox.ts`）：哈希前后一致证明真实库未被触碰、仅升级沙箱副本、`integrity_check`/`foreign_key_check`/行数校验。

## 5. EvidenceSufficiency 三档与保守阈值

`evidenceLevel` 只允许 `insufficient | directional | supported` 三值，规则见 `src/domain/market-position/evidenceSufficiency.ts`（`DIRECTIONAL_THRESHOLDS`/`SUPPORTED_THRESHOLDS`）。

保守免责声明（必须原文展示，不得改写）：

> 这是 OfferFlow 的保守决策门槛，用于防止根据少量投递记录过早改变薪资、城市或职业方向，不代表通用招聘统计标准。

禁止词汇/结论类型（任何证据等级下都禁止，见 `ALWAYS_BLOCKED_CLAIMS`）：科学证明、市场结论、样本充分性断言、成功率预测、Offer 概率、放弃方向指令、搬迁指令、薪资变更指令、城市不适合断言、城市排名断言、方向失败断言、笼统竞争力结论。

## 6. DecisionGate

7 个决策门：role_positioning / city_priority / salary_positioning / resume_effectiveness / channel_effectiveness / abandon_direction / relocation_decision。

3 种状态：blocked / observe_only / decision_ready。标准门随 evidenceLevel 三级线性映射；`abandon_direction` 与 `relocation_decision` 属于高风险门，无论证据多充分，最高只能到 `observe_only`，永远不会到达 `decision_ready`——放弃职业方向与触发搬迁必须始终由用户本人决定。

## 7. 版本与审核流程

沿用 G1/G2 的提案 → 审核（接受/修改后接受/拒绝/稍后处理）→ 正式版本状态机；正式版本原地不可变。生成必须基于不可变输入快照（`MarketPositionInputSnapshot`：G1 版本 id、G2 版本 id、G3 截止时间、漏斗查询指纹、已接受证据 id 列表、输入哈希）。AI（如启用）只能润色 headline/positioning 文案，不得修改 EvidenceSufficiency 计数、DecisionGate 状态、证据 id、城市范围或 blockedClaims；若当前无安全可用的 AI 能力，本阶段跳过 AI，仅提供手工生成路径。

## 8. Schema v5 与生产边界

Schema v5 仅允许出现在临时/内存/G4 sandbox 数据库中；真实数据库（schema v4）不得被本阶段升级；`npm run dev` 默认行为不变；真实生产环境不得启用 G4；`server/index.ts` 底部真实生产入口不得添加 MarketPosition capability。

## 9. AI 生成市场位置提案（G4 收尾）

在手工提案基础上新增 AI 辅助生成路径（`POST /market-position/proposals/generate`），仅在用户主动点击时调用；复用 G1/G2 既有共享 LLM Provider 模式，不新增第二套 AI Provider、不新增 API Key 页面、不引入 BYOK。

- 服务端先以确定性规则计算 EvidenceSufficiency/DecisionGate 并冻结输入快照（`inputHash`），AI 只允许润色 headline/positioning/strengths/weaknesses/signals/uncertainties/nextEvidenceActions 等中文叙述字段；AI 输出经服务端结构化校验（失败最多修复一次，二次失败返回稳定错误码，不假成功、不无限重试），再与确定性草稿合并（`mergeAiNarrativeIntoDraft`），从不直接保存模型原始对象。
- AI 不可生成/篡改任何计数、evidenceLevel、DecisionGate 状态、allowedClaims/blockedClaims、城市范围、Evidence ID、版本号或提案状态。
- 相同 `inputHash` 若已存在未处理提案，直接返回既有提案（`409 MARKET_POSITION_PROPOSAL_ALREADY_EXISTS`），不重复调用模型、不产生重复提案。
- 无数据城市固定展示："当前没有该城市的正式市场反馈，不能判断该城市是否适合你。"
- 提案元数据在既有 v5 JSON payload 内记录 `generationMode`/`provider`/`model`/`generatedAt`/`inputHash`/`promptVersion`/`deterministicRuleVersion`，未新增 schema v6。
- 前端新增主按钮"AI 生成市场位置提案"，与既有次按钮"手工建立市场位置提案"并列；生成成功后自动切换到"提案审核"并高亮标注"AI 生成"；AI 失败后手工提案路径仍可用。
- 已在 G4 隔离沙箱（`npm run g4:sandbox:prepare` + `npm run dev:g4-sandbox`）完成浏览器验证：真实调用一次 DeepSeek 模型（有一次网络层自动重试后成功），生成提案的 EvidenceSufficiency/DecisionGate 与确定性计算一致，四城市叙述（含上海无数据固定文案）正确展示，幂等重复请求返回 409 无重复调用，拒绝/稍后处理流程正常，真实数据库哈希前后一致。

## 10. 当前阶段结论

G4 工程实现（含手工提案与 AI 生成提案两条路径）已完成；本文件冻结范围与架构复用决策，不代表任何验收结论。G4 完成工程实现后仍需用户在 sandbox 中人工验收，验收前不得声称 G4 已完成或已验收，不得据此推进 v0.7 发布、合并 main 或创建 Tag/Release。
