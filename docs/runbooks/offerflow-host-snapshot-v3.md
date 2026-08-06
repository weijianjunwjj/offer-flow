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

目标文件、`-journal` / `-wal` / `-shm` sidecar 和同名报告必须原先不存在；`--dry-run` 也执行相同预检且零写入。候选库直接父目录必须已经存在，命令不会创建调用方目录。

每次运行生成 128-bit 随机运行 ID，并维护仅存在于进程内的 ownership ledger。候选库先用 `wx` 独占预占为零长度普通文件，通过已打开 descriptor 的 identity 登记 ownership，再交给 SQLite schema/bootstrap/restore；`better-sqlite3` 与 `node:sqlite` 已由临时磁盘库测试证明可在该预占文件上初始化。清理只处理 ledger 中由本次运行成功创建且 identity 未变化的精确路径，不扫描目录或通配符，也不根据“文件现在存在”接管调用方文件。

rename probe 使用与候选库同目录的 `.offerflow-host-v3-<random-run-id>.rename-probe`。probe 通过 `wx` 独占预留并登记，旧的 `<candidate>.rename-probe` 不再读取、删除或复用。候选库 rename 前后 ownership 随路径转移，完成后不遗留 probe。

报告先在最终报告同目录通过 `wx` 独占创建 `.offerflow-host-v3-<random-run-id>.report.tmp`，完整写入、`fsync`、关闭并复核 owned 普通文件 identity。发布使用同目录 hard-link 创建最终名称：目录项创建是原子的，目标已存在时失败且不覆盖；随后删除临时 link。该协议依赖最终报告所在文件系统支持同卷 hard link，不支持时稳定返回 `HOST_SNAPSHOT_V3_REPORT_PUBLISH_FAILED`，不会降级为覆盖 rename。成功产生候选库和 `<candidate>.host-snapshot-v3-report.json`；报告只含版本、数量、digest、revision、integrity/FK 和 rename 探针状态，不含路径或正文。

候选成功不等于正式替换授权。本切片没有、也不得执行正式文件 rename/delete。未来切换至少还需独立授权、原文件备份路径、候选路径、校验摘要、所有连接关闭证明和可回滚替换计划。

## 进程中断阶段模型

代码中的 `RESTORE_CANDIDATE_PHASE_MODEL` 固定了完整阶段、持久化产物、开放句柄、源库可变性、中断安全性、预期残留与下次运行行为。正式 CLI 不暴露 failpoint；阶段 observer 仅供独立测试 worker 使用。

| 阶段边界 | 持久化产物 | 开放句柄 | 强制终止后的残留与下次行为 |
|---|---|---|---|
| 路径校验 / snapshot 验证后 | 无 | 无 | 无 restore 残留，可重新运行 |
| candidate 独占预占后 | 零长度 candidate | 无 | candidate 不能视为成功；同路径重跑拒绝覆盖 |
| OfferFlow schema bootstrap 后 | candidate | 无 | 不完整 candidate；重跑 fail-closed |
| NovaWing schema bootstrap 后 | candidate | 无 | 不完整 candidate；重跑 fail-closed |
| OfferFlow 数据恢复后 | candidate | 无 | 不完整 candidate；重跑 fail-closed |
| NovaWing 数据恢复后 | candidate | 无 | 不完整 candidate；重跑 fail-closed |
| integrity/FK 后、Host 校验前 | candidate | 两个只读 SQLite handle | 进程终止后 OS 关闭句柄；candidate 仍不能视为成功 |
| component / Host 校验后 | candidate | 两个只读 SQLite handle | 未有正式 report，不得启用 |
| Runtime validate 后 | candidate | Runtime 双连接 | 未有正式 report，不得启用 |
| rename probe 预留后 | candidate + probe reservation | 无 | 两者都不自动删除或接管 |
| candidate 已移入 rename probe | 含 candidate bytes 的随机 probe | 无 | candidate 最终路径可能缺失；检测到 probe 时重跑拒绝 |
| rename probe 完成 | candidate | 无 | probe 已消失；candidate 仍不完整 |
| report temp 创建 | candidate + 空 temp | temp descriptor | temp 不得视为正式 report；重跑拒绝 |
| report temp 写入、未 fsync | candidate + 未持久化保证的 temp | temp descriptor | 不发布、不自动删除；重跑拒绝 |
| report temp fsync、未发布 | candidate + fsync temp | temp descriptor | 不发布、不自动删除；重跑拒绝 |
| final report hard-link 发布、temp 未删 | candidate + final + temp | 无 | final 不自动删除；完整成功判定拒绝 |
| report temp 删除 | candidate + final | 无 | 仍须从磁盘重新验证所有成功条件 |
| candidate/report 重验证完成 | candidate + final | 无 | 可描述为已验证结果；重跑仍拒绝覆盖，正式替换仍需授权 |
| ownership 释放 / 正常返回 | candidate + final | 无 | 完整候选结果；不等于生产启用或正式替换 |

所有阶段的 `source mutation possible` 均为 `false`。进程级测试使用父进程创建的系统临时根、真实 restore 调用链和同步阶段消息；父进程收到精确阶段后在 Windows 上强制终止子进程、等待真实退出，再检查 byte hash、SQLite sidecar、report/candidate 状态，并用第二个独立进程验证重跑行为。测试不依赖任意 sleep，也不通过 shell 字符串启动子进程。

## 只读残留判定与成功重验证

内部 `inspectRestoreResidue()` 只接受显式绝对 snapshot/candidate 路径，复用 `pathSafety`，不读取默认数据库路径、不启动 HTTP、不写入、不删除、不 rename、不创建 sidecar，也不输出绝对路径。它只报告可观察事实，不根据名称、时间或文件缺失推断 ownership：

- `NO_RESIDUE`
- `CANDIDATE_WITHOUT_REPORT`
- `REPORT_TEMP_WITHOUT_FINAL`
- `FINAL_REPORT_WITH_TEMP_REMAINDER`
- `CANDIDATE_AND_FINAL_REPORT_PRESENT`
- `SQLITE_SIDECAR_PRESENT`
- `AMBIGUOUS_OR_UNOWNED_RESIDUE`

每个计划只包含 `classification / verifiedFacts / unverifiedFacts / blockedOperation / recommendedManualAction`，并附带脱敏的成功重验证状态和稳定错误码。身份不明的文件只能“人工确认后处理”；本实现没有 cleanup 命令。

`CANDIDATE_AND_FINAL_REPORT_PRESENT` 也不自动等于成功。`revalidateRestoreCandidateSuccess()` 必须同时证明：candidate 与普通 final report 存在；report 结构完整且绑定当前 snapshot 的 Host digest；candidate 的 integrity/FK、OfferFlow component、NovaWing component、Host 组合与正常 Runtime validate 全部通过；NovaWing revision 与报告一致；不存在未解释的 `-journal/-wal/-shm`、report temp 或 rename probe；所有验证连接已经关闭。任一条件失败均返回脱敏拒绝，不回显 SQLite 原文、路径、堆栈或数据正文。

人工处置原则：

- candidate 无 report：禁止成功判定、正式启用或替换；保持文件不变，在隔离环境人工核验。
- final report + temp：保留 final，不自动删除 temp；人工确认 temp 身份后处理并重新验证。
- sidecar 或未知文件：ownership 无法证明，阻止覆盖和清理；仅在人工确认后处理。
- candidate + final 完整重验证通过：只证明候选结果完整，正式启用/替换仍需独立授权。

## 失败处理

- 导出失败：staging 目录被清理，不发布输出目录。
- bootstrap 失败：不执行自制 SQL 降级或部分修补；检查离线状态和 schema 后重新计划。
- 恢复失败：先关闭本次打开的 SQLite 连接，再按 sidecar → probe → 未发布报告临时文件 → candidate → 未保留正式报告的顺序清理 owned 路径。调用方已有文件永不登记、永不清理。
- `EPERM` / `EBUSY` 删除最多尝试 3 次，固定短等待为 10ms、25ms；不无限重试或用长 sleep 掩盖句柄泄漏。owned 文件已经不存在视为幂等成功；identity 变化时停止删除。
- 主操作失败且清理成功时返回原始稳定错误。主操作与清理同时失败时返回 `HOST_SNAPSHOT_V3_CLEANUP_FAILED`，并以脱敏字段保留原始 `primaryCode`、清理状态和失败数量。
- 候选验证与正式报告发布已成功、但临时产物清理失败时，不报告完全成功；候选库和正式报告保留，错误的 `resultState=candidate-and-report-retained` 明确表示结果无法安全确认为完全成功。
- 所有错误均使用稳定错误码；不要通过打印原始 SQLite 错误、行正文、token 或绝对路径排障。

## 当前原子性边界

- 已用 13 个关键磁盘边界完成进程级强制终止矩阵，并实现 fail-closed 残留判定与成功结果重验证；这不是通用崩溃恢复系统，不自动续跑、rollback、清理残留或执行正式数据库替换。
- Node 文件 API 仍不是基于已打开父目录句柄的 handle-relative 操作。随机 probe 在独占预留文件删除后执行 candidate rename，依靠 128-bit 随机名称和紧邻检查缩小目标名被抢占窗口；本实现不宣称消除恶意并发进程在该极小窗口内制造的 TOCTOU。
- 动态 SQLite sidecar 的 ownership 证据由“运行前和 candidate 独占预占后均不存在 + candidate 本次 owned + 受控 SQLite 阶段后只检查该 candidate 的三个精确 sidecar”组成。没有目录扫描，也不会把同目录其他数据库的 sidecar 视为本次产物；操作系统级 creator attribution 留待需要原生句柄能力的后续切片。
