# OfferFlow v0.7 阶段交接（2026-07-16，G6-A 发布准备与迁移演练）

## 1. 阶段状态

- G1（2026-07-15）、G2（2026-07-15）、G3（2026-07-15）、G4（2026-07-16）、G5（2026-07-16）**均已用户验收**。
- **G6-A（发布准备与生产迁移演练）已完成。**
- **G6-B（真实生产切换）已于 2026-07-16 经用户授权执行**：真实数据库已从 schema v4 受控升级到 **schema v6**，G4/G5 正式版本晋升包已导入，正式生产入口已开放 G4/G5，Snapshot 采用方案 B，全链路生产烟测通过。
- **G6 等待用户最终生产验收**；App 版本仍 `0.6.2`；**仍未授权 push、合并 main、Tag、Release**。
- **不得**写为：G6 已最终验收 / v0.7 已发布 / main 已合并 / 已 push / 已创建 Tag/Release。

## 1b. G6-B 执行结果（2026-07-16）

- 用户授权原文：“确认采用 Snapshot 方案 B，并授权执行 G6-B 真实生产切换；不授权 push、合并 main、Tag 或 Release。”
- 升级前基线：schema v4，SHA-256 `cdc214c8…`，jobs=15/applications=9/feedback_events=11。
- pre-cutover 备份：`backups/v0.7-production-cutover/offerflow-schema-v4-pre-cutover-*.sqlite3`（hash `cdc214c8…`，一次性回滚验证通过）。
- 升级：`db:upgrade-real --confirm --expected-source-fingerprint cdc214c8`，v4→v6，integrity=ok/fk=0/counts preserved；升级后 hash `020f69f7…`。
- 晋升导入：G4 `BCO_OHOKj4z4SZ7fkBaTC`、G5 `WBvQlz3yIigQ4o2bPv8Wj`、window `sw-069343080027d893`；generationMode=ai、decisionDiff 保留、G5→G4 引用正确；重复导入 alreadyApplied；导入后 hash `3a57ec78…`。
- 只读 verifier：schema=6、G1~G5 可读、证据收集窗口、writes=0。
- post-cutover 备份：`offerflow-schema-v6-post-cutover-*.sqlite3`（schema v6 新生产基线）。
- 恢复机制（方案 B）：Snapshot 对 schema>2 明确拒绝发布，未改 `SNAPSHOT_SCHEMA_VERSION`；正式恢复点为 pre-cutover v4 备份 + post-cutover v6 备份。
- 未发生失败与回滚；备份、候选、晋升包、日志、`.claude/launch.json` 未提交。

## 2. 分支与起点

- 分支：`feat/v0.7.0-g6-release-readiness`（从 G5 签收 HEAD `8f8f00d` 切出）。
- 包含 G5 AI 收口提交 `2038e54`、`6ba6c9d`。

## 3. 本轮交付（只操作副本，不触碰真实库）

- 晋升包实现：`server/release-promotion/bundle.ts`（导出/导入/幂等/安全校验）、`rehearsal.ts`（候选准备 + 回滚）。
- 脚本：`scripts/g6RehearsalPrepare.ts`（`npm run g6:rehearsal:prepare`）、`scripts/devG6Rehearsal.ts`（`npm run dev:g6-rehearsal`）。
- 前端：`src/config/features.ts`（`g6RehearsalEnabled`）、`src/router/index.ts`（G6 启用 G1~G5 路由）、`src/App.vue`（单条 G6 演练横幅，抑制 G4/G5 沙箱横幅）。
- 文档：`docs/product/offerflow-v0.7-g6-release-readiness.md`、`offerflow-v0.7-final-acceptance-matrix.md`、`docs/decisions/offerflow-v0.7-snapshot-release-decision.md`、`docs/runbooks/offerflow-v0.7-production-rollback.md`、`docs/runbooks/offerflow-v0.7-production-cutover.md`。
- 测试：`server/release-promotion/bundle.spec.ts`、`server/release-promotion/rehearsal.spec.ts`。
- 演练产物（gitignored，不入库）：`tmp/g6-rehearsal/`（候选库、升级前备份、晋升包、报告）。

## 4. 迁移演练结果（真实库副本）

- 真实库基线：schema v4，SHA-256 `cdc214c8…`，`integrity_check=ok`，`foreign_key_check=0`；关键行数 jobs=15 / applications=9 / feedback_events=11 / candidate_evidence=9 等。
- 候选副本 v4→v5→v6（migrationSequence=[5,6]），`integrity_check=ok`、`foreign_key_check=0`，G1~G3 关键表行数与内容 hash 保持，G4/G5 新表迁移后为空。
- 晋升包（sourceHash 记录于 attestation）：`g4ActiveVersionId=BCO_OHOKj4z4SZ7fkBaTC`、`g5ActiveWindowId=sw-069343080027d893`、`g5ActiveVersionId=WBvQlz3yIigQ4o2bPv8Wj`；导入后 active G4/G5 可读、`generationMode`/`decisionDiff` 保留、G5→G4 引用正确、Job/Application/FeedbackEvent 行数不变；相同晋升包重复导入 `alreadyApplied`。
- 回滚演练（一次性副本）：升级前 v4 备份恢复出 rollback 文件，`schema=4`、SHA-256 与升级前备份及真实基线一致、`integrity_check=ok`、`foreign_key_check=0`、G1~G3 行数一致。
- **真实数据库演练前后 SHA-256 完全一致，未被修改、未升级。**

## 5. 留给用户的最短裁决项

1. 采纳 Snapshot 裁决推荐（方案 B：以一致性备份为恢复机制，Snapshot 暂不支持 v6）或另选 A/C。
2. 是否授权 G6-B 真实生产切换（真实库 v4→v6 + 开启正式 G4/G5），按 `production-cutover.md` 逐步执行。
3. 切换成功后，是否分别授权 push / merge main / Tag / Release。

## 6. 未改变的结论

- 未 push、未合并 main、未创建 PR/Tag/Release、未进入 G6-B、未签收 G6。
- 未修改真实数据库、未升级真实 schema、未开启正式 G4/G5、未发布 Snapshot、未提交 `.claude/launch.json`。
