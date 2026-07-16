# OfferFlow v0.7 阶段交接（2026-07-16，G5 签收 → G6）

## 1. G1–G5 签收事实

- G1 全局岗位匹配画像 MVP：用户已于 **2026-07-15** 验收。
- G2 CandidateEvidence 与 CapabilityBaseline：用户已于 **2026-07-15** 验收。
- G3 历史补录与基础漏斗：用户已于 **2026-07-15** 正式验收（真实数据库已受控升级到 schema v4）。
- G4 MarketPositionProfile 与 EvidenceSufficiency（含 AI 生成提案）：用户已于 **2026-07-16** 在隔离沙箱（schema v5）验收。
- **G5 StrategyWindow 与正式策略 Proposal Review：用户已于 2026-07-16 在隔离沙箱（schema v6）正式验收并封板。**
- G4 交接详见 [`offerflow-v0.7-stage-handoff-2026-07-16-g4.md`](offerflow-v0.7-stage-handoff-2026-07-16-g4.md)。

## 2. 当前实施顺序

1. G1（已验收）
2. G2（已验收）
3. G3（已验收）
4. G4（已验收）
5. **G5 StrategyWindow 与正式策略 Proposal Review（本轮，已验收并封板）**
6. G6 `v0.7 最终验收、生产切换与发布裁决`（下一阶段，**尚未开始**）

v0.7 仍禁止发布，App 版本继续保持 `0.6.2`。

## 3. G5 分支与起点

- 分支：`feat/v0.7.0-g5-strategy-window`（从 `feat/v0.7.0-g4-market-position` 的 HEAD `772cead` 切出）。
- 范围冻结文档：[`offerflow-v0.7-g5-strategy-window.md`](../product/offerflow-v0.7-g5-strategy-window.md)。
- 关键提交：`4edb459`(冻结范围)→`838a9d1`(领域)→`5bc8a6a`(服务/版本)→`e3ffc90`(AI/页面)→`3741144`(沙箱)→`aa573f1`(测试)→`0718189`(工程完成记录)→`2038e54`(收窄 AI 叙事输出契约)→`6ba6c9d`(补齐 AI 输出修复与守卫)。

## 4. G5 产品与工程边界（摘要，完整规则见范围冻结文档）

- G5 把 G1（岗位匹配）、G2（能力基线）、G3（漏斗）、G4（市场位置与证据充分性）转化为受门禁约束、可审核、可版本化、可撤销的阶段性求职策略。**不自动决策、不自动投递、不预测 Offer 概率。**
- **StrategyWindow 完全由确定性规则生成，三档已实现并验收**：读取 G4 active 市场位置版本的全局 `evidenceLevel` 与 7 类 `DecisionGate` 状态，映射为 `insufficient → evidence_collection（证据收集窗口）`、`directional → controlled_experiment（受控实验窗口）`、`supported → limited_optimization（有限优化窗口）`。**当前真实样本对应证据收集窗口。** 窗口的允许/仅观察/禁止动作、复盘触发、停止条件、allowed/blockedClaims 全部锁定在 `src/domain/strategy-window/strategyWindow.ts`，AI 不得修改任何字段。
- **DecisionGate → 策略动作的确定性映射已验收**：降薪试探、搬迁研究、减少投入随证据等级逐级解锁；`abandon_direction` 与 `relocation_decision` 永不 `decision_ready`；不存在“直接放弃方向/直接搬迁/辞职/自动投递”这类可执行动作类型。
- **AI 只在边界内生成受约束叙事**：复用 G4 既有共享 LLM Provider，不新增 Provider/BYOK，仅用户点击时调用。AI 只返回 headline/objective/summary/uncertainties 与既有行动（按 `actionId`）的 title/rationale/成功失败信号；**AI 不能修改 StrategyWindow、EvidenceSufficiency、DecisionGate、sourceEvidenceIds、正式计数、输入版本与 inputHash**。服务端确定性生成窗口与基础草稿，AI overlay 按 actionId 精确合并后对整份草稿重新执行门禁校验（`validateStrategyDraft`）；结构化输出/禁止措辞/actionId 引用失败最多修复一次，二次失败返回稳定错误码、不保存半成品。AI overlay 契约已由 `2038e54` 与 `6ba6c9d` 收口（strict object，拒绝一切未知/确定性字段，数组必须为 JSON 数组）。
- **审核与版本**：提案 → 接受/修改后接受/拒绝/稍后处理 → 正式版本。**AI 提案必须经用户人工接受后才能生成正式版本**；接受前不改正式版本、不修改 Job/Application/FeedbackEvent、不执行任何行动；接受后创建且仅创建一个 immutable 版本并事务化切换 active、保留 generationMode 与 decisionDiff。**相同 `inputHash` 复用已有开放提案，不重复调用模型**；G1/G2/G4 版本变化、G3 漏斗指纹变化或窗口到期使旧提案 `stale`，stale/到期提案不可接受；“修改后接受”仍重新校验门禁，用户不能绕过。
- **Schema v6 仅限沙箱**：新增 `strategy_meta/strategy_proposals/strategy_versions/strategy_receipts` 四表（纯新增，不改 v2–v5）；真实数据库保持 schema v4，真实生产入口不开启 G4/G5（`server/index.ts` 底部未添加 marketPosition/strategyWindow capability）。`historyImport` 启动门禁固定为 `HISTORY_IMPORT_SCHEMA_VERSION=4`，不随 `LATEST_SCHEMA_VERSION` 上浮，保证真实 v4 库 `npm run dev` 行为不变。

## 5. G5 正式验收（2026-07-16）

- **验收人**：用户
- **验收日期**：2026-07-16
- **验收环境**：G5 隔离沙箱（schema v6，`tmp/g5-sandbox`，从已验收 G4 v5 沙箱副本升级而来，独立于真实数据库）
- **验收结论**：**G5（StrategyWindow 与正式策略 Proposal Review）正式验收通过并封板。**
- 验收依据（用户人工确认）：
  1. 当前 StrategyWindow 正确显示为“证据收集窗口”。
  2. 三类边界正确展示：现在可以做 / 只能观察或实验 / 当前不能做。
  3. AI 成功生成求职策略提案。
  4. AI 提案以增加可靠样本、补充结果记录、城市/岗位族探索、简历与渠道 A/B、项目及面试证据优化为主。
  5. AI 未输出直接降薪、搬迁、辞职、放弃方向、自动投递或 Offer 概率预测。
  6. AI 结构化输出经修复后成功创建 pending proposal。
  7. 用户点击“接受并激活”后生成正式策略版本 V1。
  8. 页面显示正式版本已激活。
  9. 当前策略窗口仍为证据收集窗口。
  10. 策略总览、城市投入、岗位族投入、样本目标、停止条件与复盘触发条件可见。
  11. 行动清单显示目标数量、成功信号、失败信号、停止条件与可逆性。
  12. 简历版本 A/B 与投递渠道 A/B 实验计划可见。
  13. 版本历史显示正式 V1。
  14. 待审核提案已清空。
  15. G5 只写入 sandbox，真实数据库未升级、未修改。
  16. G5 不会自动执行投递、联系、降薪、迁移或放弃方向。
- 未发现阻塞 G6 的产品问题。
- 截图归档尚未完成，明确列为 G6 统一归档项，不在 G5 单独补齐。

## 6. 真实环境现状（未受本轮影响）

- 真实数据库 `data/offerflow.sqlite3` 仍为 **schema v4**，验收过程前后 sha256 一致（`cdc214c8…`），未升级、未触碰。
- 真实生产入口未开启 G4/G5（`server/index.ts` 底部真实入口未添加 marketPosition/strategyWindow capability）。
- G4/G5 生产切换（真实库受控升级到 schema v6 并在生产开放）**属于 G6 的受控数据库升级与发布裁决范围**，需用户另行拍板时间与方式。
- Snapshot 契约仍为 Job Memory v2，只支持 schema 2；Snapshot 契约升级仍是独立的基础设施任务，须由用户另行裁决范围。

## 7. 未改变的结论

- G5 签收**不代表** v0.7 可以发布。v0.7 仍禁止：合并 main、Tag/Release、发布 v0.7、开启正式 G4/G5、升级真实数据库、发布 Snapshot。
- App 版本继续保持 `0.6.2`。
- 本轮（G5 文档签收）只更新文档，未修改任何业务代码、数据库、AI Provider、Snapshot、测试或 sandbox 实现。
- 未 push、未创建 PR/Tag/Release、未合并 main、**未进入 G6**。

## 8. 下一阶段：G6

- **G6 名称**：`v0.7 最终验收、生产切换与发布裁决`。
- **G6 尚未开始**；本轮不创建 G6 分支、不实施任何 G6 代码。
- G6 后续至少需要用户裁决：
  1. 真实数据库 schema v4 → v6 的受控升级路径（备份、指纹、完整性、行数与升级后校验）；
  2. G4/G5 生产入口开放；
  3. 全链路回归与真实环境烟测；
  4. Snapshot 契约是否升级；
  5. v0.7 最终验收矩阵；
  6. 是否允许合并 main；
  7. 是否允许 Tag / Release；
  8. 是否允许 push。
