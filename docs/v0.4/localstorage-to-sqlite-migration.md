# OfferFlow v0.4 T5 localStorage -> SQLite 迁移

## 1. 背景

T4 已实现迁移前 localStorage JSON 备份导出，并将 checksum 升级为正式 `sha256:<hex>` 格式。T5 在此基础上实现 localStorage -> SQLite 的正式迁移流程。

T5 仍不替换现有页面运行存储，不删除旧 localStorage，不接 UI 自动迁移入口。

## 2. 目标与非目标

目标：

1. 基于 T4 backup payload 派生 migration payload。
2. 迁移 profile 与 jobs 到 SQLite `profiles` / `jobs` 表。
3. 独立列从完整对象派生。
4. 完整对象写入 `data_json`。
5. 校验迁移前后数量和关键字段。
6. 写入 `migration_logs.status=succeeded`。
7. 写入 `app_meta.migration_status=migrated`。
8. 提供前端侧写入 localStorage done 标记的纯函数。
9. 失败时写入 `migration_logs.status=failed`，不写 migrated 状态。

非目标：

1. 不删除任何旧 localStorage 数据。
2. 不替换 `ConfigStore` / `JobStore`。
3. 不修改 `src/storage/` 现有运行逻辑。
4. 不改 Vue 页面。
5. 不做自动启动迁移 UI。
6. 不做恢复 UI。
7. 不做云同步 / AI API / 账号 / Boss 自动化。

## 3. 实现文件

新增：

```txt
src/app/localStorageSqliteMigration.ts
scripts/localStorageMigration.selftest.ts
src-tauri/src/sqlite/migration.rs
docs/v0.4/localstorage-to-sqlite-migration.md
```

修改：

```txt
src-tauri/src/lib.rs
src-tauri/src/sqlite/mod.rs
docs/v0.1/progress.md
```

## 4. 迁移流程

T5 实现的流程：

```txt
读取 T4 backup payload
  ↓
前端纯函数派生 migration payload
  ↓
必要时由前端调用 Tauri migration command
  ↓
Rust 创建 / 初始化 SQLite schema
  ↓
事务内写入 profiles / jobs
  ↓
校验数量和关键字段
  ↓
写入 migration_logs.status=succeeded
  ↓
写入 app_meta.migration_status=migrated
  ↓
前端确认成功后写入 localStorage done 标记
  ↓
保留旧 localStorage 原始数据
```

当前 T5 只提供能力和 smoke，不接页面自动入口。

## 5. 前端 migration payload

新增：

```ts
createLocalStorageSqliteMigrationPayload(backup, options?)
```

输入是 T4 的 `LegacyLocalStorageBackupPayload`。

输出结构：

```json
{
  "migrationVersion": 1,
  "createdAt": 1780000000001,
  "source": "localStorageBackup",
  "backupChecksum": "sha256:<64位hex>",
  "backupCreatedAt": 1780000000000,
  "profile": {},
  "jobs": [],
  "counts": {
    "profiles": 1,
    "jobs": 2,
    "backupRawEntries": 3,
    "backupParseErrors": 0,
    "warnings": 0
  },
  "warnings": []
}
```

namespace 选择策略：

1. profile 同时存在 `offerflow:profile` 与 `offerpilot:profile` 时，优先 `offerflow:profile`。
2. 同一 job id 同时存在 `offerflow:job:*` 与 `offerpilot:job:*` 时，优先 `offerflow:job:*`。
3. 冲突会写入 `warnings`，不静默吞掉。
4. T4 的 parse warnings 会带入 T5 migration warnings。

done 标记：

```txt
key = offerflow:migration:sqlite:v0.4
value = done
```

新增纯函数：

```ts
markSqliteMigrationDone(driver)
```

该函数只写 done 标记，不删除旧 key。

## 6. Rust migration command

新增 Tauri command：

```txt
migrate_localstorage_to_sqlite
```

输入：

```txt
migration_payload_json
```

输出：

```txt
db_path
migration_id
status
profile_count
job_count
backup_checksum
migration_status
```

T5 dev smoke 使用模拟 payload：

1. 1 个 profile。
2. 2 个 jobs。
3. `backupChecksum=sha256:1111...`。
4. 写入同一个 T3/T4 smoke SQLite 文件。

实际 smoke 数据库：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3
```

## 7. 字段映射

profile：

1. `profiles.id = default`
2. `target_city` <- `targetCity`
3. `target_role` <- `targetRole`
4. `expected_salary` <- `expectedSalary`
5. `data_json` <- 完整 profile 对象

jobs：

1. `id` <- `id`
2. `created_at` <- `createdAt`
3. `updated_at` <- `updatedAt`
4. `company` <- `company`
5. `role` <- `role`
6. `city` <- `city`
7. `salary_range` <- `salaryRange`
8. `communication_status` <- `communicationStatus`
9. `parse_status` <- `parseStatus`
10. `ai_pasted_at` <- `aiPastedAt`
11. `match_score` <- `matchScore`
12. `opportunity_score` <- `opportunityAnalysis.opportunityScore`
13. `apply_advice` <- `report.applyAdvice`，缺失时尝试 `opportunityAnalysis.applyAdvice`
14. `risk_level` <- `report.riskLevel`，缺失时尝试 `opportunityAnalysis.riskLevel`
15. `company_size_tier` <- `companyInput.sizeTier`，缺失时尝试 `companyAssessment.sizeTier`
16. `last_greeted_at` <- `lastGreetedAt`
17. `followup_count` <- `followupCount`
18. `last_followup_at` <- `lastFollowupAt`
19. `high_value_signal` <- `highValueSignal ? 1 : 0`
20. `data_json` <- 去除派生决策字段后的完整 job 对象

必须保留在 `data_json`：

1. `aiRawResult`
2. `report`
3. `parseStatus`
4. `communicationStatus`
5. `companyAssessment`
6. `opportunityAnalysis`
7. `lastGreetedAt`
8. `followupCount`
9. `lastFollowupAt`
10. `lastCommunicationNote`
11. `highValueSignal`
12. `strategyOverride`
13. `draftMessageText`

不得持久化的派生字段：

```txt
strategy
nextAction
stopLoss
scenario
companyWarning
```

如果旧数据中存在这些字段，迁移写入 `jobs.data_json` 前会移除。

## 8. 校验策略

迁移事务内至少校验：

1. profile 数量。
2. job 数量。
3. 每条 job 的：
   - `id`
   - `company`
   - `role`
   - `updated_at`
   - `communication_status`
   - `aiRawResult` 长度
4. backup checksum 必须是 `sha256:<64位hex>`。
5. `migration_logs.status=succeeded`。
6. `app_meta.migration_status=migrated`。

失败行为：

1. 事务回滚 profile / job 写入。
2. 尽量写入 `migration_logs.status=failed`。
3. 不写 `app_meta.migration_status=migrated`。
4. 不写 localStorage done 标记。
5. 不删除旧 localStorage 原始数据。

## 9. 验证结果

已运行：

```txt
npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts
npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts
npm.cmd run typecheck
npm.cmd run build
cargo check
cargo test
npm.cmd exec tauri -- dev
```

结果：

```txt
localStorage backup selftest => 通过，11 passed, 0 failed
localStorage migration selftest => 通过，12 passed, 0 failed
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 通过，7 passed
npm.cmd exec tauri -- dev => 通过，T3/T4/T5 smoke 均成功
```

Tauri T5 smoke：

```txt
[OfferFlow T3 SQLite Repository] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3 schema_version=1 profile_id=default job_id=t3-smoke-job-new listed_jobs=t3-smoke-job-new,t3-smoke-job-old remaining_jobs=2
[OfferFlow T4 LocalStorage Backup] backup_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-051752.json checksum=sha256:f15bb4e7c319eef6d3f4693ad238b960546003aeeec88111d7410756fc00de81 size_bytes=1353 profile_count=1 job_count=1 raw_entries=2 backup_log_id=localstorage-json-1782710272-f15bb4e7c319eef6d3f4693ad238b960546003aeeec88111d7410756fc00de81
[OfferFlow T5 LocalStorage Migration] migration_id=localstorage-to-sqlite-1782710272000-1111111111111111111111111111111111111111111111111111111111111111 status=succeeded profile_count=1 job_count=2 backup_checksum=sha256:1111111111111111111111111111111111111111111111111111111111111111 migration_status=migrated
```

T3 repository smoke 在持久数据库中只校验本次 T3 fixture 的两个 job 相对顺序，避免被 T5 smoke 写入的迁移测试数据影响。

localStorage done 标记由 `scripts/localStorageMigration.selftest.ts` 验证：

```txt
offerflow:migration:sqlite:v0.4=done
```

并确认旧 profile/job key 未被删除。

## 10. 后续建议

建议进入 T6：迁移校验强化与失败回滚测试。

T6 建议补强：

1. 更多坏数据 fixture。
2. namespace 冲突矩阵。
3. 重复迁移幂等性。
4. 校验失败时的 failed log 内容。
5. 不写 done 标记的失败路径端到端测试。
