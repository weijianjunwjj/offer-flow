# OfferFlow v0.4 T9 桌面模式最小迁移确认入口

## 1. 背景

T8 已经提供受控 SQLite backend 启用机制，但仍缺少用户可见的确认入口。T9 的目标是在不自动迁移、不默认切 SQLite、不删除旧 localStorage 的前提下，给桌面端用户一个最小可用的迁移面板。

本轮只新增最小 UI 入口，不做完整设置中心，不做恢复 UI，不改现有岗位页面业务流程。

## 2. UI 入口位置

新增组件：

```txt
src/components/StorageMigrationPanel.vue
```

挂载位置：

```txt
src/pages/ProfileConfigPage.vue
```

入口放在现有“简历 / 偏好配置”页底部，避免新增路由或大改导航。

## 3. 展示状态

面板展示：

1. 当前运行环境：Web 浏览器模式 / Tauri 桌面模式。
2. 当前 active backend：localStorage / SQLite。
3. backend 标记：`offerflow:storage:backend` 当前偏好。
4. SQLite 状态：不可用 / 可用未迁移 / 需要迁移 / 上次失败 / 已迁移待启用 / 已启用。
5. localStorage 数据概览：profile 是否存在、job 数量、raw entry 数量、warning 数量。
6. 状态说明：来自 T8 `resolveStorageBackend()` 的 reason。

## 4. 用户确认迁移流程

按钮：

```txt
检查本地存储状态
备份并迁移到 SQLite
```

Web 浏览器模式不显示可执行迁移按钮，只显示说明。

Tauri 桌面模式点击迁移按钮后，仍需要二次确认。确认文案说明：

```txt
OfferFlow 会先生成一份 localStorage JSON 备份，再把数据写入本机 SQLite 文件。旧 localStorage 数据不会删除，可作为兜底。
```

确认后调用 T8：

```txt
runControlledLocalStorageToSqliteMigration()
```

流程仍是：

```txt
生成 localStorage JSON 备份
  ↓
写入备份文件
  ↓
生成 migration payload
  ↓
写入 SQLite
  ↓
写 done 标记
  ↓
写 offerflow:storage:backend=sqlite
```

只有受控迁移成功并且 done 标记写入成功后，才允许 backend preference 写为 SQLite。

## 5. 失败 / 回退展示策略

备份失败：

1. 展示错误摘要。
2. 不执行 SQLite migration。
3. 不写 `backend=sqlite`。
4. 不删除 localStorage。

迁移失败：

1. 展示错误摘要。
2. active backend 仍为 localStorage。
3. 不写 `backend=sqlite`。
4. 不删除 localStorage。

already_migrated：

1. 不重复备份。
2. 不重复迁移。
3. 允许按 T8 逻辑写 done 标记和 backend preference。

done 标记失败：

1. 展示半成功状态。
2. 说明 SQLite 数据库迁移已成功，但 legacy done 标记失败。
3. 不写 `backend=sqlite`。
4. 不删除 localStorage。

## 6. UI 状态辅助

新增纯函数模块：

```txt
src/app/storageMigrationUiState.ts
```

职责：

1. 读取 localStorage 概览。
2. 判断 Web / Tauri 下是否展示可执行迁移动作。
3. 映射 runtime / backend / SQLite 状态文案。
4. 将受控迁移结果整理为 UI 可展示摘要。

该模块不直接调用 Tauri command，不执行迁移。

## 7. 自测覆盖

新增：

```txt
scripts/storageMigrationPanel.selftest.ts
```

覆盖：

1. Web 模式不会展示可执行 SQLite 迁移动作。
2. Tauri 模式才允许展示迁移动作。
3. busy 状态不能重复触发迁移。
4. localStorage overview 能统计 profile / jobs / raw entries。
5. 迁移成功结果能展示 backup 路径、migration id、job 数量。
6. 迁移失败结果能展示错误码，并保持 localStorage fallback。

## 8. 验证结果

已运行：

```txt
npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts
npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts
npm.cmd exec tsx -- scripts/storageAdapter.selftest.ts
npm.cmd exec tsx -- scripts/backendSwitch.selftest.ts
npm.cmd exec tsx -- scripts/storageMigrationPanel.selftest.ts
npm.cmd run typecheck
npm.cmd run build
cargo check
cargo test
```

结果：

```txt
localStorageBackup.selftest => 11 passed, 0 failed
localStorageMigration.selftest => 21 passed, 0 failed
storageAdapter.selftest => 14 passed, 0 failed
backendSwitch.selftest => 22 passed, 0 failed
storageMigrationPanel.selftest => 18 passed, 0 failed
npm.cmd run typecheck => 通过
npm.cmd run build => 通过，保留既有 chunk size warning
cargo check => 通过
cargo test => 13 passed, 0 failed
```

未重跑：

```txt
npm.cmd exec tauri -- dev
```

原因：本轮提交 T8 前已按要求尝试补跑该命令，命令在 120 秒内未自然结束，并留下 npm / tauri / vite / esbuild 进程，已清理。为避免重复留下后台进程，T9 未再次强行运行；桌面端真实 smoke 仍需在可交互环境中手动补跑。

## 9. 边界确认

T9 未做：

1. 自动迁移。
2. 默认强制切 SQLite。
3. 删除 localStorage。
4. 恢复 UI。
5. 新增路由。
6. 引入新的 UI 框架。
7. 云同步 / AI API / 账号 / Boss 自动化。

## 10. 后续建议

T9 验收通过后，建议进入 T10：真实桌面端端到端验收与 release 文档收口。
