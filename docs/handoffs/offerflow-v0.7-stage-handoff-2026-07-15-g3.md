# OfferFlow v0.7 阶段交接（2026-07-15，G2 → G3）

## 1. G2 签收事实

- 验收人：用户
- 验收日期：2026-07-15
- 验收内容：候选能力证据审核、正式证据库、AI/手工能力基线提案、无正式证据时阻止生成基线、支持证据/反证/待验证项同时保留、接受/修改后接受/拒绝/稍后处理、能力基线版本历史与版本激活均已通过人工测试。
- 未发现阻塞 G3 的产品问题。
- 截图归档尚未完成，明确列为 G6 统一归档项，不在 G2/G3 单独补齐。
- 详见 [`offerflow-v0.7-g2-candidate-evidence-capability-baseline.md`](../product/offerflow-v0.7-g2-candidate-evidence-capability-baseline.md)。

## 2. 当前实施顺序

1. G1 全局岗位匹配画像（已验收）
2. G2 CandidateEvidence 与 CapabilityBaseline（已验收）
3. **G3 历史补录与基础漏斗（本轮）**
4. G4 MarketPositionProfile 与 EvidenceSufficiency
5. G5 StrategyWindow 与正式策略 Proposal Review
6. G6 最终验收与发布

v0.7 仍禁止发布，App 版本继续保持 `0.6.2`。

## 3. G3 分支与起点

- 分支：`feat/v0.7.0-g3-history-funnel`
- 分支起点：`feat/v0.7.0-g2-capability-baseline` 分支 HEAD `3826656acaf3be873add03f8802ec7441f398098`（`fix: 禁止服务启动时自动升级真实数据库`）

## 4. G3 产品边界（摘要，完整规则见 PRD §6.5/§11/§19.3/§27）

- 历史补录两层结构：最小历史基线（默认弱证据/回忆来源）+ 详细事件补录（复用 Job Memory v2 正式事件枚举）。
- 草稿 → 预览 → 用户确认 → 事务性正式写入，未确认不污染 Job Memory。
- 未投递记录不得计入投递分母、拒绝或无回复统计。
- 同一岗位允许多条独立 Application；区分 accidental duplicate 与 legitimate separate process。
- 基础漏斗从正式 ApplicationProjection / FeedbackEvent 投影读取，不使用旧 `communicationStatus`，不保存可漂移的统计副本。
- 允许新增 schema v4（纯新增表），但真实数据库 `data/offerflow.sqlite3` 本轮禁止升级；只在临时/内存库验证。

## 5. 未改变的结论

- v0.7 仍禁止发布、禁止合并 main、禁止升级版本、禁止创建 PR/Tag/Release。
- G4、G5 尚未开始，不得在本轮被宣称完成。

## 6. G3 产品收口纠正（2026-07-15 补充）

工程主体（schema v4、history-import 领域/server、funnel 领域/server、前端页面与路由）已实现，且自动化测试全绿，但用户实际验收发现：

- 历史补录页面无法进入完整流程验收（真实入口默认关闭历史补录，此前未提供隔离验收环境）；
- 基础漏斗页面默认把城市+具体岗位标题+渠道拼成复合分组，每组仅 1 条流程，不是有效的总览/分组漏斗；缺少岗位族、可信度总览、终态分布与单维分组。

因此：

- **G3 未验收**。测试全绿、工程实现完成，不等同于产品验收通过；此前如有任何交付报告将 G3 描述为“全部完成”，均以本节为准予以纠正。
- 历史补录真实库入口继续保持关闭（不升级 `data/offerflow.sqlite3` 到 v4）；新增隔离 sandbox 环境供用户人工验收，不影响真实数据。
- 基础漏斗信息架构（总览优先、单维分组、岗位族、可信度、终态分布、明细钻取）在本轮产品收口中重做。
- v0.7 继续禁止发布；不得在本节以外的任何位置提前标记 G3“已验收”。
