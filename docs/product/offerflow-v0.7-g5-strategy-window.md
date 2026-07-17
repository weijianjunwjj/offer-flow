# OfferFlow v0.7 G5：StrategyWindow 与正式策略 Proposal Review 范围冻结

- 日期：2026-07-16
- 上位契约：`docs/product/offerflow-v0.7-release-contract.md` §2.7
- 追踪矩阵：`docs/product/offerflow-v0.7-traceability.md`（R4 条目）
- 对应阶段：R4（Proposal Review 与 StrategyWindow）
- 当前结论：G5 已于 2026-07-16 在隔离沙箱（schema v6）经用户正式验收并封板；v0.7 继续禁止发布

## 1. G5 目的

在 G1（岗位匹配画像）、G2（能力基线）、G3（求职漏斗）、G4（市场位置画像与证据充分性）之上，把已验证的能力、匹配度、市场反馈和证据充分性，转化为一套受证据门禁约束、可审核、可版本化、可撤销的阶段性求职策略。

G5 回答："基于当前已验证的能力、岗位匹配度、市场反馈和证据充分性，未来一个阶段应采取什么可逆行动，如何分配求职样本，何时复盘，哪些重大决策暂时不能做。"

G5 **不是**自动决策系统，也**不是**自动投递系统。它不回答"必须去哪座城市/必须降薪或涨薪/必须放弃某方向/必须搬家或辞职/某城市或岗位一定成功/Offer 概率"，也不自动代替用户执行投递、联系、跟进或修改数据。

原则：

> 规则引擎决定边界，AI 在边界内生成策略，用户决定是否接受，系统不自动执行。

## 2. 正式对象

- **StrategyWindow**：确定性的策略允许范围（窗口类型、边界、复盘触发、停止条件）。
- **StrategyProposal**：窗口内的具体策略提案（可 AI 生成或手工建立，待人工审核）。
- **StrategyVersion**：用户确认后的正式、原地不可变策略版本。
- **StrategyReview**：接受 / 修改后接受 / 拒绝 / 稍后处理。

## 3. 正式输入边界

只读取正式 active 数据：

- **G1**：active JobMatchProfile、全局与苏州/无锡/上海/杭州画像、匹配点/风险/反证/不确定性。
- **G2**：active CapabilityBaseline、accepted CandidateEvidence、支持证据/反证/能力缺口/不确定项。
- **G3**：正式 Job/Application/FeedbackEvent、基础漏斗、城市/岗位族/渠道/简历版本分组、数据可信度与终态分布（排除未投递、voided、sandbox）。
- **G4**：active MarketPositionProfile、EvidenceSufficiency、DecisionGate、allowedClaims、blockedClaims、市场信号/反信号/不确定性、下一步证据动作。

禁止读取：reject/defer proposal、sandbox 之外临时 AI 文本、聊天即时情绪、外部招聘网站实时数据、未经接受的证据、G6 发布状态。

## 4. StrategyWindow（确定性规则生成，AI 不得修改）

`windowType` 三档，由 G4 `evidenceLevel` 决定：

- `evidence_collection`（证据收集窗口）← `insufficient`：只允许补样本、补结果、扩大公司样本、补精确证据、小规模测试城市/岗位族/渠道/简历版本、优化项目证据与面试表达、清理长期未知流程；禁止降薪结论、放弃城市/方向、迁移、宣称市场不认可、大幅调整定位。默认复盘触发至少：新增 5 条可靠投递流程 / 新增 2 条已知市场结果 / G1/G2/G4 active version 变化 / 14 天到期。
- `controlled_experiment`（受控实验窗口）← `directional`：允许单变量简历 A/B、单变量渠道实验、城市或岗位族样本配比实验、薪资区间小范围试探、面试表达与项目叙事实验、有限调整投递组合。所有实验必须可逆、有明确样本目标、有成功信号、有失败信号、有停止条件、不同时改变过多变量；仍禁止直接放弃城市/方向、实际迁移、大幅降薪、不可逆职业决定。
- `limited_optimization`（有限优化窗口）← `supported`：允许在 DecisionGate 范围内优化城市/岗位族投入比例、优化渠道与简历版本、测试薪资区间、减少长期低效样本、增加已验证方向投入；仍不得自动替用户决策、自动迁移/辞职、自动放弃方向、自动投递或联系招聘方。

## 5. DecisionGate → 策略动作映射（集中确定性实现）

- `role_positioning`：blocked→只能补样本与能力证据；observe_only→允许岗位族小规模实验；decision_ready→允许有限调整岗位投入比例。
- `city_priority`：blocked→只能做城市样本实验；observe_only→允许比较趋势不得定论；decision_ready→允许有限调整城市投入比例。
- `salary_positioning`：blocked→禁止降薪或薪资结论；observe_only→只允许薪资区间试探；decision_ready→允许建议有限薪资带但必须可撤销。
- `resume_effectiveness`：blocked→只能补简历版本数据；observe_only→允许 A/B；decision_ready→允许选择表现更好版本。
- `channel_effectiveness`：blocked→只能补渠道样本；observe_only→允许渠道实验；decision_ready→允许有限调整渠道比例。
- `abandon_direction`：无论状态如何，G5 都不得直接建议"彻底放弃"，最多允许暂停新增样本、减少短期投入、设定重新评估条件。
- `relocation_decision`：无论状态如何，G5 都不得建议直接搬迁，最多允许研究通勤/租房/岗位密度/成本、安排短期面试或试住、建立迁移前置条件；实际迁移必须由用户单独决定。

## 6. 策略动作模型与约束

`actionType` 枚举：collect_market_evidence / increase_reliable_applications / complete_outcome_records / city_sample_experiment / role_family_experiment / resume_ab_test / channel_ab_test / salary_probe / portfolio_evidence_improvement / interview_story_improvement / follow_up_hygiene / stale_process_review / relocation_feasibility_research / reduce_exposure / maintain_current_strategy。

硬约束：insufficient/directional 阶段行动必须 `reversible=true`；`targetCount` 不得为负；`allocationShare` 在 0–100；同一分配维度比例总和必须为 100；不得将探索性样本描述为城市优先级结论；不得将简历/渠道实验同时改动多个核心变量；`sourceEvidenceIds` 必须来自正式输入快照。

## 7. AI 生成策略（复用 G4 Provider）

复用 G4 已接通的 AI Provider、结构化输出、重试、错误映射与 Fake Provider；不新增第二套 Provider、不新增 BYOK、不自动调用、不在服务启动时调用、测试不调用真实模型；仅用户明确点击时调用。

服务端流程：读取并冻结 G1–G4 正式输入 → 确定性生成 StrategyWindow → 确定性生成基础 StrategyProposal → 将允许范围提供给 AI → AI 只返回可编辑叙事与窗口内行动 → 服务端重新校验所有行动 → 合并并创建 pending proposal。不得直接保存 AI 返回的完整对象。

AI 可生成：headline / objective / summary / 行动标题与说明 / 合理执行顺序 / 可读成功失败信号 / 复盘说明 / 风险与不确定性解释。AI 不得修改：StrategyWindow 类型、EvidenceSufficiency、DecisionGate、allowed/observe/blocked actionTypes、allowedClaims/blockedClaims、城市 scope、岗位族、正式计数、Evidence ID、inputHash、sourceVersionIds、dataCutoffAt、active version、proposal status。

AI 严格守卫（出现即拒绝，不创建半成品）：建议降薪但 salary gate 未允许 / 建议放弃城市或方向 / 建议直接搬迁 / 建议辞职 / 建议自动投递 / 使用 blocked actionType / 引用不存在 Evidence ID / 跨城市市场反馈串用 / 分配比例不等于 100% / 同时改变多个 A/B 核心变量 / 不可逆行动出现在 insufficient/directional / 超出窗口 reviewAt 或 expiresAt / 生成 Offer 概率或成功率预测 / 创造不存在的回复、面试或市场事实。结构化输出失败最多修复一次；二次失败返回稳定中文错误、不保存 proposal、不自动切换 Provider，手工入口仍可用。

## 8. 幂等与输入陈旧

生成输入记录：G1/G2/G4 active version id、G3 cutoff/fingerprint、accepted evidence ids、StrategyWindow rule version、inputHash。相同 inputHash 已存在开放 proposal 时不重复调用模型、不重复扣费、返回既有 proposal 并 `reused=true`、页面自动打开并高亮。G1/G2/G4 active version 改变 / G3 漏斗 fingerprint 改变 / 窗口到期 / ruleVersion 改变 使 proposal `stale`；stale proposal 不得直接接受。

## 9. 审核与正式版本

支持 accept / edit and accept / reject / defer / version history。接受前不改变正式 StrategyVersion、不修改 Job/Application/FeedbackEvent、不执行任何策略动作。接受后创建且只创建一个 immutable StrategyVersion、事务化切换 active version、保留 generationMode、保留 decisionDiff、不自动执行 actions。"修改后接受"允许改标题/说明、目标数量、时间范围、分配比例、行动排序、成功失败信号，但服务端必须重新校验 StrategyWindow、DecisionGate、比例总和、blocked actions、Evidence ID、可逆性、stale input；用户不能通过编辑绕过门禁。

## 10. Schema v6 与生产边界

允许新增 schema v6，但仅限内存库 / 临时库 / G5 sandbox。真实数据库当前 schema=4，不得升级；普通 dev 行为不变；G4/G5 正式入口保持关闭；启动门禁不得削弱。补充临时 schema v5→v6 migration selftest。

## 11. G5 隔离环境

G5 依赖 G4 已验收 active version，因此 G5 sandbox 从已验收的 G4 sandbox v5 副本（`tmp/g4-sandbox/offerflow-v5.sqlite3`）创建，而非从缺少 G4 数据的真实 schema v4 库创建。提供 `npm run g5:sandbox:prepare`（确认源库 schema=5、存在 active MarketPositionVersion、创建 `tmp/g5-sandbox/offerflow-v6.sqlite3`、升级 v5→v6、integrity/foreign_key check、行数保持、G5 新表为空、记录源 hash 与真实库前后 hash 不变）与 `npm run dev:g5-sandbox`（独立 API 端口 17475、Vite 端口 5185、前后端生命周期联动、明确指向 G5 sandbox API、不连真实库、页面顶部显示隔离横幅）。

## 12. 页面

新增导航"求职策略"，路由 `/strategy-window`，至少包含：当前策略窗口、三类边界（现在可以做 / 只能观察或实验 / 当前不能做）、策略总览、行动清单、实验计划、Proposal Review、Version History。中文枚举映射，不暴露 UUID/requestHash/rowVersion/Provider 密钥/内部英文错误堆栈。

## 13. 当前阶段结论

G5 工程实现（StrategyWindow 确定性规则 + DecisionGate 动作门禁 + 提案审核与版本服务 + AI 生成路径 + 页面）已完成，并已于 **2026-07-16** 在 G5 隔离沙箱（schema v6，`tmp/g5-sandbox`，独立于真实数据库）经**用户正式验收通过并封板**：当前 StrategyWindow 正确显示为“证据收集窗口”，三类边界（现在可以做 / 只能观察或实验 / 当前不能做）清晰；AI 成功生成受约束求职策略提案（以增加可靠样本、补充结果记录、城市/岗位族探索、简历与渠道 A/B、项目及面试证据优化为主，未输出直接降薪、搬迁、辞职、放弃方向、自动投递或 Offer 概率预测），结构化输出经修复后成功创建 pending proposal；用户完成 AI 生成 → 提案审核 → 接受并激活 → 正式 V1 的完整链路，行动清单（含目标数量、成功/失败信号、停止条件、可逆性）、实验计划（简历 A/B、渠道 A/B）与版本历史均可见，待审核提案已清空；相同输入复用已有开放提案、不重复调用模型；G5 只写入 sandbox，真实数据库未升级、未修改，也不会自动执行投递、联系、降薪、迁移或放弃方向。AI overlay 结构化输出契约已由提交 `2038e54`、`6ba6c9d` 收口，AI 不能修改 StrategyWindow/EvidenceSufficiency/DecisionGate/sourceEvidenceIds/正式计数/输入版本与 inputHash。详见 [`offerflow-v0.7-stage-handoff-2026-07-16-g5.md`](../handoffs/offerflow-v0.7-stage-handoff-2026-07-16-g5.md)。

G5 产品结果正式完成。真实数据库仍为 schema v4；G4/G5 正式生产入口仍未开启；G4/G5 生产切换属于 G6 的受控数据库升级与发布裁决范围；Snapshot 契约升级仍是独立基础设施任务；v0.7 仍禁止发布、禁止合并 main、禁止创建 Tag/Release、禁止升级真实数据库、禁止发布 Snapshot，App 版本继续保持 `0.6.2`。**G5 签收不代表 v0.7 可以发布**；下一阶段为 G6 `v0.7 最终验收、生产切换与发布裁决`，**G6 尚未开始**。
