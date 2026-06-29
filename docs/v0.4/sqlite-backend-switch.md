# OfferFlow v0.4 T8 SQLite Backend 受控切换设计

## 1. 背景

T7 已提供 SQLite adapter 能力，但默认 backend 仍是 localStorage。T8 的目标是让 OfferFlow 具备“明确、可控、可回退”的 SQLite backend 启用机制。

T8 不做全量默认切 SQLite，不自动迁移真实用户数据，不删除 localStorage，不改 Vue 页面业务流程。

## 2. Backend 标记

T8 新增明确 key：

```txt
offerflow:storage:backend = localStorage | sqlite
```

读写函数：

```ts
readBackendPreference(driver)
writeBackendPreference(driver, backend)
```

如果没有该 key，默认视为：

```txt
localStorage
```

## 3. 运行环境检测

新增：

```txt
src/storage/runtimeEnv.ts
```

当前只区分：

```txt
web
tauri
```

Web 浏览器模式不得尝试 SQLite；即使 localStorage 中误写了 `backend=sqlite`，也会回退到 localStorage。

## 4. Backend 状态机

新增：

```txt
src/storage/backendSelection.ts
```

状态类型：

```txt
localStorage_only
sqlite_available
sqlite_ready
migration_required
migration_running
migration_succeeded
migration_failed
already_migrated
sqlite_active
fallback_localStorage
```

核心判定：

1. Web runtime：始终 active `localStorage`。
2. Tauri runtime + 无明确 backend：active `localStorage`。
3. Tauri runtime + `backend=sqlite` + `app_meta.migration_status=migrated`：active `sqlite`。
4. Tauri runtime + `backend=sqlite` + 未 migrated：active `localStorage`，state=`migration_required`。
5. Tauri runtime + 最近 migration failed：active `localStorage`，state=`migration_failed`。

`sqlite_ready` 表示 SQLite 已迁移但用户尚未明确选择 sqlite backend，因此仍保持 localStorage active。

## 5. Bootstrap 方法

`src/app/stores.ts` 新增：

```ts
initializeStorageBackend(options)
```

返回：

```ts
{
  resolution,
  stores
}
```

说明：

1. `useStores()` 旧同步入口不变，仍默认 browser localStorage。
2. `initializeStorageBackend()` 是后续 T8/T9 受控接入入口。
3. 该方法不会自动迁移。
4. 只有 resolution 判定为 `sqlite_active` 时，才创建 SQLite async stores。

## 6. SQLite 迁移状态读取

Rust/Tauri 新增：

```txt
sqlite_get_storage_migration_status
```

返回：

```txt
migrationStatus
lastMigrationStatus
```

来源：

1. `app_meta.migration_status`
2. 最新一条 `migration_logs.status`

该命令只做数据访问，不做页面业务判断。

## 7. 受控迁移入口

新增：

```txt
src/app/controlledSqliteMigration.ts
```

核心函数：

```ts
runControlledLocalStorageToSqliteMigration()
```

流程：

```txt
确认 Tauri runtime
  ↓
读取 SQLite migration status
  ↓
already_migrated 则不重复迁移
  ↓
调用 T4 生成 localStorage backup payload
  ↓
调用 Tauri 写 backup 文件
  ↓
把 backup checksum 写回 payload
  ↓
调用 T5 生成 migration payload
  ↓
调用 Tauri 执行 SQLite migration
  ↓
写 localStorage done 标记
  ↓
写 offerflow:storage:backend=sqlite
```

只有迁移成功且 done 标记写入成功后，才写 `backend=sqlite`。

## 8. 失败回退策略

备份失败：

1. 不调用 migration。
2. 不写 `backend=sqlite`。
3. 不写 done 标记。
4. 不删除旧 localStorage。

迁移失败：

1. 不写 `backend=sqlite`。
2. 不写 done 标记。
3. 不删除旧 localStorage。
4. 返回 `migration_failed`。

already_migrated：

1. 不重复 backup。
2. 不重复 migration。
3. 可写 done 标记。
4. done 标记成功后写 `backend=sqlite`。

done 标记失败：

1. 返回 `done_marker_failed`。
2. 不写 `backend=sqlite`。
3. 不删除旧 localStorage。
4. 状态定义为“SQLite 数据库已迁移成功，但 legacy 标记失败”。

## 9. Selftest 覆盖

新增：

```txt
scripts/backendSwitch.selftest.ts
```

覆盖：

1. Web/default 仍走 localStorage。
2. Web 中误设 `backend=sqlite` 仍回退 localStorage。
3. Tauri/default 暴露 `sqlite_available`，但 active backend 仍是 localStorage。
4. Tauri/migrated 但无 preference 为 `sqlite_ready`，不 active。
5. 显式 sqlite + migrated 才是 `sqlite_active`。
6. 显式 sqlite + 未 migrated 为 `migration_required`，回退 localStorage。
7. migration failed 状态回退 localStorage。
8. migration succeeded 后写 `backend=sqlite`。
9. migration failed 不写 `backend=sqlite`。
10. backup failure 不执行 migration。
11. already_migrated 不重复 backup / migration。
12. done marker failure 不写 `backend=sqlite`。
13. 旧 localStorage profile/job 不删除。

## 10. 验证结果

已运行：

```txt
npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts
npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts
npm.cmd exec tsx -- scripts/storageAdapter.selftest.ts
npm.cmd exec tsx -- scripts/backendSwitch.selftest.ts
npm.cmd run typecheck
npm.cmd run build
cargo check
cargo test
```

结果：

```txt
localStorage backup selftest => 11 passed, 0 failed
localStorage migration selftest => 21 passed, 0 failed
storageAdapter.selftest => 14 passed, 0 failed
backendSwitch.selftest => 22 passed, 0 failed
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 13 passed, 0 failed
```

未完成验证：

```txt
npm.cmd exec tauri -- dev
```

结果：本轮补跑已发起，命令在 120 秒内未自然结束，随后清理了由本次命令残留的 npm / tauri / vite / esbuild 进程；未取得完整 Tauri dev smoke 通过结论。已有 `cargo check` / `cargo test` 验证 Rust/Tauri 命令可编译，Web build 也通过；仍需在环境允许时补跑 Tauri dev smoke。

## 11. 后续建议

T8 验收通过后，建议进入 T9：桌面模式最小 UI / 数据迁移确认入口。

T9 应聚焦：

1. 明确展示当前 backend。
2. 提供用户确认后的迁移入口。
3. 展示备份路径、迁移结果和失败原因。
4. 不删除旧 localStorage。
5. 支持失败后继续使用 localStorage。
