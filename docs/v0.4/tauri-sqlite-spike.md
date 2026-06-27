# OfferFlow v0.4 T1 Tauri + SQLite 技术 Spike

## 0. 最新结论

执行日期：2026-06-27

结论：T1 最小技术 Spike 已通过，等待用户验收。

已验证：

1. 当前 Vue3 + Vite + TypeScript 项目可以引入 Tauri v2。
2. Tauri 开发环境可以启动。
3. Tauri 可以解析应用本地数据目录。
4. 可以在应用本地数据目录创建 SQLite 数据库文件。
5. 可以创建 `app_meta` 表。
6. 可以写入并读回 `schema_version=1`。
7. `npm.cmd run typecheck` 通过。
8. `npm.cmd run build` 通过，现有 Web 端构建未被破坏。
9. `cargo check` 通过。
10. `npm.cmd exec tauri -- info` 通过，并确认 MSVC / Rust / Cargo / WebView2 可用。

本轮仍未做：

1. 未修改 `src/storage/` 业务实现。
2. 未替换 localStorage。
3. 未写 localStorage -> SQLite 正式迁移逻辑。
4. 未改岗位页面、列表页、详情页 UI。
5. 未改业务数据模型字段。
6. 未做备份恢复 UI。
7. 未接 AI API、云同步、账号或自动操作 Boss。

## 0.1 本次实现范围

新增 / 修改：

1. 安装 Tauri v2 必要依赖：
   - `@tauri-apps/api`
   - `@tauri-apps/plugin-sql`
   - `@tauri-apps/cli`
2. 新增 `src-tauri/`。
3. 注册 `tauri-plugin-sql`，并启用 `sqlite` feature。
4. 新增最小 Tauri command：`sqlite_spike_check`。
5. 在 Tauri `setup` 阶段执行一次最小 SQLite 读写验证。
6. 固定 Tauri dev server 为 `http://127.0.0.1:5175`，并启用 `--strictPort`。

T1 的 SQLite 验证文件名为：

```txt
offerflow-spike.sqlite3
```

该文件仅用于 Spike，不是后续正式生产数据库文件名。后续 T2/T3 仍需确认正式数据库文件名和路径策略。

## 0.2 依赖与方案选择

采用：

```txt
Tauri v2 + tauri-plugin-sql + SQLite
```

同时在 Rust 侧引入：

```txt
rusqlite = { version = "0.32", features = ["bundled"] }
```

说明：

1. `tauri-plugin-sql` 已安装和注册，作为后续 storage adapter 访问 SQLite 的候选底座。
2. 本次最小读写在 Tauri `setup` 阶段使用 `rusqlite` 直接执行，目的是绕开 UI 和业务存储层，最小化验证“本地运行时 + app data 路径 + SQLite 文件 + SQL 读写”。
3. `rusqlite` 使用 `bundled` feature，降低本机 SQLite 动态库差异对 Spike 的影响。
4. 页面层没有直接访问 SQL；现有 `src/storage/` 没有改动。

## 0.3 实际数据库路径

Tauri app data 目录解析结果：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local
```

Spike 数据库实际路径：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-spike.sqlite3
```

文件检查结果：

```txt
Test-Path => True
Length => 12288 bytes
```

## 0.4 最小读写结果

执行的最小 schema：

```sql
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

写入：

```sql
INSERT OR REPLACE INTO app_meta (key, value, updated_at)
VALUES ('schema_version', '1', <current_unix_timestamp>);
```

读回：

```sql
SELECT value FROM app_meta WHERE key = 'schema_version';
```

Tauri dev 启动日志：

```txt
[OfferFlow T1 SQLite Spike] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-spike.sqlite3 schema_version=1
```

结论：SQLite 最小读写通过。

## 0.5 验证命令与结果

```txt
node --version
=> v24.14.1

npm.cmd --version
=> 11.11.0

rustc --version
=> rustc 1.96.0 (ac68faa20 2026-05-25)

cargo --version
=> cargo 1.96.0 (30a34c682 2026-05-25)

where.exe rustc
=> C:\Users\Administrator\.cargo\bin\rustc.exe

where.exe cargo
=> C:\Users\Administrator\.cargo\bin\cargo.exe

where.exe cl
=> 普通 PowerShell 中未找到

vswhere
=> C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools

npm.cmd exec tauri -- info
=> 通过；确认 WebView2、MSVC、rustc、cargo、rustup、Tauri 包可用

npm.cmd exec tauri -- dev
=> 通过；Tauri app 启动并输出 schema_version=1

cargo check
=> 通过

npm.cmd run typecheck
=> 通过

npm.cmd run build
=> 通过；保留既有 chunk size warning
```

## 0.6 遇到的问题

1. PowerShell 直接运行 `npm` 会触发 `npm.ps1` 执行策略限制，后续继续使用 `npm.cmd`。
2. Rust / Cargo 安装后，当前 shell 的 PATH 未自动刷新，需要显式加入 `%USERPROFILE%\.cargo\bin`。
3. 普通 PowerShell 中 `where.exe cl` 仍找不到 `cl`，但 `vswhere` 能定位 Build Tools，且 `cargo check` 与 `tauri info` 已确认 MSVC 编译链可用。
4. 首次或依赖变化后的 Tauri dev 编译耗时较长，后续无依赖变化时会更快。
5. 首次运行时 Vite 自动从 5173 退到 5174，可能导致 Tauri `devUrl` 与实际 dev server 不一致；已将 Tauri dev 固定为 `127.0.0.1:5175 --strictPort`。
6. `npm install` 后报告 1 个 low severity vulnerability；本轮未执行 `npm audit fix`，避免引入额外依赖变更。

## 0.7 是否建议进入 T2

建议进入 T2：storage adapter 设计。

理由：

1. Tauri 初始化、启动、Rust 编译链、WebView2 与 MSVC 环境均已通过验证。
2. SQLite 文件路径、文件创建、建表、写入和读回已经通过最小闭环验证。
3. Web 端 `typecheck` 与 `build` 仍通过。
4. T1 未触碰业务 storage 和页面，可以在 T2 专注设计 storage port / adapter 边界。

进入 T2 前仍需用户验收本轮 T1 改动；Codex 不自动提交、不 push、不继续实现。

## 1. 目标

本 Spike 只验证技术可行性，不接业务数据，不迁移 `localStorage`，不修改现有页面业务逻辑。

计划验证项：

1. 当前 Vue3 + Vite + TypeScript 项目能否引入 Tauri。
2. Tauri 开发环境能否启动。
3. 能否获得应用本地数据目录。
4. 能否创建或打开 SQLite 数据库文件。
5. 能否执行最小读写。
6. 能否记录 `schema_version`。
7. 能否保持现有 Web 端 `npm run build` 不被破坏。

## 2. 首轮前置检查结果（历史阻塞记录）

执行日期：2026-06-26

当前分支：

```txt
feature/v0.4-local-sqlite-storage
```

检查命令与结果：

```txt
node --version
=> v24.14.1

npm.cmd --version
=> 11.11.0

npm --version
=> PowerShell 执行策略阻止 npm.ps1；后续命令应使用 npm.cmd。

rustc --version
=> rustc 不存在。

cargo --version
=> cargo 不存在。

where.exe rustc
=> Could not find files for the given pattern(s).

where.exe cargo
=> Could not find files for the given pattern(s).

where.exe cl
=> Could not find files for the given pattern(s).

Visual Studio Installer / vswhere
=> 未找到。

winget --version
=> 当前会话无法运行 winget，错误为“指定的登录会话不存在。可能已被终止。”
```

结论：

Tauri 在当前环境下不能完成初始化、启动或 SQLite 最小读写验证。阻塞点不是项目代码，而是本机缺少 Tauri Windows 开发前置环境：

1. 缺少 Rust toolchain：`rustc` / `cargo`
2. 缺少 Microsoft C++ Build Tools：`cl`
3. 当前会话无法通过 `winget` 安装前置工具

## 3. SQLite 方案选择

推荐方案仍保持：

```txt
Tauri v2 + tauri-plugin-sql + SQLite
```

前端侧预期依赖：

```txt
@tauri-apps/api
@tauri-apps/plugin-sql
@tauri-apps/cli
```

Rust 侧预期依赖：

```txt
tauri
tauri-build
tauri-plugin-sql with sqlite feature
```

选择理由：

1. `tauri-plugin-sql` 是 Tauri 生态内直接面向 SQL 数据库的插件，适合做本地 SQLite 最小读写验证。
2. SQLite 文件可以落在 Tauri app data 目录，符合 v0.4 “本地数据库文件化”的目标。
3. 插件路径可以让前端通过 Tauri command / plugin API 访问本地数据库，页面仍不直接接触 SQL。

本轮没有安装上述依赖。原因是 Rust / C++ 编译工具缺失时安装项目依赖只能得到半工作状态，不能完成 Tauri 启动与 SQLite 读写验收。

## 4. 计划中的最小 SQL 验证

环境补齐后，T1 重跑时应只验证以下最小表和读写：

```sql
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

写入：

```sql
INSERT OR REPLACE INTO app_meta (key, value, updated_at)
VALUES ('schema_version', '1', strftime('%s','now'));
```

读回：

```sql
SELECT value FROM app_meta WHERE key = 'schema_version';
```

只要稳定读回 `1`，SQLite 最小读写即通过。

## 5. 数据库路径

本轮未创建实际数据库文件。

计划路径仍按 v0.4 方案文档执行：

```txt
%APPDATA%/OfferFlow/offerflow.sqlite3
```

环境补齐后，T1 重跑时必须记录 Tauri 实际解析出的 app data 目录和最终数据库绝对路径。

## 6. 本轮没有做的事

本轮没有：

1. 安装 Tauri 依赖
2. 安装 SQLite 依赖
3. 新增 `src-tauri/`
4. 修改 `package.json`
5. 修改 `src/storage/`
6. 修改页面 UI
7. 写 Tauri command
8. 写迁移代码
9. 创建 SQLite 数据库文件

## 7. 后续重试条件

进入 T1 实装前，需要先补齐本机前置环境：

1. 安装 Rust stable toolchain，并确保 `rustc --version` / `cargo --version` 可用。
2. 安装 Microsoft C++ Build Tools，并确保 `cl` 可用，或通过官方推荐方式提供 Tauri Windows 编译环境。
3. 确认 `npm.cmd` 可用于项目依赖安装。

补齐后再执行：

1. 安装 Tauri CLI / API / SQL plugin。
2. 初始化 `src-tauri/`。
3. 新增最小 SQLite command / plugin 调用。
4. 执行 `schema_version` 最小读写。
5. 运行 `npm.cmd run typecheck`、`npm.cmd run build` 和 Tauri 独立检查命令。

## 8. 首轮是否建议进入 T2（历史结论）

不建议直接进入 T2：storage adapter 设计。

理由：

1. T1 的关键验收项“Tauri 能启动、SQLite 能读写”尚未通过。
2. 未确认实际数据库路径、插件可用性和 Windows 编译环境。
3. 直接进入 adapter 设计会把未验证的运行时假设带入正式架构。

建议先补齐本机前置环境并重跑 T1。
