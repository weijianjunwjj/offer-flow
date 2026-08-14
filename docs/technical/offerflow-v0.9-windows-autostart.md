# OfferFlow v0.9 — Windows 后台自启动（T031）

> **版本归属：** v0.9（每日岗位猎手，Phase 3 — SearchPlan + Scheduler）
> **任务：** T031 Windows Autostart 管理
> **状态：** 已实现（IMPLEMENTED）。**尚未在本机启用**（NOT ENABLED ON THIS MACHINE）——真实 Enable 需在 production schema migration Gate 与 backup Gate 之后，由用户明确授权。

---

## 1. 机制

自启动使用权威单一机制：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

- 只写入**当前用户**级别，不触碰 HKLM。
- value name 冻结为：`OfferFlowDailyJobHunter`。
- command 只包含两个 token：`"<node.exe>" "<launcher.mjs 绝对路径>"`，**绝不包含任何 secret / API Key / Provider 凭据**。

## 2. 启动时机

- **Windows 用户登录后**启动（Run 键语义）。
- **不是** boot-before-login（无需系统服务 / Task Scheduler / 管理员权限）。

## 3. 启动链（架构冻结）

```text
HKCU Run
  → node.exe
  → scripts/autostart/offerflowAutostartLauncher.mjs
  → process.chdir(repoRoot)（从自身 import.meta.url 解析，不依赖调用时 cwd）
  → 设置 non-secret flags
  → 用 process.execPath + tsx CLI entry 启动 server/index.ts
  → stdout/stderr 落日志
```

- **默认只启动 backend**，不启动 Vite dev server / HMR / 浏览器 / 第二个 daemon。
- 不依赖 shell / npm shell quoting / `.cmd` shim；不经过 CMD / PowerShell。
- **不做** crash supervisor、无限 restart loop。backend 崩溃 → 写退出日志 → launcher 退出；下次由用户重新登录或人工启动，Scheduler startup CATCH_UP 补齐当天合法 missed run。

## 4. Feature flags

launcher 同时开启两个 non-secret flags（后台仍是同一份 backend process）：

| Flag | 值 | 作用 |
|---|---|---|
| `OFFERFLOW_DAILY_JOB_SCHEDULER` | `true` | 自动调度运行 |
| `OFFERFLOW_DAILY_SEARCH_PLAN` | `true` | 暴露 Plan Control / DailyBrief / SourceRun 观测 API |

## 5. 凭据来源（已确认可靠）

- `server/index.ts` 启动即调用 `loadProjectEnv()`，按仓库根 `.env` → `.env.local` 顺序加载环境文件（真实 `process.env` 最高优先）；真实 secret 推荐写入仓库根 `.env.local`，不读取 `server/.env`。
- Tavily API Key（`TAVILY_API_KEY`）与 DeepSeek（`OFFERFLOW_LLM_API_KEY` / `DEEPSEEK_API_KEY` 等）均从 `process.env` 读取。
- launcher 保留父进程已有 credential env，叠加 non-secret flags；**绝不把 secret 写入 Registry command / launcher source / 日志**。

## 6. 日志

- 目录：`logs/autostart/`（已由 `.gitignore` 忽略）。
- 文件名：`offerflow-autostart-YYYY-MM-DD.log`。
- 记录：launcher start timestamp、repo root、node 版本路径、backend entry、flags、backend PID、backend stdout / stderr、退出码 / 信号。
- **不记录**：environment、API Key、Authorization header。

## 7. 操作命令

| 命令 | 作用 | 副作用 |
|---|---|---|
| `npm run autostart:enable` | 写入 HKCU Run（用当前 repo + node path 覆盖） | **修改 OS 持久配置**（需前置 Gate） |
| `npm run autostart:disable` | 只删除 `OfferFlowDailyJobHunter` value（幂等） | 修改 OS 持久配置 |
| `npm run autostart:status` | 只读探测：enabled / disabled + current command + STALE | 无 |

`status` 若 Registry 指向旧 repo path（repo 移动后）会输出 `STALE`，**不会偷偷修改**；需要时由用户显式 `enable` 覆盖为当前路径。

## 8. Schema 安全

- Autostart **绝不自动迁移** production DB。
- `server/index.ts` 对真实生产库 `allowAutoMigrate=false`：schema 低于所需版本 → 启动拒绝（`schemaRefusalMessage`）→ 该错误落入日志，供排障。
- 不绕过 `allowAutoMigrate=false`。

## 9. 启用前置 Gate（重要）

**第一次运行 `npm run autostart:enable` 之前，必须满足：**

1. production schema migration Gate **PASS**（真实生产库已安全升级到所需 schema 版本）；
2. backup / restore Gate **PASS**（生产库备份与恢复已验证）。

在二者通过前，不要启用自启动。
