# OfferFlow v0.8 Migration & Recovery Runbook

> **Runbook 版本：** 1.0  
> **起点：** v0.7 当前生产 SQLite schema  
> **目标：** 在不破坏 Job/Application/FeedbackEvent 与正式画像的前提下新增 v0.8 雷达领域

---

## 1. 原则

- 只新增表、索引、外键与必要约束；
- 不改写 v0.7 正式对象语义；
- 不自动把历史 Job 反向生成雷达候选；
- migration 前必须创建一致性备份；
- 必须先在真实生产库副本演练；
- 发布失败优先恢复完整备份，不编写猜测性逆向业务删除；
- 真实生产 migration 需要用户明确授权。

### 1.1 schema v7 生产激活时点（V8-1 结单审计补充）

`RADAR_DOMAIN_SCHEMA_VERSION = 7` 在 V8-1 引入后，`PRODUCTION_SCHEMA_VERSION` 与 `buildServer` 的
真实服务能力链（`requiredVersion`）均**保持不变**，与 v3/v4/v5/v6 引入时的模式一致：schema 定义先行，
生产默认目标在对应能力真正需要该 schema 时才切换。

真实生产库启动时不会自动迁移到 v7（`server/index.ts` 的 `allowAutoMigrate` 对真实库路径固定为
`false`）；`initSchema(db)` 不带参数时仍只到 `PRODUCTION_SCHEMA_VERSION = 2`。schema v7（12 张雷达表）
目前只在显式指定 `targetVersion: 7` 的测试库、演练库,或运行 `npm run db:upgrade-real -- --confirm`
（会升级到 `LATEST_SCHEMA_VERSION`）时被创建。

**v7 切换为生产默认目标的时点固定在 V8-2**：V8-2 注册雷达采集路由并首次调用 radar Repository 时，
必须同时在 `buildServer` 的能力链中加入雷达能力标志（把 `requiredVersion` 提升到 7），并要求在该版本
部署到真实库前先执行 `npm run db:upgrade-real -- --confirm` 完成显式升级。V8-1 阶段不做此切换，因为
V8-1 尚无任何路由依赖这些表，提前切换没有收益且会扩大 V8-1 的变更面。

---

## 2. 准备

### 2.1 停止写入

- 关闭 OfferFlow 写操作；
- 确认没有 running migration；
- 记录当前应用版本、commit、schema version 与数据库路径。

### 2.2 创建工作目录

```bash
mkdir -p backups/migration-v0.8
```

### 2.3 记录元数据

```bash
sha256sum <production.db> > backups/migration-v0.8/pre.sha256
sqlite3 <production.db> 'PRAGMA user_version;' > backups/migration-v0.8/pre-user-version.txt
sqlite3 <production.db> '.schema' > backups/migration-v0.8/pre-schema.sql
```

路径由实际环境替换，禁止把生产数据库或备份提交 Git。

---

## 3. 一致性备份

优先使用 SQLite 在线备份：

```bash
sqlite3 <production.db> ".backup 'backups/migration-v0.8/pre-v0.8.db'"
```

随后验证：

```bash
sqlite3 backups/migration-v0.8/pre-v0.8.db 'PRAGMA integrity_check;'
sqlite3 backups/migration-v0.8/pre-v0.8.db 'PRAGMA foreign_key_check;'
sha256sum backups/migration-v0.8/pre-v0.8.db > backups/migration-v0.8/backup.sha256
```

期望：

- `integrity_check` 返回 `ok`；
- `foreign_key_check` 无输出。

---

## 4. 在副本演练

```bash
cp backups/migration-v0.8/pre-v0.8.db backups/migration-v0.8/rehearsal.db
```

对 `rehearsal.db` 执行仓库 migration 命令。

检查：

- 新表存在；
- v0.7 表行数未减少；
- active Resume/Profile/Baseline/Market/Strategy 版本不变；
- Job/Application/FeedbackEvent 行数与关键 hash 不变；
- 外键与唯一约束有效；
- CandidateVersion 可创建并回溯；
- 不存在 `radar_application_marks`。

---

## 5. 迁移后检查清单

### 5.1 SQLite 完整性

```bash
sqlite3 <migrated.db> 'PRAGMA integrity_check;'
sqlite3 <migrated.db> 'PRAGMA foreign_key_check;'
```

### 5.2 Schema

检查至少存在：

- radar_capture_sessions；
- radar_capture_snapshots；
- radar_source_records；
- radar_candidates；
- radar_candidate_versions；
- radar_candidate_sources；
- radar_rule_assessments；
- analysis_tasks；
- job_match_analysis_records；
- radar_recommendation_batches；
- radar_actions；
- radar_promotions。

明确不存在：

- radar_application_marks；
- Opportunity；
- 第二套 Application/FeedbackEvent。

### 5.3 业务不变量

- Candidate.lifecycle_status 只允许 active/merged/archived；
- Candidate.active_version_id 指向同 candidate 的版本；
- merged candidate 有 merged_into_candidate_id；
- AnalysisRecord 引用 candidate_version_id；
- Action 引用 candidate_version_id；
- Promotion 引用 candidate_version_id；
- input_hash/idempotency_key 唯一约束可用。

---

## 6. 数据冒烟

在 rehearsal 数据库：

1. 创建一条 capture session；
2. commit 生成 snapshot/source/candidate/version；
3. 重复 commit 同内容，确认幂等；
4. 修改薪资，确认创建新 CandidateVersion；
5. 添加 ignored Action；
6. 添加 marked_applied_pending Action；
7. 确认无 Application；
8. 创建 AnalysisTask 与 AnalysisRecord；
9. 切换 ResumeVersion，确认旧分析 stale；
10. 执行 Promotion 两次，确认正式对象不重复。

---

## 7. 正式迁移

只有在以下条件全部满足时执行：

- 文档与 Release Contract 已批准；
- migration 代码审计通过；
- rehearsal 通过；
- 备份可恢复；
- 用户明确授权真实 migration。

执行顺序：

1. 停止写入；
2. 再次在线备份；
3. 运行 migration；
4. 完整性检查；
5. 启动应用；
6. v0.7 回归；
7. v0.8 最小冒烟；
8. 保留迁移日志与检查结果。

---

## 8. 回滚/恢复

### 8.1 触发条件

- integrity_check 非 ok；
- foreign_key_check 异常；
- v0.7 正式版本丢失或变化；
- 应用无法读取原有 Job/Application/FeedbackEvent；
- migration 部分执行且无法安全继续；
- 用户决定回退。

### 8.2 恢复步骤

1. 停止应用；
2. 保存失败数据库副本用于调查；
3. 用 pre-v0.8 一致性备份替换生产库；
4. 校验 hash、integrity、foreign keys；
5. 启动 v0.7 兼容应用版本；
6. 验证正式版本、Job/Application/FeedbackEvent；
7. 记录失败原因，禁止在生产库上直接试错。

### 8.3 不采用逆向删除

不通过手工 `DROP TABLE` 或猜测性 UPDATE 模拟回滚。新增表之间存在关联，逆向脚本容易留下半残状态；恢复完整一致性备份更可靠。

---

## 9. 应用进程重启恢复

启动钩子：

1. 扫描 queued/running AnalysisTask；
2. queued 可重新调度；
3. running 标记 failed，error=`PROCESS_RESTART_INTERRUPTED`；
4. 不自动重放无限次数；
5. 用户手动重试复用 input_snapshot；
6. 命中成功 input_hash 时直接复用结果。

这不是模型请求断点续跑。

---

## 10. 备份保留与清理

至少保留：

- 迁移前一致性备份；
- 迁移后首个稳定备份；
- 对应 schema、hash 与检查日志。

清理前确认：

- v0.8 已稳定使用；
- 用户明确同意；
- 至少仍有一份可验证的迁移前备份。

---

## 11. 证据归档

发布验收应保留：

- migration 命令输出；
- integrity_check；
- foreign_key_check；
- schema diff；
- v0.7 行数与关键 hash 对比；
- v0.8 冒烟结果；
- 恢复演练结果；
- 用户授权记录。
