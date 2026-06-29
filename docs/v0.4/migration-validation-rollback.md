# OfferFlow v0.4 T6 迁移校验强化与失败回滚测试

## 1. 背景

T5 已完成 localStorage backup payload -> migration payload -> SQLite 写入链路。T6 不新增业务功能，只强化失败路径、校验边界、幂等行为和回滚测试，确保迁移链路不只在 happy path 成功。

T6 仍不替换现有 `ConfigStore` / `JobStore`，不修改 `src/storage/` 运行逻辑，不改 Vue 页面，不删除旧 localStorage。

## 2. 覆盖范围

T6 覆盖以下场景：

1. 备份失败。
2. profile 写入失败。
3. job 写入中途失败。
4. 校验失败。
5. 坏数据场景。
6. namespace 冲突。
7. 幂等 / 重复迁移。
8. done 标记写入失败。

## 3. 备份失败策略

备份失败发生在 SQLite migration command 之前。

策略：

1. 不创建 migration payload。
2. 不调用 SQLite migration command。
3. 不写 `app_meta.migration_status=migrated`。
4. 不写 `offerflow:migration:sqlite:v0.4=done`。
5. 不删除旧 localStorage。
6. 失败原因由调用层保留并展示或记录；T6 selftest 用门禁测试验证不会继续进入迁移。

覆盖：

```txt
scripts/localStorageMigration.selftest.ts
backup failure prevents migration payload creation
backup failure does not write done marker
backup failure preserves old profile key
```

## 4. 事务回滚策略

Rust 侧迁移在单个 SQLite transaction 中执行：

```txt
insert migration_logs.running
  -> upsert profile
  -> upsert jobs
  -> validate profile/jobs
  -> set app_meta.migration_status=migrated
  -> insert migration_logs.succeeded
  -> commit
```

任一步失败时：

1. transaction 自动回滚。
2. 已写入的 profile/job 不保留。
3. 不写 `app_meta.migration_status=migrated`。
4. transaction 外尽量写入 `migration_logs.status=failed`。
5. `migration_logs.data_json.errorCode` 记录失败错误码。

## 5. profile 写入失败

测试方式：破坏测试库的 `profiles` 表，使 profile upsert 失败。

预期：

1. jobs 不会部分写入。
2. `migration_logs.status=failed` 有记录。
3. `app_meta.migration_status` 不存在。

覆盖：

```txt
cargo test profile_write_failure_rolls_back_jobs_and_logs_failed
```

## 6. job 写入中途失败

测试方式：第一个 job 可写，第二个 job 缺失 `updatedAt`，触发中途失败。

预期：

1. 已写入的 profile 回滚。
2. 已写入的第一个 job 回滚。
3. `migration_logs.status=failed` 有记录。
4. 不写 migrated。

覆盖：

```txt
cargo test job_write_midway_failure_rolls_back_profile_and_jobs
```

## 7. 校验失败

关键字段校验范围：

```txt
id
company
role
updatedAt
communicationStatus
aiRawResult length
```

T6 额外增加 job id 去重校验，防止输入 payload 中同一个 job id 重复导致迁移数量不一致。

预期：

1. 校验失败时 transaction 回滚。
2. profile/job 不落库。
3. `migration_logs.status=failed` 有记录。
4. `migration_logs.data_json.errorCode=query_failed`。
5. 不写 migrated。

覆盖：

```txt
cargo test validation_failure_rolls_back_and_logs_failed
```

## 8. 坏数据场景

策略：

1. T4 parse warning 带入 T5 migration warnings。
2. 坏 JSON 原始 value 保留在 T4 backup `rawEntries`。
3. T5 不修复坏数据。
4. parse 失败的 job 不计入 migration jobs，不静默当成功迁移。

覆盖：

```txt
scripts/localStorageMigration.selftest.ts
backup parse warning is carried forward
bad JSON raw value is preserved by backup
job count excludes bad JSON
```

## 9. namespace 冲突

策略：

1. `offerflow:profile` 优先于 `offerpilot:profile`。
2. 同 job id 下 `offerflow:job:*` 优先于 `offerpilot:job:*`。
3. 冲突写入 warnings。
4. 迁移数量按最终选中的 profile/jobs 计算。

覆盖：

```txt
scripts/localStorageMigration.selftest.ts
offerflow profile wins over legacy profile
profile conflict is warned
duplicate job id is migrated once
offerflow job wins over legacy job
```

## 10. 幂等 / 重复迁移

默认策略：

1. 如果 `app_meta.migration_status=migrated` 已存在，再次迁移返回 `already_migrated`。
2. 不覆盖既有 SQLite 数据。
3. 不写第二条 failed migration log。
4. 不新增第二个 done 标记。
5. force remigrate 不在 T6 默认实现范围内，后续如需要必须单独设计。

覆盖：

```txt
cargo test repeated_migration_returns_already_migrated_and_preserves_existing_data
scripts/localStorageMigration.selftest.ts
done marker remains a single key after repeated writes
```

## 11. done 标记写入失败

done 标记是前端在 SQLite 迁移成功后写入 localStorage 的 legacy marker：

```txt
offerflow:migration:sqlite:v0.4=done
```

策略：

1. 如果 SQLite 已迁移成功但 done 标记写入失败，状态定义为“数据库已迁移成功，但 legacy 标记失败”。
2. 错误向调用层抛出，不吞掉。
3. 不删除旧 localStorage。
4. 后续可重试写 done 标记；不需要重复执行 SQLite 迁移。

覆盖：

```txt
scripts/localStorageMigration.selftest.ts
done marker write failure is surfaced
done marker write failure preserves old profile key
done marker write failure leaves done marker absent
```

## 12. 验证结果

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
localStorage backup selftest => 11 passed, 0 failed
localStorage migration selftest => 21 passed, 0 failed
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 12 passed, 0 failed
npm.cmd exec tauri -- dev => 通过，T3/T4/T5 smoke 均成功
```

Tauri dev smoke：

```txt
[OfferFlow T3 SQLite Repository] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3 schema_version=1 profile_id=default job_id=t3-smoke-job-new listed_jobs=t3-smoke-job-new,t3-smoke-job-old remaining_jobs=2
[OfferFlow T4 LocalStorage Backup] backup_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-081350.json checksum=sha256:bacb5b93157eaeac4db415b8ebee1416b845d0ca0db60ea0a80362737d3d8d00 size_bytes=1353 profile_count=1 job_count=1 raw_entries=2 backup_log_id=localstorage-json-1782720830-bacb5b93157eaeac4db415b8ebee1416b845d0ca0db60ea0a80362737d3d8d00
[OfferFlow T5 LocalStorage Migration] migration_id=localstorage-to-sqlite-1782720831000-0000000000000000000000000000000000000000000000000000000000000001 status=succeeded profile_count=1 job_count=2 backup_checksum=sha256:0000000000000000000000000000000000000000000000000000000000000001 migration_status=migrated
```

## 13. 后续建议

T6 验收通过后，建议进入 T7：SQLite adapter 接入 `ConfigStore` / `JobStore`。T7 应继续小步推进，先做 adapter 接口和可切换运行路径，不直接删除 localStorage 兜底数据。
