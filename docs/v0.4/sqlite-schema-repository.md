# OfferFlow v0.4 T3 SQLite Schema 与基础 Repository 实现

## 1. 背景

T1 已验证 Tauri + SQLite 最小技术闭环，T2 已完成 storage adapter 设计并由用户验收通过。

T3 进入 SQLite 侧地基层实现：建立 schema 初始化、基础 repository 和 Rust 侧最小验证能力。但 T3 仍不接入现有业务页面，不替换 `localStorage`，不迁移旧数据，不修改 `src/storage/` 运行逻辑。

## 2. 目标与非目标

目标：

1. 在 `src-tauri/` 内实现 SQLite schema 初始化。
2. 创建 `app_meta`、`profiles`、`jobs`、`migration_logs`、`backup_logs` 五张表。
3. 实现 `schema_version` 写入 / 读取。
4. 实现最小 profile repository：upsert profile、get profile。
5. 实现最小 job repository：upsert job、get job、list jobs by `updated_at desc`、delete job。
6. 验证“完整对象 -> 派生独立索引列 -> 同次写入 data_json 和列”的一致性路径。
7. 用 Rust 单元测试和 Tauri 启动期 smoke 验证 repository 可用。

非目标：

1. 不修改 Vue 页面。
2. 不修改现有 `src/storage/` 运行逻辑。
3. 不替换 `localStorage`。
4. 不读取或迁移真实 `localStorage` 数据。
5. 不写备份恢复 UI。
6. 不写正式迁移命令。
7. 不删除旧数据。
8. 不改 `JobRecord` / `JobSeekerProfile` 字段含义。
9. 不做 AI API、BYOK、云同步、账号或 Boss 自动化。

## 3. 实现文件

T3 Rust 侧新增模块：

```txt
src-tauri/src/sqlite/
  database.rs
  error.rs
  mod.rs
  models.rs
  repository.rs
  schema.rs
```

并更新：

```txt
src-tauri/src/lib.rs
```

## 4. 数据库文件路径

T3 使用独立 smoke 验证数据库文件：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3
```

说明：

1. `offerflow-t3.sqlite3` 只用于 T3 repository smoke，不是正式业务数据库切换结果。
2. T1 的 `offerflow-spike.sqlite3` 仍只是 T1 最小读写验证文件。
3. 后续正式数据库文件名仍建议按 v0.4 方案收敛为 `offerflow.sqlite3`，并在真正切换 storage adapter 前再次确认。

## 5. Schema Version

T3 使用两个层次记录 schema version：

1. `PRAGMA user_version = 1`
2. `app_meta` 中写入：

```txt
key = schema_version
value = 1
```

当前 schema version：

```txt
1
```

## 6. SQLite Schema

T3 采用 v0.4 已定原则：

```txt
核心索引字段独立列 + 完整对象 data_json
```

### 6.1 app_meta

```sql
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

用途：

1. 保存 `schema_version`。
2. 后续保存 `migration_status`、`last_backup_at` 等应用元信息。

### 6.2 profiles

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  target_city TEXT,
  target_role TEXT,
  expected_salary TEXT,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
```

当前 profile id 固定为：

```txt
default
```

独立列：

1. `id`
2. `target_city`
3. `target_role`
4. `expected_salary`
5. `updated_at`

`data_json` 保存完整 profile 对象。T3 先使用 Rust 侧 smoke fixture，T4/T5 接业务模型时再映射真实 `JobSeekerProfile`。

### 6.3 jobs

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  city TEXT,
  salary_range TEXT,
  communication_status TEXT,
  parse_status TEXT,
  ai_pasted_at INTEGER,
  match_score TEXT,
  opportunity_score INTEGER,
  apply_advice TEXT,
  risk_level TEXT,
  company_size_tier TEXT,
  last_greeted_at INTEGER,
  followup_count INTEGER NOT NULL DEFAULT 0,
  last_followup_at INTEGER,
  high_value_signal INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL
);
```

独立列用于列表、筛选、排序和迁移校验：

1. `id`
2. `created_at`
3. `updated_at`
4. `company`
5. `role`
6. `city`
7. `salary_range`
8. `communication_status`
9. `parse_status`
10. `ai_pasted_at`
11. `match_score`
12. `opportunity_score`
13. `apply_advice`
14. `risk_level`
15. `company_size_tier`
16. `last_greeted_at`
17. `followup_count`
18. `last_followup_at`
19. `high_value_signal`

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_city ON jobs (city);
CREATE INDEX IF NOT EXISTS idx_jobs_communication_status ON jobs (communication_status);
CREATE INDEX IF NOT EXISTS idx_jobs_opportunity_score ON jobs (opportunity_score);
```

`data_json` 保存完整 job 对象。T3 先使用 Rust 侧 `JobDocument` fixture；后续 T4/T5 接真实 `JobRecord` 时，必须从同一个 normalized `JobRecord` 派生这些独立列。

### 6.4 migration_logs

```sql
CREATE TABLE IF NOT EXISTS migration_logs (
  id TEXT PRIMARY KEY,
  migration_type TEXT NOT NULL,
  status TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  backup_path TEXT,
  profile_count_before INTEGER,
  job_count_before INTEGER,
  profile_count_after INTEGER,
  job_count_after INTEGER,
  checksum_before TEXT,
  checksum_after TEXT,
  error_message TEXT,
  data_json TEXT
);
```

用途：

1. 记录 localStorage -> SQLite 迁移。
2. 记录未来 schema upgrade。
3. 保留迁移前后数量、备份路径、校验摘要和错误信息。

T3 只建表，不写正式迁移日志。

### 6.5 backup_logs

```sql
CREATE TABLE IF NOT EXISTS backup_logs (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT,
  profile_count INTEGER,
  job_count INTEGER,
  size_bytes INTEGER,
  checksum TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_message TEXT,
  data_json TEXT
);
```

用途：

1. 记录迁移前 JSON 备份。
2. 记录未来 SQLite 文件备份。
3. 保留数量、大小、checksum 和错误信息。

T3 只建表，不实现备份流程。

## 7. Repository 能力

### 7.1 app_meta

已实现：

1. `set_app_meta(conn, key, value, updated_at)`
2. `get_app_meta(conn, key)`

T3 smoke 会写入并读回：

```txt
schema_version=1
```

### 7.2 profile repository

已实现：

1. `upsert_profile(conn, profile)`
2. `get_profile(conn)`

行为：

1. 固定写入 `profiles.id = default`。
2. 独立列从 profile fixture 派生。
3. 完整对象写入 `data_json`。
4. 读取时返回独立列和解析后的 `data_json`。

### 7.3 job repository

已实现：

1. `upsert_job(conn, job)`
2. `get_job(conn, id)`
3. `require_job(conn, id)`
4. `list_jobs_by_updated_desc(conn)`
5. `delete_job(conn, id)`

行为：

1. `upsert_job` 只接收完整 `JobDocument`，调用方不传第二套列数据。
2. repository 内部从完整对象派生独立列。
3. `high_value_signal` 在 SQLite 列中写为 `0 / 1`，在 JSON 中保持 boolean。
4. `list_jobs_by_updated_desc` 使用 SQLite `ORDER BY updated_at DESC`。
5. `delete_job` 返回是否删除了已存在记录。
6. `require_job` 对不存在记录返回稳定 `not_found` 错误。

## 8. 一致性策略

SQLite 写入必须遵守：

```txt
完整对象 -> derive indexed columns -> 同次写入独立列和 data_json
```

T3 的落地方式：

1. profile 只暴露 `upsert_profile(conn, &ProfileDocument)`。
2. job 只暴露 `upsert_job(conn, &JobDocument)`。
3. 独立列由 repository 内部派生。
4. 调用方不能单独传 `company`、`role`、`updated_at` 等列值来绕过 `data_json`。

后续 T4/T5 要求：

1. 使用真实 `JobRecord` 前，先建立 `JobRecord -> SQLite columns` 的映射函数。
2. 映射函数必须覆盖 v0.3 跟进事实字段：`lastGreetedAt`、`followupCount`、`lastFollowupAt`、`highValueSignal`。
3. `lastCommunicationNote`、`strategyOverride`、`draftMessageText` 保存在 `data_json`，不作为 T3 独立索引列。
4. `strategy`、`nextAction`、`stopLoss`、`scenario`、`companyWarning` 等派生结果仍不得落库。

## 9. 错误处理

T3 Rust 侧定义 `StorageError`，至少区分：

1. `database_open_failed`
2. `schema_init_failed`
3. `json_serialize_failed`
4. `json_deserialize_failed`
5. `write_failed`
6. `query_failed`
7. `not_found`

Tauri command 返回稳定错误文案，不把底层 SQL 错误文本作为未来页面层契约直接泄漏。Tauri setup 的本地开发日志可以附带技术细节，便于调试。

## 10. 验证结果

T3 已验证：

1. schema 创建成功。
2. `app_meta.schema_version=1` 可写入并读回。
3. profile 测试数据可 upsert / get。
4. job 测试数据可 upsert / get / list by `updated_at desc` / delete。
5. Tauri dev 启动期 smoke 能创建 / 打开 `offerflow-t3.sqlite3`。
6. Web 构建仍通过。

验证命令：

```txt
npm.cmd run typecheck
npm.cmd run build
cargo check
cargo test
npm.cmd exec tauri -- dev
```

结果：

```txt
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 通过，3 passed
npm.cmd exec tauri -- dev => 通过，Tauri app 输出 T3 repository smoke 日志
```

Tauri dev smoke 日志：

```txt
[OfferFlow T3 SQLite Repository] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3 schema_version=1 profile_id=default job_id=t3-smoke-job-new listed_jobs=t3-smoke-job-new,t3-smoke-job-old remaining_jobs=0
```

## 11. 边界自检

T3 未做：

1. 未修改现有 Vue 页面。
2. 未修改 `src/storage/`。
3. 未替换 localStorage。
4. 未读取真实 localStorage 数据。
5. 未写 localStorage -> SQLite 迁移。
6. 未写备份恢复 UI。
7. 未改 `JobRecord` / `JobSeekerProfile` 字段含义。
8. 未接 AI API、BYOK、云同步、账号或 Boss 自动化。
9. 未 push 远程。

## 12. 后续建议

建议进入 T4：localStorage JSON 备份导出。

T4 建议边界：

1. 只做手动 JSON 备份导出能力。
2. 不迁移到 SQLite。
3. 不替换现有业务存储。
4. 不删除旧 localStorage 数据。
5. 为后续正式迁移提供可验证的备份文件结构、数量统计和 checksum 策略。

