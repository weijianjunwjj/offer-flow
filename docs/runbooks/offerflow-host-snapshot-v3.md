# OfferFlow Host Snapshot V3 离线运行手册

本手册只描述离线导出、校验、NovaWing schema bootstrap 和全新候选库恢复。它不授权连接真实业务数据库，不执行正式数据库替换，也不启用 NovaWing feature flag。

## 前置条件

1. 停止 HTTP 服务并排空请求；显式关闭所有 OfferFlow 与 NovaWing 数据库连接。
2. 准备一个位于源码工作区之外的显式 working directory。
3. 所有路径必须手工提供；命令没有 production 默认路径。
4. 数据库必须为 schema v8、`journal_mode=DELETE`；不得切换 WAL。

先用 `--dry-run` 验证参数和契约：

```text
npm run snapshot:v3:export -- --database <sqlite-file> --output <new-snapshot-dir> --work-dir <working-dir> --workspace <offerflow-repo> --confirm EXPORT_HOST_SNAPSHOT_V3_OFFLINE --dry-run
npm run snapshot:v3:restore-candidate -- --snapshot <snapshot-dir> --candidate <new-sqlite-file> --work-dir <working-dir> --workspace <offerflow-repo> --confirm RESTORE_HOST_SNAPSHOT_V3_TO_NEW_CANDIDATE --dry-run
npm run novawing:bootstrap -- --database <sqlite-file> --confirm BOOTSTRAP_NOVAWING_SCHEMA_OFFLINE --dry-run
```

## 导出与校验

```text
npm run snapshot:v3:export -- --database <sqlite-file> --output <new-snapshot-dir> --work-dir <working-dir> --workspace <offerflow-repo> --confirm EXPORT_HOST_SNAPSHOT_V3_OFFLINE
npm run snapshot:v3:verify -- --snapshot <snapshot-dir>
```

输出目录必须原先不存在。成功后只包含：

- `offerflow-host.snapshot.v3.json`
- `offerflow-host.manifest.v3.json`

不得把 V2 的 `offerflow.snapshot.json` / `offerflow.manifest.json` 当作 V3；V3 loader 不接受 V2，也不会生成虚假空 NovaWing component。

## 离线 bootstrap

```text
npm run novawing:bootstrap -- --database <sqlite-file> --confirm BOOTSTRAP_NOVAWING_SCHEMA_OFFLINE
```

该命令先验证 OfferFlow schema v8、DELETE journal 和无活动数据库操作；只通过正式包公开 migration apply 创建缺失的 `nw_*` schema。兼容 schema 重复运行为只读 validate，不破坏已有数据；部分或不兼容 schema 硬拒绝。正常 `buildServer()` 和 Runtime 始终 validate-only，不调用此命令。

## 恢复到候选库

```text
npm run snapshot:v3:restore-candidate -- --snapshot <snapshot-dir> --candidate <new-sqlite-file> --work-dir <working-dir> --workspace <offerflow-repo> --confirm RESTORE_HOST_SNAPSHOT_V3_TO_NEW_CANDIDATE
```

目标文件和同名报告必须原先不存在。成功产生候选库和 `<candidate>.host-snapshot-v3-report.json`；报告只含版本、数量、digest、revision、integrity/FK 和 rename 探针状态，不含路径或正文。

候选成功不等于正式替换授权。本切片没有、也不得执行正式文件 rename/delete。未来切换至少还需独立授权、原文件备份路径、候选路径、校验摘要、所有连接关闭证明和可回滚替换计划。

## 失败处理

- 导出失败：staging 目录被清理，不发布输出目录。
- bootstrap 失败：不执行自制 SQL 降级或部分修补；检查离线状态和 schema 后重新计划。
- 恢复失败：候选库、journal/WAL sidecar 和候选报告被清理；原数据库不参与恢复写入。
- 所有错误均使用稳定错误码；不要通过打印原始 SQLite 错误、行正文、token 或绝对路径排障。
