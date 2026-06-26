# OfferFlow v0.4 本地服务化与 SQLite 数据文件化方案

## 1. 背景

OfferFlow v0.1 - v0.3 一直采用纯浏览器形态，数据通过 `src/storage` 的 driver 抽象写入浏览器 `localStorage`。当前已持久化的数据包括：

1. 全局配置 `JobSeekerProfile`
2. 岗位记录 `JobRecord`
3. AI 原文 `aiRawResult`
4. 解析状态、报告字段、机会雷达与公司画像
5. 8 态 `communicationStatus`
6. v0.3 跟进事实字段：`lastGreetedAt`、`followupCount`、`lastFollowupAt`、`lastCommunicationNote`、`highValueSignal`、`strategyOverride`、`draftMessageText`

`localStorage` 已经不适合作为长期求职数据仓库：容量有限，缺少稳定备份、恢复、迁移、校验和文件级可见性。用户已经拍板 v0.4 一步到位，引入本地运行时 / 本地服务与 SQLite 本地数据库文件。

## 2. 目标与非目标

### 2.1 目标

1. 将 OfferFlow 数据从浏览器 `localStorage` 升级到 SQLite 本地数据库文件。
2. 保留本地优先，不依赖远程服务。
3. 支持迁移前自动 JSON 备份。
4. 支持迁移后数据完整性校验。
5. 迁移成功后保留旧 `localStorage` 数据作为只读兜底，不立即删除。
6. 为后续备份、恢复、迁移和 schema version 管理建立基础。

### 2.2 非目标

v0.4 不做以下事项：

1. 不接 AI API
2. 不做 BYOK
3. 不做云同步
4. 不做账号登录
5. 不做多端同步
6. 不自动投递
7. 不自动操作 Boss
8. 不做爬虫
9. 不做浏览器插件
10. 不做 SaaS 后台
11. 不接远程数据库
12. 不借 SQLite 改造新增 CRM、公司库、联系人库、完整沟通日志或提醒系统

## 3. 推荐架构

```txt
Vue3 前端界面
  ↓
Storage API 适配层
  ↓
Tauri Command / 本地服务层
  ↓
SQLite 数据库文件
```

说明：

1. Vue3 页面继续只消费应用层 store / storage API，不直接拼 SQL。
2. Storage API 适配层负责保持现有 `ConfigStore` / `JobStore` 的业务语义，逐步把底层从 `localStorage` driver 切换为本地服务调用。
3. Tauri Command / 本地服务层负责文件路径、SQLite 连接、事务、备份、迁移和错误返回。
4. SQLite 数据库文件成为真实数据资产，用户可以备份和迁移。

## 4. 为什么选择 Tauri + SQLite

1. Tauri 适合承载现有 Vue3 + Vite + TypeScript 前端，迁移成本低。
2. Tauri 比 Electron 更轻量，打包体积和资源占用更适合个人本地工具。
3. SQLite 是成熟的本地单文件数据库，适合长期保存、备份、恢复和迁移。
4. SQLite 支持事务，适合做“备份 -> 建 schema -> 迁移 -> 校验 -> 写日志”的安全流程。
5. 本地运行时可以访问用户本机文件系统，能提供比浏览器 `localStorage` 更明确的数据文件位置。

## 5. 为什么暂不选择其他方案

### 5.1 IndexedDB

IndexedDB 容量和结构化能力优于 `localStorage`，但仍受浏览器沙箱管理。它适合浏览器离线应用，不适合本次“明确本地 db 文件、可备份、可恢复、可迁移”的目标。

### 5.2 OPFS

OPFS 可以在浏览器沙箱内管理文件，但文件可见性、备份路径、恢复体验和跨环境迁移仍不如 SQLite 本地文件直观。它可以作为纯浏览器备选，不作为 v0.4 优先路线。

### 5.3 Electron

Electron + SQLite 能实现目标，但体积和资源占用更高。除非 Tauri 在开发、打包、插件稳定性或系统兼容性上出现阻塞，否则不优先选择 Electron。

### 5.4 云后端 / 远程数据库

云后端会引入账号、网络、安全、同步、费用和运维问题，直接推翻本地优先边界。v0.4 明确不做云同步、不做 SaaS、不接远程数据库。

## 6. 数据库文件建议位置

优先使用 Tauri 的 app data 目录，数据库文件名建议为：

```txt
offerflow.sqlite3
```

建议位置：

1. Windows：`%APPDATA%/OfferFlow/offerflow.sqlite3`
2. macOS：`~/Library/Application Support/OfferFlow/offerflow.sqlite3`
3. Linux：`~/.local/share/OfferFlow/offerflow.sqlite3`

备份文件建议放在同级 `backups/` 目录：

```txt
backups/
  offerflow-localstorage-backup-YYYYMMDD-HHmmss.json
  offerflow-db-backup-YYYYMMDD-HHmmss.sqlite3
```

## 7. SQLite 数据模型草案

原则：不要过度拆表。v0.4 采用“核心索引字段独立列 + 完整对象 `data_json`”。

这样做的目的：

1. 列表、筛选、排序常用字段可以直接建列。
2. 现有 `JobRecord` 完整对象保存在 `data_json`，避免迁移时丢字段。
3. v0.3 新增事实字段天然兼容，不需要为所有嵌套结构拆表。
4. 后续 schema 可以小步演进。

### 7.1 `app_meta`

用途：保存全局元信息、schema version 和迁移状态。

建议字段：

```txt
key TEXT PRIMARY KEY
value TEXT NOT NULL
updated_at INTEGER NOT NULL
```

建议 key：

1. `schema_version`
2. `app_version`
3. `db_created_at`
4. `migration_status`
5. `last_successful_migration_id`
6. `last_backup_at`
7. `legacy_localstorage_migrated_at`

同时可以使用 SQLite `PRAGMA user_version` 记录数字型 schema version；`app_meta.schema_version` 用于应用层可读展示。

### 7.2 `profiles`

用途：保存全局配置。当前仍只允许一份 profile。

建议字段：

```txt
id TEXT PRIMARY KEY              -- 固定为 default
target_city TEXT
target_role TEXT
expected_salary TEXT
updated_at INTEGER NOT NULL
data_json TEXT NOT NULL
```

独立列：

1. `target_city`
2. `target_role`
3. `expected_salary`
4. `updated_at`

`data_json` 保存完整 `JobSeekerProfile`，包括 `resumeText`、`projectExperience`、`acceptOutsourcing`、`acceptOvertime`、`jobSearchFocus`、`weaknessNote` 等全部字段。

### 7.3 `jobs`

用途：保存岗位记录。

建议字段：

```txt
id TEXT PRIMARY KEY
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
company TEXT NOT NULL DEFAULT ''
role TEXT NOT NULL DEFAULT ''
city TEXT NOT NULL DEFAULT ''
salary_range TEXT NOT NULL DEFAULT ''
communication_status TEXT NOT NULL DEFAULT 'not_contacted'
parse_status TEXT NOT NULL DEFAULT 'none'
ai_pasted_at INTEGER
match_score TEXT NOT NULL DEFAULT ''
opportunity_score INTEGER
apply_advice TEXT
risk_level TEXT
company_size_tier TEXT
last_greeted_at INTEGER
followup_count INTEGER NOT NULL DEFAULT 0
last_followup_at INTEGER
high_value_signal INTEGER NOT NULL DEFAULT 0
data_json TEXT NOT NULL
```

独立列用于列表、筛选、排序：

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

`data_json` 保存完整 `JobRecord`，包括：

1. 基础信息：`jdText`
2. 生成产物：`promptText`
3. AI 原文：`aiRawResult`
4. 报告：`report`
5. v0.2 数据：`companyInput`、`companyAssessment`、`opportunityAnalysis`
6. v0.3 跟进事实：`lastCommunicationNote`、`strategyOverride`、`draftMessageText`
7. 未来兼容字段

兼容要求：

1. `communicationStatus` 继续沿用 v0.3 的 8 态。
2. `followupCount` 缺省为 `0`。
3. `highValueSignal` 在 SQLite 列中用 `0 / 1`，在 `data_json` 中保持 boolean。
4. 不持久化 `strategy`、`nextAction`、`stopLoss`、`scenario`、`companyWarning` 等派生结果。

### 7.4 `migration_logs`

用途：记录 localStorage -> SQLite 和未来 schema migration 的执行历史。

建议字段：

```txt
id TEXT PRIMARY KEY
type TEXT NOT NULL                 -- localstorage_to_sqlite / schema_upgrade
status TEXT NOT NULL               -- pending / running / succeeded / failed
from_version TEXT
to_version TEXT
started_at INTEGER NOT NULL
finished_at INTEGER
backup_path TEXT
profile_count_before INTEGER
job_count_before INTEGER
profile_count_after INTEGER
job_count_after INTEGER
checksum_before TEXT
checksum_after TEXT
error_message TEXT
data_json TEXT
```

`data_json` 保存本次迁移的详细摘要，例如迁移 key 列表、跳过原因、校验项结果等。

### 7.5 `backup_logs`

用途：记录自动备份和手动导出历史。

建议字段：

```txt
id TEXT PRIMARY KEY
type TEXT NOT NULL                 -- pre_migration_json / manual_json / db_copy
status TEXT NOT NULL               -- succeeded / failed
created_at INTEGER NOT NULL
path TEXT NOT NULL
profile_count INTEGER
job_count INTEGER
size_bytes INTEGER
checksum TEXT
error_message TEXT
data_json TEXT
```

## 8. 备份策略

### 8.1 自动备份

迁移前必须自动生成 JSON 备份。备份内容至少包含：

1. `exportedAt`
2. `source`
3. `schemaVersion`
4. `profile`
5. `jobs`
6. 原始 localStorage keys 与 value
7. 校验摘要，例如 profile 数量、job 数量、关键字段 checksum

备份成功后写入 `backup_logs`。

### 8.2 手动导出

后续实现必须提供手动导出 JSON 备份入口。手动导出不等同于迁移，但使用同一份导出结构，便于恢复和问题排查。

### 8.3 数据库文件备份

SQLite 迁移成功后，可再生成一份数据库文件副本备份。数据库文件备份属于增强项，但不替代迁移前 JSON 备份。

## 9. localStorage 到 SQLite 的迁移流程

标准流程：

```txt
检测旧 localStorage 数据
  ↓
生成迁移前 JSON 备份
  ↓
创建 SQLite schema
  ↓
逐条迁移 profile / jobs / AI 原文 / report / 沟通状态 / v0.3 跟进事实字段
  ↓
校验迁移前后数量和关键字段
  ↓
写入 migration_logs
  ↓
标记迁移完成
  ↓
保留旧 localStorage 数据作为只读兜底
```

详细要求：

1. 检测 `offerflow:profile`、`offerflow:job:*`，并兼容旧 namespace `offerpilot:*`。
2. 迁移前先将原始 localStorage 数据完整写入 JSON 备份。
3. schema 创建必须在 SQLite 事务中完成。
4. profile 迁移到 `profiles`，完整对象写入 `data_json`。
5. jobs 逐条迁移到 `jobs`，完整 `JobRecord` 写入 `data_json`，常用字段同步写入独立列。
6. AI 原文 `aiRawResult`、`report`、`companyAssessment`、`opportunityAnalysis`、`communicationStatus` 和 v0.3 跟进事实字段必须保留。
7. 对旧记录继续使用现有默认值策略：缺失 `companyInput`、`companyAssessment`、`opportunityAnalysis`、`communicationStatus`、`followupCount` 时按现有读取规则补齐。
8. 校验至少包括 profile 数量、job 数量、每条 job 的 `id` / `company` / `role` / `updatedAt` / `communicationStatus` / `aiRawResult` 长度。
9. 迁移成功后写入 `migration_logs.status=succeeded`，并在 `app_meta` 写入 `migration_status=migrated`。
10. 迁移成功后只写 localStorage 标记，例如 `offerflow:migration:sqlite:v0.4=done`，不得删除旧数据。

## 10. 失败回滚策略

1. 任何迁移失败都不能破坏旧 `localStorage` 数据。
2. 如果备份失败，必须停止迁移，不得创建或写入业务数据。
3. 如果 schema 创建失败，记录失败原因，不写 `migration_status=migrated`。
4. 如果中途写入失败，SQLite 事务回滚；保留迁移前 JSON 备份。
5. 如果校验失败，迁移状态记为 `failed`，应用继续使用旧 localStorage 只读兜底或提示用户恢复。
6. 迁移失败不得自动重试覆盖已有备份；下一次迁移应生成新的备份和新的 `migration_logs` 记录。

## 11. 验收标准

1. 首次启动能检测旧 localStorage 数据。
2. 迁移前能自动生成 JSON 备份。
3. SQLite schema 能创建成功并记录 schema version。
4. profile 能迁移并读回。
5. jobs 能逐条迁移并读回。
6. AI 原文、report、机会雷达、8 态沟通状态和 v0.3 跟进事实字段不丢。
7. 迁移前后 job 数量一致。
8. 迁移后关键字段校验通过。
9. `migration_logs` 和 `backup_logs` 有记录。
10. 迁移成功后旧 localStorage 数据仍保留。
11. 迁移失败时旧数据可继续作为兜底来源。
12. 有自测覆盖迁移成功、备份失败、校验失败、坏数据跳过或报错路径。

## 12. 风险清单

1. Tauri 与 SQLite 插件的开发环境、打包和跨平台兼容性需要验证。
2. SQLite 文件路径和权限在不同系统上可能不同。
3. 迁移期间如果只写部分数据，会导致双源不一致；必须用事务和 migration status 控制。
4. `data_json` 与独立列可能不一致；写入时必须由同一适配层统一派生。
5. 旧 localStorage 中可能存在坏数据；迁移策略需要明确是阻断、跳过还是保留到错误日志。
6. 数据库文件损坏时需要恢复策略；v0.4 至少要保证 JSON 备份可用。
7. 本地服务化容易诱发范围膨胀，必须继续禁止 AI API、云同步、账号、多端和自动化功能混入。

## 13. 后续任务拆分

建议 v0.4 后续按小任务拆分：

1. T0：方案验收与任务卡细化。
2. T1：Tauri + SQLite 技术 spike，只验证空壳启动、数据库路径和最小读写，不接业务。
3. T2：定义 storage port / adapter 接口，保持页面不直接依赖 Tauri command。
4. T3：实现 SQLite schema 与 app_meta / logs 基础写入。
5. T4：实现 localStorage 导出 JSON 备份。
6. T5：实现 localStorage -> SQLite 迁移命令与事务。
7. T6：实现迁移校验与 migration_logs / backup_logs。
8. T7：把 ConfigStore / JobStore 接到 SQLite adapter。
9. T8：补齐 selftest / migration test / 手动验收脚本。
10. T9：文档与 release note 收口。

每个任务完成后必须更新 `docs/v0.1/progress.md`；涉及技术边界、依赖、schema 或迁移策略变化时必须同步更新 `docs/v0.1/decision-log.md`。

## 14. T1 Spike 结果记录

日期：2026-06-26

结论：T1 未完成 Tauri 启动和 SQLite 最小读写，原因是本机前置环境缺失。

已确认：

1. 当前分支为 `feature/v0.4-local-sqlite-storage`。
2. Node 可用：`node --version => v24.14.1`。
3. `npm.cmd` 可用：`npm.cmd --version => 11.11.0`。
4. PowerShell 中直接运行 `npm` 会触发 `npm.ps1` 执行策略限制，后续应使用 `npm.cmd`。

阻塞项：

1. `rustc` 不存在。
2. `cargo` 不存在。
3. Microsoft C++ Build Tools 的 `cl` 不存在。
4. Visual Studio Installer / `vswhere` 未找到。
5. 当前会话无法运行 `winget`，不能通过 winget 自动补齐前置环境。

本轮未安装 Tauri / SQLite 依赖，未创建 `src-tauri/`，未修改 `package.json`。原因：缺少 Rust 和 C++ 编译工具时继续安装项目依赖只能产生半工作状态，无法完成 Tauri 启动和 SQLite 最小读写验收。

方案选择仍保持：`Tauri v2 + tauri-plugin-sql + SQLite`。后续重跑 T1 前必须先安装 Rust stable toolchain 与 Microsoft C++ Build Tools。

详细记录见：

```txt
docs/v0.4/tauri-sqlite-spike.md
```
