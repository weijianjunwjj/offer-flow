# OfferFlow v0.7 G6 发布准备与迁移演练合同（G6-A / G6-B）

- 日期：2026-07-16
- 上位契约：`docs/product/offerflow-v0.7-release-contract.md`
- 追踪矩阵：`docs/product/offerflow-v0.7-traceability.md`
- 当前结论：**G6-A（发布准备与迁移演练）工程完成，等待用户裁决；G6-B（真实生产切换）尚未开始，必须由用户再次明确授权后才能执行。v0.7 尚不可发布。**

## 0. 阶段事实

- G1 已于 2026-07-15 用户验收；G2 已于 2026-07-15 用户验收；G3 已于 2026-07-15 用户验收；G4 已于 2026-07-16 用户验收；G5 已于 2026-07-16 用户验收。
- **G6 尚未验收。G6-A 完成不等于授权 G6-B。**
- 真实数据库 `data/offerflow.sqlite3` 仍为 schema v4；正式生产入口仍未开启 G4/G5；Snapshot 契约仍为 Job Memory v2（schema 2），未裁决升级；App 版本仍 `0.6.2`。
- v0.7 仍禁止发布、合并 main、Tag/Release、push。

## 1. G6-A：发布准备与迁移演练（本轮，只操作副本，不触碰真实库）

G6-A 目标是在**不修改真实数据库**的前提下证明可切换性，并产出发布裁决材料：

1. **发布准备**：最终验收矩阵（`offerflow-v0.7-final-acceptance-matrix.md`）、Snapshot 裁决材料（`docs/decisions/offerflow-v0.7-snapshot-release-decision.md`）。
2. **迁移演练**：`npm run g6:rehearsal:prepare` 将真实 v4 库一致性复制为候选副本，仅对副本执行 v4→v5→v6，验证迁移连续、`integrity_check=ok`、`foreign_key_check=0`、G1~G3 关键表行数与内容 hash 保持、G4/G5 新表迁移后为空。
3. **正式版本晋升演练**：从已验收的 G5 沙箱（schema v6）导出**最小化正式版本晋升包**（仅 active MarketPositionVersion + active StrategyWindow/StrategyVersion 及其 accepted/modified_and_accepted 来源提案；**不含** pending/rejected/deferred/stale 提案、命令回执、sandbox/Fake Provider/浏览器残留、无关版本、Job/Application/FeedbackEvent 副本），事务性导入候选库并校验；相同晋升包重复导入返回 `alreadyApplied`。
4. **回滚演练**：在一次性副本上实际验证——用升级前 v4 备份恢复，证明恢复文件 `schema=4`、SHA-256 与升级前一致、`integrity_check=ok`、`foreign_key_check=0`、G1~G3 行数一致（见 `docs/runbooks/offerflow-v0.7-production-rollback.md`）。
5. **候选环境只读烟测**：`npm run dev:g6-rehearsal` 只连接候选副本，正式启用 G1~G5，只显示一条 G6 演练横幅；只读验证，不改真实库。
6. **G6-B 操作手册**：可执行、可停止、可回滚的真实切换清单（`docs/runbooks/offerflow-v0.7-production-cutover.md`）。

G6-A 全程：不写真实库、不升级真实 schema、不开启正式 G4/G5、不发布 Snapshot、不自动调用 AI、不进入 G6-B。

## 2. G6-B：真实生产切换（**必须由用户再次明确授权后才能执行**）

以下动作**不属于本轮**，任一步骤失败都不得自动继续：

1. 停止正式服务；
2. 真实库一致性备份与备份验证；
3. 源 fingerprint 门禁；
4. 真实库 v4→v6 受控升级；
5. 升级后只读验证；
6. G4/G5 正式版本晋升包导入与导入后 hash/版本/行数验证；
7. 开启正式 G4/G5 入口；
8. 全链路生产烟测；
9. 失败时恢复升级前备份；
10. Snapshot 裁决执行；
11. 用户最终确认；
12. push / merge main / Tag / Release 的分开授权。

## 3. 不可含糊的结论

- G1~G5 已验收；**G6 尚未验收**；**v0.7 尚不可发布**。
- **G6-A 完成不等于授权 G6-B。** 真实生产切换、开启正式 G4/G5、升级真实 schema、发布 Snapshot、push/合并 main/Tag/Release 均需用户在 G6-B 分别明确授权。
