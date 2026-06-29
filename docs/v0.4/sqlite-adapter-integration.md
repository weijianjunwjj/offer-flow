# OfferFlow v0.4 T7 SQLite Adapter 接入

## 1. 背景

T7 的目标是让 OfferFlow 具备 SQLite 版 `ConfigStore` / `JobStore` 适配能力，使未来页面仍通过统一 store 接口读写数据，但底层可以选择 localStorage 或 SQLite。

T7 不是生产默认切换，不自动执行 localStorage -> SQLite 迁移，不删除旧 localStorage，不改 Vue 页面业务流程。

## 2. 分层结构

```txt
Vue Pages
  ↓
useStores / createAsyncStores
  ↓
统一 Store / Repository 接口
  ↓
LocalStorage adapter 或 SQLite adapter
  ↓
Browser localStorage 或 Tauri SQLite command
```

当前页面仍使用同步 `useStores()`，默认走 browser localStorage。T7 新增 async store factory：

```ts
createAsyncStores({ backend: 'localStorage' | 'sqlite' })
```

该 factory 是给 T7 smoke 和后续 T8 接入使用的受控入口，不会自动改变现有页面行为。

## 3. 新增 TypeScript Port / Adapter

新增文件：

```txt
src/storage/ports.ts
src/storage/localStorageRepositories.ts
src/storage/sqliteClient.ts
src/storage/sqliteRepositories.ts
```

`ports.ts` 定义 async repository 接口：

```ts
ProfileRepository
JobRepository
AsyncOfferFlowStores
StorageBackend
```

localStorage adapter 包装现有 `ConfigStore` / `JobStore`，以 Promise 形式暴露相同语义：

```txt
LocalStorageProfileRepository -> ConfigStore
LocalStorageJobRepository -> JobStore
```

SQLite adapter 使用 `TauriSQLiteClient` 调用 Tauri command：

```txt
SQLiteProfileRepository -> TauriSQLiteClient -> sqlite_* commands
SQLiteJobRepository -> TauriSQLiteClient -> sqlite_* commands
```

## 4. ConfigStore / JobStore 接入摘要

现有同步 `ConfigStore` / `JobStore` 未修改。

T7 通过 adapter 包装它们：

1. localStorage backend 复用现有 `ConfigStore.getProfile/saveProfile/clearProfile`。
2. localStorage backend 复用现有 `JobStore.createJob/getJob/listJobs/updateJob/deleteJob`。
3. SQLite backend 使用 async repository，不伪装成同步 store。
4. `src/app/stores.ts` 保留 `useStores()` 旧行为，同时新增 `createAsyncStores()`。

这保证当前页面调用方式不变，后续 T8 可以受控切换到 async store 路径。

## 5. 默认 Backend 策略

T7 默认策略：

```txt
浏览器 Web 模式：继续默认 localStorage
Tauri 桌面模式：允许 SQLite adapter smoke / 手动指定 SQLite backend
正式默认切换：留到 T8 或单独验收
```

T7 不基于 Tauri 环境自动迁移，也不因为运行在 Tauri 中就自动切换用户数据 backend。

## 6. Tauri Commands

新增 commands：

```txt
sqlite_get_profile
sqlite_save_profile
sqlite_clear_profile
sqlite_create_job
sqlite_get_job
sqlite_list_jobs
sqlite_update_job
sqlite_delete_job
```

命令职责：

1. 只做数据访问边界。
2. 不做页面业务判断。
3. 不触发迁移。
4. 不删除 localStorage。
5. 错误返回沿用 T6 的 `StorageErrorPayload`，不直接泄漏 SQL 底层错误。

## 7. SQLite 写入一致性

SQLite 写入仍遵守：

```txt
完整对象 data_json -> derive indexed columns -> 同次写入独立列和 data_json
```

T7 Rust adapter 从完整 profile/job JSON 派生独立列：

1. profile：`targetCity` / `targetRole` / `expectedSalary`。
2. job：`id` / `createdAt` / `updatedAt` / `company` / `role` / `city` / `salaryRange` / `communicationStatus` / `parseStatus` / `aiPastedAt` / `matchScore` / `opportunityScore` / `applyAdvice` / `riskLevel` / `companySizeTier` / v0.3 followup facts。

调用方不传第二套列数据，避免 `data_json` 和索引列冲突。

## 8. Job 行为兼容

T7 保持这些语义：

1. `createJob()` 生成完整默认字段。
2. `listJobs()` 按 `updatedAt` 倒序。
3. `updateJob()` 是 patch 语义：先读当前 job，再合并 patch，再写入完整对象。
4. `deleteJob()` 删除指定 job。
5. SQLite list 对异常 `data_json` 行采用跳过策略，避免一个坏行拖垮列表。

## 9. T7 Selftest / Smoke

新增：

```txt
scripts/storageAdapter.selftest.ts
```

覆盖：

1. localStorage backend 可保存 / 读取 / 清理 profile。
2. localStorage backend 可 create / list / update / delete job。
3. SQLite backend 可保存 / 读取 / 清理 profile。
4. SQLite backend 可 create / list / update / delete job。
5. `listJobs()` 按 `updatedAt` 倒序。
6. `updateJob()` patch 不丢已有字段。

Tauri debug 启动新增 T7 adapter smoke：

```txt
[OfferFlow T7 SQLite Adapter] ...
```

该 smoke 使用独立 `offerflow-t7-adapter-smoke-*.sqlite3` 文件，不污染正式用户数据。

## 10. 验证结果

已运行：

```txt
npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts
npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts
npm.cmd exec tsx -- scripts/storageAdapter.selftest.ts
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
storageAdapter.selftest => 14 passed, 0 failed
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 13 passed, 0 failed
npm.cmd exec tauri -- dev => 通过，T3/T4/T5/T7 smoke 均成功
```

Tauri T7 smoke：

```txt
[OfferFlow T7 SQLite Adapter] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t7-adapter-smoke-1782722023000.sqlite3 profile_target_city=Suzhou created_job_id=t7-smoke-job-new listed_jobs=t7-smoke-job-new,t7-smoke-job-old updated_match_score=91 patch_preserved_ai_raw=true deleted_job_missing=true
```

## 11. 后续建议

T7 验收通过后，建议进入 T8：受控切换 SQLite backend / 启动迁移入口设计。

T8 应重点处理：

1. 页面 async store 接入影响。
2. SQLite backend 选择开关。
3. 迁移入口的用户确认流程。
4. migrated / done 标记不一致时的恢复策略。
5. 旧 localStorage 只读兜底策略。
