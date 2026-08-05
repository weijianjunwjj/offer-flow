# OfferFlow Host Snapshot V3 离线运行手册

本手册只描述离线导出、校验、NovaWing schema bootstrap 和全新候选库恢复。它不授权连接真实业务数据库，不执行正式数据库替换，也不启用 NovaWing feature flag。

## 前置条件

1. 停止 HTTP 服务并排空请求；显式关闭所有 OfferFlow 与 NovaWing 数据库连接。
2. 准备一个位于源码工作区之外的显式 working directory。
3. 所有路径必须手工提供；命令没有 production 默认路径。
4. 数据库必须为 schema v8、`journal_mode=DELETE`；不得切换 WAL。

## CLI 参数与 Windows 路径安全门

- 无命令、`help`、`--help`、`-h`，以及合法命令后的单独 `--help` / `-h` 才成功显示帮助；未知命令即使携带 `--help` 也拒绝。
- CLI 最多接受 32 个参数；单参数最多 4096 个 UTF-16 code unit；全部参数合计最多 16384 个。NUL、换行、其它 C0 控制字符和 DEL 均拒绝。
- 重复参数、缺失值、多余位置参数、未知参数、`--dry-run=<value>` 等非法布尔形式均稳定拒绝。错误只报告安全的位置，不回显未知参数、路径或其后续值。
- 所有路径必须由调用方提供为带盘符的 Windows 本地绝对路径。命令不读取 `OFFERFLOW_DB_PATH`，不从 cwd、仓库或默认配置推导数据库路径。
- 相对路径、`.` / `..` 节点、纯空白、UNC/network path、`\\?\` / `\\.\` device namespace、盘符根目录、控制字符、尾随点/空格、Windows 保留设备名、alternate data stream 语法，以及 `-journal` / `-wal` / `-shm` SQLite sidecar 均拒绝。
- 已存在输入逐节点使用 `lstat` 检查可识别的 symlink/junction，再使用 `realpath` 形成 canonical 路径并核对文件/目录类型。Windows 路径比较不区分大小写。
- 新输出必须不存在，直接父目录必须已存在且通过相同节点/`realpath` 检查；候选 canonical 路径由真实父目录加最终 basename 构造。CLI 不执行 `mkdir -p`，`--dry-run` 也执行完整路径校验但不创建文件。
- source/target canonical 相同、仅大小写不同、规范化后相同或发生危险父子重叠时拒绝。snapshot 输出不得与数据库输入重叠；候选库不得位于 snapshot 内。

稳定错误码区分参数格式、参数上限、必须绝对、类型不匹配、危险 Windows 路径、链接/junction、路径冲突、输出已存在、父目录不存在和 snapshot 成员非普通文件。错误不包含绝对路径、未知参数原文、SQLite 原始错误、环境变量或文件正文。

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

当前 V3 的 `offerflow` 与 `novawing` 组件数据内嵌于 data 文件，没有独立组件文件。data 与 manifest 都必须是 snapshot 目录内的实际普通文件；目录冒充文件、symlink、junction 和检查后被明显替换均拒绝。读取时使用文件描述符，并在读取前后比较路径对象与句柄对象的 identity/size/time 元数据，以缩短检查与读取窗口。

剩余限制：Node 当前 API 将 symlink 和 Windows junction 暴露为 symbolic link，但不能可靠区分或识别所有其他 reparse tag；本实现不声称完整覆盖所有 reparse point。文件描述符复核缩短了成员 TOCTOU 窗口，但目录父链与尚不存在输出的最终发布仍不是句柄相对操作。下一阶段若要进一步收紧，应使用 Windows handle-relative open、禁止 reparse 的原生打开选项和基于已打开目录句柄的发布/rename 方案。

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
