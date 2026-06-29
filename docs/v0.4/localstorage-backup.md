# OfferFlow v0.4 T4 localStorage JSON 备份导出

## 1. 背景

T3 已完成 SQLite schema 与基础 repository。进入正式 localStorage -> SQLite 迁移前，必须先具备迁移前 JSON 备份能力。

T4 只实现备份安全绳，不执行正式迁移，不替换现有业务存储，不修改页面 UI。

## 2. 目标与非目标

目标：

1. 在前端侧生成 localStorage 备份 payload。
2. 保留当前命名空间与旧命名空间数据：
   - `offerflow:profile`
   - `offerflow:job:*`
   - `offerpilot:profile`
   - `offerpilot:job:*`
3. JSON parse 成功的数据进入结构化字段。
4. 所有匹配 key 的原始 value 都进入 `rawEntries`。
5. JSON parse 失败时保留原始 value，并记录 warning。
6. 通过 Tauri command 把 payload 写入本地 `backups/` 目录。
7. Rust 写入侧生成 checksum，并记录 `backup_logs`。
8. 验证备份文件可读、结构完整。

非目标：

1. 不执行 localStorage -> SQLite 正式迁移。
2. 不写 `migration_logs` 正式迁移记录。
3. 不写 `migration_status=migrated`。
4. 不删除或修改 localStorage 旧数据。
5. 不替换 `ConfigStore` / `JobStore`。
6. 不改 Vue 页面。
7. 不做备份恢复 UI。
8. 不 push 远程。

## 3. 架构

T4 采用：

```txt
前端纯函数收集 localStorage snapshot
  ↓
生成 JSON backup payload
  ↓
Tauri command 接收 payload_json
  ↓
Rust 写入 backups 目录
  ↓
Rust 生成 checksum
  ↓
Rust 写入 backup_logs
```

原因：

1. Rust / Tauri 后端不能直接可靠读取 WebView 的 localStorage。
2. localStorage 读取必须发生在前端 JS/TS 侧。
3. 文件写入和 SQLite `backup_logs` 记录由 Rust/Tauri 侧负责。
4. 当前阶段只做 dev smoke，不接正式 UI。

## 4. 前端 payload 纯函数

新增：

```txt
src/app/legacyLocalStorageBackup.ts
```

核心函数：

```ts
createLegacyLocalStorageBackupPayload(driver, options?)
```

说明：

1. 只依赖传入的 `StorageDriver` 子集：`keys()` 和 `getItem()`。
2. 不读取全局 `localStorage`。
3. 不修改任何 storage key。
4. 不接入页面。
5. 不替换现有 `src/storage` 运行逻辑。

扫描范围：

```txt
offerflow:profile
offerflow:job:*
offerpilot:profile
offerpilot:job:*
```

## 5. Backup JSON 结构

T4 payload 结构：

```json
{
  "backupVersion": 1,
  "createdAt": 1780000000000,
  "source": "localStorage",
  "app": "OfferFlow",
  "namespace": "offerflow+offerpilot",
  "namespaces": ["offerflow", "offerpilot"],
  "profile": {
    "key": "offerflow:profile",
    "namespace": "offerflow",
    "data": {}
  },
  "profiles": [
    {
      "key": "offerflow:profile",
      "namespace": "offerflow",
      "data": {}
    }
  ],
  "jobs": [
    {
      "key": "offerflow:job:xxx",
      "namespace": "offerflow",
      "id": "xxx",
      "data": {}
    }
  ],
  "rawEntries": [
    {
      "key": "offerflow:job:xxx",
      "value": "{...}"
    }
  ],
  "counts": {
    "profiles": 1,
    "jobs": 20,
    "rawEntries": 21,
    "parseErrors": 0
  },
  "warnings": [],
  "checksum": null
}
```

说明：

1. `profile` 是首选 profile：优先 `offerflow:profile`，没有时使用 `offerpilot:profile`。
2. `profiles` 保留当前和旧命名空间中所有 parse 成功的 profile，避免双命名空间数据丢失。
3. `rawEntries` 保存所有匹配 key 的原始字符串，包括坏 JSON。
4. 前端生成 payload 时 `checksum=null`，最终 checksum 由 Rust 写文件侧生成并写回备份文件。

## 6. 坏数据策略

T4 不修复坏数据，只保证不丢原文：

1. JSON parse 成功的 profile/job 进入 `profile` / `profiles` / `jobs`。
2. JSON parse 失败的 entry 不进入结构化字段。
3. JSON parse 失败的 entry 仍完整保存在 `rawEntries`。
4. `warnings` 记录坏数据 key 和错误摘要。
5. `counts.parseErrors` 记录 parse 失败数量。

## 7. Rust 写入与 checksum

新增：

```txt
src-tauri/src/sqlite/backup.rs
```

职责：

1. 接收 `payload_json`。
2. 解析 JSON。
3. 写入 app data 下的 `backups/` 目录。
4. 生成文件名。
5. 生成 checksum。
6. 写入 `backup_logs`。
7. 返回 path / size / checksum / log id。

T4 为正式备份校验新增轻量 Rust 依赖 `sha2`。Checksum 由 Rust 写入侧统一生成，格式：

```txt
sha256:<64位hex>
```

Checksum 计算来源：

```txt
把 payload 中 checksum 置为 null 后序列化，计算 SHA-256。
```

最终写入备份文件时，Rust 会把计算结果写回 `checksum` 字段。

## 8. 备份目录与文件名

T4 使用 Tauri app data 目录：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\
```

文件名格式：

```txt
offerflow-localstorage-backup-YYYYMMDD-HHmmss.json
```

T4 dev smoke 实际文件：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-050113.json
```

## 9. backup_logs 记录

写入成功后记录：

```txt
backup_type = localstorage_json
status = succeeded
path = <backup json path>
profile_count = <counts.profiles>
job_count = <counts.jobs>
size_bytes = <file size>
checksum = <Rust generated checksum>
created_at = <unix seconds>
finished_at = <unix seconds>
data_json = {"fileName": "...", "rawEntryCount": n, "checksumAlgorithm": "sha256-json-null-checksum"}
```

T4 dev smoke 记录摘要：

```txt
backup_log_id=localstorage-json-1782709273-3d2e119d1232a6eb6423c8533661591af336849b0db7ad51418b6dbe039b3fca
backup_type=localstorage_json
status=succeeded
profile_count=1
job_count=1
raw_entries=2
checksum=sha256:3d2e119d1232a6eb6423c8533661591af336849b0db7ad51418b6dbe039b3fca
size_bytes=1306
```

失败策略：

1. 写文件失败时，尽量写入 `backup_logs.status=failed`。
2. 如果数据库也不可写，返回错误，不伪装成功。
3. T4 不写 `migration_logs`。

## 10. 验证结果

已运行：

```txt
npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts
npm.cmd run typecheck
npm.cmd run build
cargo check
cargo test
npm.cmd exec tauri -- dev
```

结果：

```txt
localStorage backup selftest => 通过，11 passed, 0 failed
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 通过，5 passed
npm.cmd exec tauri -- dev => 通过，T3 repository smoke 与 T4 backup smoke 均输出成功日志
```

备份文件读回检查：

```txt
Exists=True
BackupVersion=1
Source=localStorage
Profiles=1
Jobs=1
RawEntries=2
Checksum=sha256:3d2e119d1232a6eb6423c8533661591af336849b0db7ad51418b6dbe039b3fca
Warnings=0
```

## 11. 后续建议

建议进入 T5：localStorage -> SQLite 迁移。

T5 前提：

1. 用户验收 T4。
2. T5 必须先读取 T4 backup payload。
3. T5 迁移失败不得破坏旧 localStorage。
4. T5 成功后不得立即删除旧 localStorage。
