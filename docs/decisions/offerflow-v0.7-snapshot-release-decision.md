# OfferFlow v0.7 Snapshot 契约发布裁决材料

- 日期：2026-07-16
- 状态：**用户已于 2026-07-16 裁决采用方案 B 并在 G6-B 落实**（旧 Snapshot 对 schema>2 明确拒绝发布，未修改 `SNAPSHOT_SCHEMA_VERSION`/导出结构；正式恢复机制为 G6-B 的 pre-cutover schema v4 备份与 post-cutover schema v6 一致性备份）
- 现状：Snapshot 契约（`server/sync/exportSnapshot.ts`、`SNAPSHOT_SCHEMA_VERSION`）仍为 Job Memory v2 设计，只支持 database schema 2；真实库当前 schema v4（G6-B 后为 v6），导出会被直接拒绝。
- 硬约束：**禁止简单提高 `SNAPSHOT_SCHEMA_VERSION` 冒充兼容。** 本轮未修改任何 Snapshot 代码、版本常量或导出结构。

## 方案 A：v0.7 发布前将 Snapshot 契约升级到 v6

- **工作量**：高。需覆盖 G1~G5 全部新表（capability_baseline_*、candidate_evidence、historical_*、market_position_*、strategy_*）的导出/导入、canonical 序列化与版本协商。
- **表覆盖**：需为 schema v3/v4/v5/v6 新增表定义 Snapshot 段并保证向后兼容。
- **roundtrip/恢复要求**：需 `snapshot:roundtrip` 与一致性恢复演练覆盖到 v6，新增 selftest。
- **风险**：Snapshot 是跨设备同步与恢复的关键路径，改动面大、回归风险高；与 G6-B 生产切换叠加会放大风险。
- **对发布时间影响**：显著推迟 v0.7 发布。

## 方案 B（推荐）：v0.7 以数据库一致性备份作为恢复机制，Snapshot 暂标记“不支持 schema v6”

- **说明**：Snapshot 功能保持只支持 schema 2 并明确标记“不支持 v6”，v0.7 的恢复保障改由**数据库一致性备份 + SHA-256 + 恢复演练**承担（已在 G6-A 回滚演练中实证：升级前 v4 备份可精确恢复，hash 与真实基线完全一致）。
- **发布要求**：G6-B 切换前后各产出一致性备份并记录 hash；保留 `production-rollback.md` 恢复路径；在 UI/命令层对 schema>2 时禁用旧 Snapshot 发布（避免导出被误用/产生半成品）。
- **风险与限制**：跨设备 Snapshot 同步在 v0.7 期间对 v6 数据不可用（仅本地备份/恢复可用）；需向用户明确该限制。
- **成本**：低；不阻塞 v0.7 发布时间线。

## 方案 C：因 Snapshot 未升级而阻塞 v0.7 Release

- **成本**：v0.7（含已验收 G1~G5 产品价值）被无限期推迟。
- **收益**：跨设备 Snapshot 对 v6 数据可用。
- **评估**：收益与“本地备份/恢复已足够保障单机数据安全”高度重叠，成本过高。

## 证据支持的推荐

推荐**方案 B**：G6-A 回滚演练已证明数据库一致性备份可提供可靠、可验证的恢复路径（`restoredSha256 == 升级前备份 == 真实基线`，schema=4，integrity ok）。据此 v0.7 可在“Snapshot 暂不支持 v6、以一致性备份为恢复机制并显式禁用旧 Snapshot 发布”的前提下具备发布条件，同时把 Snapshot v6 升级留作独立后续任务。**最终裁决由用户在 G6-B 前作出。**
