# OfferFlow v0.7 阶段交接（2026-07-16，G4 → G5）

## 1. G1–G3 签收事实（回顾）

- G1 全局岗位匹配画像 MVP：用户已于 2026-07-15 验收。
- G2 CandidateEvidence 与 CapabilityBaseline：用户已于 2026-07-15 验收。
- G3 历史补录与基础漏斗：用户已于 2026-07-15 正式验收通过（真实数据库已受控升级到 schema v4）。
- 详见 [`offerflow-v0.7-stage-handoff-2026-07-15-g3.md`](offerflow-v0.7-stage-handoff-2026-07-15-g3.md)。

## 2. 当前实施顺序

1. G1 全局岗位匹配画像（已验收）
2. G2 CandidateEvidence 与 CapabilityBaseline（已验收）
3. G3 历史补录与基础漏斗（已验收）
4. **G4 MarketPositionProfile 与 EvidenceSufficiency（本轮，已验收）**
5. G5 StrategyWindow 与正式策略 Proposal Review（尚未开始）
6. G6 最终验收与发布

v0.7 仍禁止发布，App 版本继续保持 `0.6.2`。

## 3. G4 分支与起点

- 分支：`feat/v0.7.0-g4-market-position`
- 范围冻结文档：[`offerflow-v0.7-g4-market-position.md`](../product/offerflow-v0.7-g4-market-position.md)

## 4. G4 产品边界（摘要，完整规则见 PRD §5.2/§6.4/§7.6/§10/§6.2/§9）

- 统一 G1（岗位匹配画像）、G2（能力基线）、G3（历史与基础漏斗）三份既有事实，产出全局 + 苏州/无锡/上海/杭州四城独立市场位置画像。
- EvidenceSufficiency 限定 `insufficient | directional | supported` 三档，由确定性规则计算，AI 不可篡改。
- DecisionGate 覆盖 role_positioning / city_priority / salary_positioning / resume_effectiveness / channel_effectiveness / abandon_direction / relocation_decision 共 7 类；`abandon_direction` 与 `relocation_decision` 无论证据等级如何均不可达 `decision_ready`，放弃方向与搬迁决策必须始终由用户本人决定。
- 手工提案与 AI 生成提案均需经过提案审核（接受/修改后接受/拒绝/稍后处理）并由用户人工确认，才能生成正式版本；正式版本原地不可变。
- AI 生成提案路径复用 G1/G2 既有共享 LLM Provider，不新增第二套 Provider、不新增 API Key 页面、不引入 BYOK；服务端先以确定性规则计算 EvidenceSufficiency/DecisionGate 并冻结输入哈希，AI 只允许润色中文叙述字段；相同输入哈希已有未处理提案时直接复用（不重复调用模型）。
- Schema v5 仅允许出现在隔离沙箱（`tmp/g4-sandbox`），真实数据库本轮保持 schema v4，真实生产入口不开启 G4（`marketPosition.enabled=false`）。

## 5. G4 正式验收（2026-07-16）

- **验收人**：用户
- **验收日期**：2026-07-16
- **验收环境**：G4 隔离沙箱（schema v5，`tmp/g4-sandbox`，独立于真实数据库）
- **验收结论**：**G4（MarketPositionProfile 与 EvidenceSufficiency，含 AI 生成提案路径）已正式验收通过**。
- 验收依据：
  1. 全局 + 四城独立市场位置画像可正常查看，城市证据隔离生效（不借用其他城市回复作为本城市证据）。
  2. EvidenceSufficiency 与 DecisionGate 均由确定性规则锁定计算，AI 仅生成受约束的中文叙述，不能修改计数、证据等级、门禁状态、证据 id、城市范围或 blockedClaims。
  3. AI 市场位置提案真实生成成功：用户主动点击"AI 生成市场位置提案"，真实调用一次 DeepSeek 模型，生成结果的 EvidenceSufficiency/DecisionGate 与确定性计算一致。
  4. AI 提案必须经过人工接受（接受/修改后接受）才生成正式版本；用户已完成 AI proposal → 接受并激活 → 正式 V1 可见的完整验收链路。
  5. 相同输入复用已有待审核提案（`reused: true`），验证未重复调用模型、未产生重复提案。
  6. G4 sandbox 前后端生命周期联动与连接失败提示已由提交 `51bb7f1`（`fix: G4 沙箱后端异常退出时联动关闭前端，并提示后端未启动`）补齐：API/Vite 任一意外关闭时联动 teardown，避免"前端能开、后端已死"的假运行状态；网络层连接失败在 G4 沙箱环境下明确提示"G4 隔离环境后端未启动或已退出，请重新启动 dev:g4-sandbox。"。
  7. 真实数据库哈希验收前后一致，未被本轮验收过程触碰或升级。
- 未发现阻塞 G5 的产品问题。
- 截图归档尚未完成，明确列为 G6 统一归档项，不在 G4 单独补齐。
- 详见 [`offerflow-v0.7-g4-market-position.md`](../product/offerflow-v0.7-g4-market-position.md)。

## 6. 真实环境现状（未受本轮影响）

- 真实数据库 `data/offerflow.sqlite3` 仍为 **schema v4**，本轮未升级、未触碰。
- 真实生产环境仍未开启 G4：`server/index.ts` 底部真实生产入口未添加 `marketPosition` capability。
- G4 生产切换（真实库受控升级到 schema v5 并在生产开放 MarketPosition 能力）**不在本轮范围内**，属于后续独立的"受控数据库升级与发布"任务，需用户另行拍板时间与方式。

## 7. Snapshot 契约现状（未受本轮影响）

- Snapshot 契约（`server/sync/exportSnapshot.ts`、`SNAPSHOT_SCHEMA_VERSION`）仍为 Job Memory v2 设计，只支持 database schema 2；真实库当前 schema=4，导出会被直接拒绝。
- Snapshot v4/v5 升级是独立的"Snapshot 契约升级与恢复设计"基础设施任务，不是 G4 遗留缺陷，不构成 G4 验收阻塞；在 v0.7 最终发布前必须由用户另行裁决其范围与实现方式。

## 8. 未改变的结论

- v0.7 仍禁止发布、禁止合并 main、禁止升级版本、禁止创建 PR/Tag/Release。
- G4 产品签收允许 G5 开始；**G5 尚未开始**，不得在本轮（G4 文档签收）被宣称完成或提前实现。
- 本轮只更新文档，未修改任何业务代码、数据库、AI Provider、Snapshot 或测试。

## 9. 下一阶段

- 下一阶段为 **G5：StrategyWindow 与正式策略 Proposal Review**。
- **G5 尚未开始**，本轮（G4 文档签收）不包含任何 G5 实现工作。
- G4 签收**不代表** v0.7 可以发布、合并 main、创建 Tag 或 Release；v0.7 仍禁止发布，App 版本继续保持 `0.6.2`，仍需 G5、G6 完成、真实环境受控切换 G4 及 Snapshot 契约升级范围裁决后才可重新评估发布条件。
