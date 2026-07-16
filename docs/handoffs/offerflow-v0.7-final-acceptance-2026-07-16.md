# OfferFlow v0.7 最终生产验收与封板（2026-07-16）

- 日期：2026-07-16
- 验收人：用户
- 用户最终验收反馈原文：“测试过了没啥问题。”
- 结论：**G6 正式验收通过并封板；OfferFlow v0.7 产品与生产验收完成。**
- 重要边界：**“验收完成”不等于“已经发布”**。App 版本仍为 `0.6.2`；push、合并 main、创建 Tag、创建 Release 均**尚未授权**，各自须由用户单独明确授权。

## 1. 各阶段最终验收状态

| 阶段 | 内容 | 验收日期 | 状态 |
|---|---|---|---|
| G1 | 全局岗位匹配画像 MVP | 2026-07-15 | 已验收 |
| G2 | CandidateEvidence 与 CapabilityBaseline | 2026-07-15 | 已验收 |
| G3 | 历史补录与基础漏斗 | 2026-07-15 | 已验收 |
| G4 | MarketPositionProfile 与 EvidenceSufficiency | 2026-07-16 | 已验收 |
| G5 | StrategyWindow 与正式策略 Proposal Review | 2026-07-16 | 已验收 |
| G6-A | 发布准备与生产迁移演练 | 2026-07-16 | 已完成 |
| G6-B | 真实生产切换与 G4/G5 正式入口开放 | 2026-07-16 | 已执行 |
| G6 | 最终生产验收 | 2026-07-16 | **验收通过并封板** |

## 2. 用户最终生产验收事实（2026-07-16）

1. 真实数据库已从 schema v4 受控升级到 **schema v6**。
2. 升级前 schema v4 备份已验证，可作为回滚恢复点。
3. 升级后 schema v6 备份已验证，作为当前生产基线。
4. G1～G3 原有数据、行数与业务语义未受损（jobs=15、applications=9、feedback_events=11）。
5. G4 市场位置画像正式 V1 已晋升并在真实环境开放。
6. G5 求职策略正式 V1 已晋升并在真实环境开放。
7. G5 StrategyWindow 正确显示为“证据收集窗口”。
8. 三类边界、行动清单、实验计划与版本历史在真实环境正常。
9. 基础漏斗仍显示 9 条正式流程。
10. 岗位台账仍有 15 条。
11. 页面不存在 G4/G5/G6 sandbox 或 rehearsal 横幅。
12. 真实生产烟测与用户最终人工验收均通过。
13. G4/G5 晋升包重复导入幂等（alreadyApplied）。
14. Snapshot 正式采用方案 B：schema v6 使用 SQLite 一致性备份、SHA-256、完整性验证与恢复演练；旧 Snapshot 契约继续仅支持 schema 2；不伪造 Snapshot v6。
15. G6-A 与 G6-B 均已完成。
16. G6 正式验收通过并封板。
17. OfferFlow v0.7 产品与生产验收完成。

> 说明：G6-B 切换后，用户已在真实环境正常使用 G4/G5 并新建/激活了新的市场位置正式版本，属于开放后的正常生产使用；EvidenceSufficiency 在当前真实样本下为 `insufficient`（投递流程/可信证据/已知结果尚未达到保守阈值），决策门保持锁定，符合“证据不足时不虚构市场结论”的设计。

## 3. 真实环境现状

- 真实数据库 `data/offerflow.sqlite3`：**schema v6**，integrity=ok、foreign_key_check=0。
- 正式生产入口：G1、G2、G3、G4、G5 **均已开放**（`server/index.ts` 真实入口启用 marketPosition/strategyWindow；启动门禁为固定能力版本 G3=v4/G4=v5/G5=v6，不依赖浮动 LATEST；schema<6 拒绝启动，schema>6 拒绝启动，schema=6 正常且不自动迁移）。
- 前端普通环境默认显示“市场位置画像”“求职策略”导航，且不显示任何 sandbox/rehearsal 横幅。

## 4. Snapshot 方案 B（正式采用）

- schema>2 时旧 Snapshot 发布明确拒绝并给出方案 B 说明；未修改 `SNAPSHOT_SCHEMA_VERSION` 或导出结构。
- 正式恢复机制：G6-B 的 pre-cutover schema v4 备份与 post-cutover schema v6 一致性备份（`backups/v0.7-production-cutover/`，均已验证、gitignored）。

## 5. v0.7 当前状态与未授权动作

- **v0.7 产品与生产验收已完成**；G6 已封板。
- App 版本仍为 `0.6.2`（未升级）。
- **尚未授权**：push、合并 main、创建 Tag、创建 Release —— 每项须由用户单独明确授权。
- “验收完成”不等于“已经发布”。
