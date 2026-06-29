# OfferFlow v0.4 T10 桌面端端到端验收

## 1. 验收目标

T10 用于收口 v0.4 本地服务化与 SQLite 数据文件化改造，重点验证：

1. Tauri 桌面运行时可以启动。
2. SQLite app data 目录可以写入。
3. localStorage JSON 备份可以生成。
4. localStorage -> SQLite migration smoke 可以成功。
5. backend 受控切换和迁移确认 UI 不会自动迁移或删除旧数据。
6. Web 模式仍然保持 localStorage。

T10 不新增大功能，不改变迁移策略，不删除 localStorage，不做云同步 / AI API / 账号 / Boss 自动化。

## 2. 本轮真实桌面运行结果

执行命令：

```bash
npm.cmd exec tauri -- dev
```

在当前 Codex 沙箱中，Tauri 写入 `%APPDATA%/com.offerflow.local` 需要提升权限。未提升权限运行时，SQLite smoke 会被沙箱拦截并报 `attempt to write a readonly database` 或 `unable to open database file`。提升权限后，命令级 desktop smoke 成功写入 AppData，但提升后的 GUI 窗口没有暴露到当前可枚举的交互桌面，因此 Codex 无法完成全部可见窗口点击验收。

已确认的命令级 desktop smoke 输出：

```txt
[OfferFlow T3 SQLite Repository] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3 schema_version=1 profile_id=default job_id=t3-smoke-job-new listed_jobs=t3-smoke-job-new,t3-smoke-job-old remaining_jobs=2
[OfferFlow T4 LocalStorage Backup] backup_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-111022.json checksum=sha256:95014789e5fe7ca7a7929a7467e67522e4b8c81b6c6fe536afc81a6445136b97 size_bytes=1353 profile_count=1 job_count=1 raw_entries=2 backup_log_id=localstorage-json-1782731422-95014789e5fe7ca7a7929a7467e67522e4b8c81b6c6fe536afc81a6445136b97
[OfferFlow T5 LocalStorage Migration] migration_id=localstorage-to-sqlite-1782731422000-0000000000000000000000000000000000000000000000000000000000000001 status=succeeded profile_count=1 job_count=2 backup_checksum=sha256:0000000000000000000000000000000000000000000000000000000000000001 migration_status=migrated
[OfferFlow T7 SQLite Adapter] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t7-adapter-smoke-1782731422000.sqlite3 profile_target_city=Suzhou created_job_id=t7-smoke-job-new listed_jobs=t7-smoke-job-new,t7-smoke-job-old updated_match_score=91 patch_preserved_ai_raw=true deleted_job_missing=true
```

## 3. 文件路径

SQLite 数据库文件：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3
```

迁移前备份文件：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-111022.json
```

说明：当前基础 repository 和正式 adapter 共用 `offerflow-t3.sqlite3` 作为 app data 下的 SQLite 文件名，这是 T3-T10 既有实现结果。后续如需改为 `offerflow.sqlite3`，应单独立项并设计兼容迁移，不在 T10 顺手改名。

## 4. 桌面 UI 检查项

已通过代码与 selftest 覆盖：

1. Web 模式不显示可执行 SQLite 迁移按钮。
2. Tauri 模式才允许展示迁移按钮。
3. 用户点击迁移按钮后需要 `window.confirm` 二次确认。
4. 取消确认时不会执行迁移。
5. 迁移成功后才写 `offerflow:storage:backend=sqlite`。
6. 失败 / done 标记失败 / already_migrated 均不会删除 localStorage。

本轮真实可见窗口检查受限：

1. 未提升权限时，窗口可进入当前交互桌面，但 AppData 写入被沙箱拦截。
2. 提升权限时，AppData 写入和 Tauri smoke 成功，但 GUI 窗口未暴露到当前可枚举桌面。
3. 因此 Codex 本轮不能诚实声称已手动点击完迁移面板。

## 5. T10 小修

真实桌面检查过程中发现 App 顶部导航在 Tauri WebView 窄宽度下可能被品牌说明挤出可视区域。T10 小幅调整 `src/App.vue`：

1. 品牌说明文本改为单行截断。
2. 顶部导航按钮改为固定右侧 flex 容器。
3. 移除不必要的 `NSpace` 包裹，避免 header flex 场景下按钮区域不稳定。

该修复不改路由、不改业务页面流程、不改迁移逻辑。

## 6. 补充手动验收清单

用户在本机可见桌面窗口中补验时，建议按以下顺序：

1. 运行 `npm.cmd exec tauri -- dev`。
2. 确认应用窗口可见。
3. 进入配置页底部，确认能看到“本地数据存储”面板。
4. 点击“检查本地存储状态”。
5. 确认运行环境显示为 Tauri 桌面模式。
6. 确认 localStorage profile / jobs 数量显示正确。
7. 点击“备份并迁移到 SQLite”，先取消二次确认，确认不迁移。
8. 再次点击并确认迁移。
9. 确认展示 backup 路径、migration id、profile/job 数量和 backend 切换结果。
10. 重启 Tauri 应用，确认 SQLite backend 仍可识别。
11. 确认旧 localStorage profile/job key 仍保留。
12. 再次迁移时确认进入 already_migrated 或明确阻止重复迁移。
13. 在 Web 浏览器模式确认仍走 localStorage，且不显示可执行迁移按钮。

## 7. 接力复跑结果（Claude Code，2026-06-29）

Codex token 用完后，由 Claude Code 接力复跑 T10 验收，结果如下。

自动验证（全部通过，与 Codex 记录一致）：

```txt
localStorageBackup.selftest      => 11 passed, 0 failed
localStorageMigration.selftest   => 21 passed, 0 failed
storageAdapter.selftest          => 14 passed, 0 failed
backendSwitch.selftest           => 22 passed, 0 failed
storageMigrationPanel.selftest   => 18 passed, 0 failed
npm run typecheck                => passed
npm run build                    => passed（保留既有 chunk size warning）
cargo check                      => passed
cargo test                       => 13 passed, 0 failed
```

Tauri dev 实际启动结果：

1. `npm.cmd exec tauri -- dev` 在本接力环境（Claude Code，本机 Console 会话）成功启动：Vite dev server 起在 `http://127.0.0.1:5175/`，cargo 构建完成并运行 `target\debug\app.exe`，`app.exe` 进程实际存活于 Console 会话。
2. 与 Codex 沙箱不同，本环境**未额外提权**即可写入 `%APPDATA%/com.offerflow.local`。启动期 desktop SQLite smoke（T3/T4/T5/T7）全部成功并真实落盘：
   - SQLite：`C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3`（69632 bytes）
   - backup：`C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-113643.json`
   - migration_id：`localstorage-to-sqlite-1782733003000-0000000000000000000000000000000000000000000000000000000000000001`，`migration_status=migrated`，`profile_count=1`，`job_count=2`
3. 上述写入均为**应用启动期 smoke fixture**自动产生，**不是**人工点击迁移面板的结果。

可见窗口人工点击验收：**仍未完成**。

1. 尝试用 computer-use 申请控制 OfferFlow 窗口（`request_access`）以自动点击迁移面板，授权对话框 300s 超时未获批准，判断当前无人在场点击。
2. 因此 Claude Code 本轮**不能**诚实声称已完成可见窗口的人工点击验收。
3. 复跑结束后已停止本接力启动的 `app.exe`，释放 5175 端口；用户补验时请在本机交互终端重新运行 `tauri dev`。

结论：命令级与启动期 smoke 在本接力环境真实落盘成功（且无需提权），但第 6 节的可见窗口点击清单仍需用户在本机交互桌面亲自补跑一次。

## 8. 当前结论

命令级 Tauri + SQLite + backup + migration + adapter smoke 已通过，并在 Claude Code 接力环境中真实落盘复现成功。可见桌面窗口的人工点击项至今未由任何自动化代理完成，需用户在本机交互窗口中亲自补验一次后，再进入 v0.4.0 tag / push 更稳妥。
