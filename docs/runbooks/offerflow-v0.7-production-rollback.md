# OfferFlow v0.7 生产回滚手册

- 日期：2026-07-16
- 适用：G6-B 真实生产切换失败时的回滚。
- 已在 G6-A 一次性副本上**实际验证**（见 `server/release-promotion/rehearsal.spec.ts` 与 `npm run g6:rehearsal:prepare` 报告）。

## 核心原则

- **正式回滚策略只能是“恢复升级前一致性备份”，绝不对 schema v6 做逆向 migration。**
- 回滚目标：真实库回到切换前的 **schema v4** 状态，字节级一致。

## 前置产物（切换前必须已生成）

- 升级前 v4 一致性备份：`offerflow-v4-pre-upgrade-backup.sqlite3`（G6-A 演练路径：`tmp/g6-rehearsal/`）。
- 升级前备份 SHA-256（切换手册中记录）。

## 回滚步骤

1. **停止正式服务**（确保没有进程持有真实库文件句柄）。
2. **保护现场**：将当前（失败的）真实库改名留存，供事后分析，不要直接删除。
3. **恢复**：将升级前 v4 备份复制回真实库路径 `data/offerflow.sqlite3`。
4. **验证恢复文件**（只读打开）：
   - `schema_version = 4`；
   - `SHA-256` 与升级前备份完全一致；
   - `PRAGMA integrity_check = ok`；
   - `PRAGMA foreign_key_check` 为空；
   - G1~G3 关键表（profiles/jobs/resume_versions/applications/feedback_events/capability_*/historical_*）行数与切换前基线一致。
5. **确认正式入口回到未开启 G4/G5 状态**（代码入口不启用，或回退到切换前版本）。
6. **重启服务**并做最小只读健康检查。

## 演练实证（G6-A）

回滚演练在一次性副本上执行：从升级前 v4 备份恢复出 `offerflow-v4-rollback-restored.sqlite3`，验证 `schema=4`、`restoredSha256 == preUpgradeBackupSha256 == 真实库基线 SHA-256`、`integrity_check=ok`、`foreign_key_check=0`、G1~G3 行数一致。全部通过，真实库未被触碰。

## 禁止

- 禁止对 v6 库做逆向迁移“降级”。
- 禁止用晋升包反向删除来“回滚”。
- 禁止在未验证备份 hash 的情况下声明回滚成功。
