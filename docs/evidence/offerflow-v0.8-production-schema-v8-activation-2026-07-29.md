# OfferFlow v0.8 生产数据库 schema v8 受控迁移证据

> 日期：2026-07-29
> 结果：PASS
> 产品版本：`v0.8.0-rc1`（非 GA）
> Radar 正式入口：DISABLED

## 0. 口径边界（先读）

- 本文件仅记录**生产数据库 schema 已从 v7 迁移到 v8**这一运维事实。
- **产品仍为 `v0.8.0-rc1`，不得据此声明 GA / 正式发布 / 版本完成。**
  GA 前置（30 条真实评测、核心页面真实截图与产品文案人工验收、V8-UX 人工无说明 smoke）
  未因本次迁移而解除。
- `PRODUCTION_SCHEMA_VERSION` 常量仍为 **2**（生产底座下限语义，未修改）；
  `LATEST_SCHEMA_VERSION=8`。启动门禁 requiredVersion 在未开 Radar flag 时仍为 6。
- 本轮**未导入任何 fixture、未发布 Snapshot、未启用任何生产开关（Radar/Analysis 正式入口保持 DISABLED）**。
- 未 commit 生产数据库（DB 在 Git 忽略目录）、未 merge、未 push、未 tag。

## 1. 授权与代码锁定

- 用户明确授权真实生产数据库 schema v8 受控迁移。
- 迁移时分支 `feat/v0.8-v8-6`，HEAD `513c9f2`；migration 与升级入口无改动。
- 使用与演练完全一致的已提交入口 `db:upgrade-real`（内部走 `runMigrations`，非手写 SQL）。
- package version 保持 `0.7.0`；本次仅新增本证据文档与 traceability/RC 口径更新。

## 2. 生产 DB 路径与迁移前基线（只读查证）

- 生产库使用仓库默认相对路径 `<仓库根>/data/offerflow.sqlite3`；
  未设置 `OFFERFLOW_DB_PATH` / `OFFERFLOW_SYNC_DIR` / `OFFERFLOW_BACKUP_DIR` 覆盖。
- 迁移前 schema version：**7**；`schema_migrations` 连续 1～7（末条 `007_v0_8_radar_domain_schema`）；
  `app_meta.schema_version = '7'`。
- 文件 SHA-256：`d1c114b93a8931d31f30839b091d60ef91c78356a4d761270e2e209af92926ff`。
- 文件大小：1,273,856 字节；mtime UTC：`2026-07-22T06:00:28.888Z`。
- `PRAGMA integrity_check=ok`；`PRAGMA foreign_key_check` 结果 0 条。
- 既有表 **37** 张；10 张 radar 表均为 0 行。
- 关键业务行数：jobs=15、applications=9、feedback_events=11、resume_versions=1、profiles=1。

## 3. Baseline backup（正式工具 + 真实 Snapshot pair）

- 工具：`npm run job-memory-v2:backup-current`（在线 `.backup()` + 捕获真实 Snapshot pair + 自校验）。
- backupId：`20260729-121058-r01-ca1780dc`；purpose `r0.1-pre-snapshot-sync`；绑定 gitCommit `513c9f2`。
- 备份位置（Git 忽略）：`backups/job-memory-v2/20260729-121058-r01-ca1780dc/`
  - `offerflow-v2.sqlite3`（1,273,856 字节，SHA-256
    `f13f264cd9653095b9084ab01b1aa45acb9487799a0b2c8f8bd346e8ab5d7d02`）。
    注：该 SHA 与迁移前源库文件 SHA 不同，属在线 `.backup()` 去碎片化的预期结果；
    工具以 `normalizedFingerprint`（`1906ead25368…`）证明逻辑等价，非裸字节。
  - `snapshot-v2-before-sync/`：真实 Snapshot pair —— `offerflow.snapshot.json`
    （267,778 字节，SHA-256 `cf98e5cfa336…`）与 `offerflow.manifest.json`
    （438 字节，SHA-256 `1ac7200bb34b…`）。
- 独立恢复核验：从备份复制独立副本以 `readonly + query_only` 打开，
  `integrity_check=ok`、FK 违规 0、migrations 1～7、`app_meta=7`、37 张表 —— 与生产基线一致；核验后删除该副本。

## 4. 克隆演练（备份副本上，非生产）

- 从上述备份复制克隆副本，用与真实迁移完全一致的 `db:upgrade-real` 入口执行（先 dry-run，再 `--confirm`）。
- 结果：schema 7→8，`integrity_check=ok`、FK 违规 0、`verifyOk=true`、`countsPreserved=true`。
- 表数 37→38，仅新增 `radar_candidate_relations`（+3 索引），新增 `radar_rule_assessments.evidence_json` 列；
  全部既有业务行数逐一不变；`schema_migrations` 末条 `008_v0_8_radar_candidate_relations_schema`。
- `npm run migration:selftest` passed（其内含 v7→v8 升级/幂等/约束/故障注入回滚全套断言）。
- `npm run db:doctor`（指向克隆副本）：`ok`、`integrity=ok`、FK 违规 0。

## 5. 真实生产迁移（Checkpoint C）

- 命令：`npm run db:upgrade-real -- --confirm --expected-source-fingerprint <迁移前源库 SHA-256>`（源指纹锁）。
- 工具在迁移前自动创建预迁移备份并校验其指纹与锁定源一致。
- **db:upgrade-real 预迁移备份位置（Git 忽略，回滚入口）：**
  `backups/capability-baseline/offerflow-pre-v8-2026-07-29T04-14-04-369Z.sqlite3`
  （1,273,856 字节；backupFingerprint 与迁移前源库 SHA-256 `d1c114b9…` 一致）。
- 迁移结果：schema **7→8**；末条 migration `008_v0_8_radar_candidate_relations_schema`；
  `app_meta.schema_version = '8'`。
- 迁移后文件 SHA-256：`098e8c98f229e5c4bbfad00626755e7f68bb64b3e579fbc08db198588127ee7d`；
  大小 1,298,432 字节；mtime UTC：`2026-07-29T04:14:04.395Z`。
- 表数 **37→38**（仅新增 `radar_candidate_relations` + 3 索引；`radar_rule_assessments` 新增 `evidence_json` 列）。
- 业务表行数保持：jobs=15、applications=9、feedback_events=11、resume_versions=1、profiles=1（迁移前后一致）；
  10+1 张 radar 表仍全部为 0 行。
- `integrity_check=ok`；`foreign_key_check` 结果 0 条（`foreignKeyViolations=0`）。
- `snapshotPublished=false`（迁移不发布 Snapshot，符合 runbook）。

## 6. 只读启动 smoke（Radar 关闭，隔离 sync）

- 用真实服务代码路径 `buildServer`（生产入口选项：capabilityBaseline / historyImport /
  marketPosition / strategyWindow 开启，**Radar 未启用**）针对生产 v8 库启动。
- 同步目录隔离到本次 Git 忽略的维护目录（`OFFERFLOW_SYNC_DIR` 覆盖），
  使启动 `snapshotExists=false`、跳过 `importSnapshot`，杜绝历史 Snapshot 导入造成非本次授权写入；
  停服快照导出只落到隔离目录，不覆盖真实 `sync/`、不产生 Git 改动。
- 启动门禁：current=8 ≥ requiredVersion=6 且 ≤ latestVersion=8 → `plan.kind='ok'`，v8 库正常启动。
- 只读端点结果：`/health`、`/meta/db-path`、`/profile`、`/jobs`、`/resume-versions`、
  `/job-match-profile`、`/market-position`、`/strategy/current` 全部返回 **200**。
- Radar 后端路由未注册：`/radar/import`、`/radar/candidates` 返回 **404**（正式入口 DISABLED 佐证）。
- 停服后生产库 raw SHA-256、`captureCurrentProductionState` 规范化指纹、全部表行数
  与 smoke 前完全一致（`RAW_SHA_UNCHANGED / NORM_FP_UNCHANGED / TABLE_COUNTS_UNCHANGED` 均为 true）——
  证明 smoke 全程零写入。
- 另跑 `npm run build`（`vue-tsc --noEmit && vite build`）通过，3140 模块。

## 7. 回滚入口

- 首选回滚源：`db:upgrade-real` 预迁移备份
  `backups/capability-baseline/offerflow-pre-v8-2026-07-29T04-14-04-369Z.sqlite3`
  （schema=7，SHA-256 `d1c114b9…`）。停写后以该文件覆盖
  `<仓库根>/data/offerflow.sqlite3` 即可回到迁移前 v7 状态。
- 次选回滚源：baseline backup `backups/job-memory-v2/20260729-121058-r01-ca1780dc/offerflow-v2.sqlite3`
  （逻辑等价 v7，含同目录真实 Snapshot pair）。
- 回滚详细流程另见 `docs/runbooks/offerflow-v0.8-migration-recovery.md`。
- 两份备份均在 Git 忽略目录，本次迁移未覆盖任何既有备份。

## 8. 最终裁决

- 生产 schema=**v8**（`app_meta.schema_version='8'`，migrations 1～8）。
- 产品版本=**`v0.8.0-rc1`**（非 GA；GA 前置未解除）。
- Radar 正式入口=**DISABLED**；`PRODUCTION_SCHEMA_VERSION` 常量仍为 2。
- 未导入 fixture、未发布 Snapshot、未启用任何生产开关。
- 未触发恢复；迁移前备份与真实 Snapshot pair 继续保留在 Git 忽略目录。
- 未 merge、未 push、未 tag。
