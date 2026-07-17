# OfferFlow v0.7 G2 CandidateEvidence 与 CapabilityBaseline

- 日期：2026-07-15
- 分支：`feat/v0.7.0-g2-capability-baseline`
- App 版本：`0.6.2`
- 状态：G2 已由用户验收；v0.7 仍禁止发布

## 0. G2 验收记录

- 验收人：用户
- 验收日期：2026-07-15
- 验收结果：候选能力证据审核可用；正式证据库可用；AI / 手工能力基线提案可用；无正式证据时能够阻止生成基线；支持证据、反证与待验证项能够同时保留；接受、修改后接受、拒绝、稍后处理可用；能力基线版本历史和版本激活可用。
- 未发现阻塞 G3 的产品问题。
- 截图归档尚未完成，列为 G6 统一归档项。
- 未改变 v0.7 发布结论：v0.7 仍禁止发布、禁止合并 main、禁止升级版本或创建 PR/Tag/Release。
- 下一阶段：G3（历史补录与基础漏斗）。

范围界定：G2 覆盖第 2.4 项“长期能力基线”的 CandidateEvidence 与 CapabilityBaseline 正式产品行为，属于用户验收范围内的完整子集，但不解除其余产品结果（2.1、2.3、2.5、2.6、2.7）的发布阻塞。

## 1. 当前实施顺序

1. G1 全局岗位匹配画像 MVP（已验收）
2. G2 CandidateEvidence 与 CapabilityBaseline（已验收）
3. G3 历史补录与基础漏斗（进行中）
4. G4 正式 MarketPositionProfile 与 EvidenceSufficiency
5. G5 StrategyWindow 与正式 Proposal Review
6. G6 最终产品验收与发布

## 2. G2 产品边界

G2 在 `/capability-baseline` 提供：

- 候选证据人工审核（手工录入、AI 生成、接受、修改后接受、拒绝、稍后处理）；
- 支撑证据与反证同时保留，不互相覆盖；
- 长期能力基线提案（手工与 AI）、版本历史与版本激活；
- 无已接受正式证据时禁止生成正式基线；
- 能力事实与外部门槛（学历、年龄、城市供给、薪资、招聘偏好）严格分离；
- 短期未回复不自动下调能力结论。

## 3. 持久化与 Human-in-the-loop

- schema v3（`server/migrations/capabilityBaselineSchemaV3.ts`），纯新增表：`capability_baseline_meta`、`candidate_evidence`、`capability_baseline_proposals`、`capability_baseline_versions`、`capability_command_receipts`。
- 单次命令使用 `expectedStateVersion` 做乐观并发；`idempotencyKey` + `requestHash` 保证幂等重放。
- AI 只产出候选证据 / 提案；用户决议后才写入正式版本。
- 正式版本引用的证据必须存在且已接受；手工提案严格拒绝非法引用。

## 4. 未解除的 Gate

以下完成前，G2 的截图证据仍未归档：

- 七张验收截图（候选证据审核、正式证据库、基线提案、支撑/反证并存、版本历史、版本激活、无证据阻断提示）留待 G6 统一归档。

本分支已合入主线开发流；不得因 G2 验收而合并 main、创建 PR、升级版本、Tag 或 Release。
