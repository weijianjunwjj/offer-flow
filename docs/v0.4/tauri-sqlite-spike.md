# OfferFlow v0.4 T1 Tauri + SQLite 技术 Spike

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

## 2. 前置检查结果

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

## 8. 是否建议进入 T2

不建议直接进入 T2：storage adapter 设计。

理由：

1. T1 的关键验收项“Tauri 能启动、SQLite 能读写”尚未通过。
2. 未确认实际数据库路径、插件可用性和 Windows 编译环境。
3. 直接进入 adapter 设计会把未验证的运行时假设带入正式架构。

建议先补齐本机前置环境并重跑 T1。
