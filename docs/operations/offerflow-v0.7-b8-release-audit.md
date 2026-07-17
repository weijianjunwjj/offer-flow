# OfferFlow v0.7.0-B B8 发布前审计

## 1. 结论

- 工程审计：通过。B0–B8 可信求职记忆底座的既有测试、恢复演练和真实数据只读复核事实保持有效。
- 产品发布验收：失败。动态画像、证据充分性、阶段策略与 Proposal Review 尚未实现；当前为 `v0.7 产品实施中`，禁止发布。
- App 版本：仍为 `0.6.2`。
- 技术设计：B0–B8 已完成。
- main：未合并；未创建 PR、Tag 或 Release。
- B8 没有新增产品功能、数据库结构或依赖。

## 2. R0.1 后真实数据只读复核

| 项目 | 结果 |
|---|---|
| schema / migration | 2 / 连续 |
| integrity / foreign keys | ok / 0 |
| profiles / jobs | 1 / 14 |
| import_logs / app_meta | 2 / 3 |
| resume_versions / applications / feedback_events | 1 / 8 / 9 |
| Projection | valid 1 / degraded 7 / invalid 0 |
| 领域不变量 | orphan、非法 target/replacement、rowVersion、幂等冲突均为 0 |
| migration/backfill 重复 | 重复 legacy seed 0 / 异常 migration Event 0 |
| 正式 Snapshot | schema 2，所有同步表差异 0 |
| 复核前后 | 数据库与 Snapshot 规范化指纹均未变化 |

R0 后用户通过正常 Human-in-the-loop 页面操作新增了 1 个 Job、1 个 ResumeVersion、1 个 Application 和 2 个 FeedbackEvent，并激活了该 ResumeVersion。只读审计确认这些新增记录的 Schema、审计事件与人工来源合法；没有异常自动写入、第二轮 backfill、重复 `legacy_status_imported`、Projection 持久化或 Job legacy 字段旁路。

原 `job-memory-v2:verify-real` 错误地将 B7-B 当时的固定聚合和旧源指纹当作永久生产基线。R0.1 已将职责拆分：`verify-upgrade-attestation` 继续绑定 B7-B 的 Backup、apply-result、历史 13/0/7/7 聚合与旧指纹；`verify-real` 只验证当前 schema、integrity/FK、migration、领域不变量、Projection、正式 Snapshot 一致性以及运行前后数据不变。生产数据经用户确认后的正常增长不再破坏历史升级证明。

## 3. 关键备份

| 备份 | schema | 大小 | 短哈希 | integrity/FK | Snapshot | apply 绑定 |
|---|---:|---:|---|---|---|---|
| `20260714-102807-b7a-6f0ac3d1` | 1 | 270336 B | `ba0d599568ad` | ok / 0 | v1，2 文件 | 通过 |
| `20260714-112449-b7a-8d54a08b` | 1 | 270336 B | `ba0d599568ad` | ok / 0 | v1，2 文件 | 通过 |
| `20260714-112746-b7b-475bd682` | 2 | 356352 B | `b147f7533535` | ok / 0 | v2，2 文件 | 通过 |
| `20260714-161148-r01-c4b319ff` | 2 | 372736 B | `2b07702be957` | ok / 0 | 同步前旧 v2，2 文件 | 不适用（R0.1 pre-sync） |

四份备份均为普通目录、非符号链接、被 Git ignore；完整 manifest hash/size 校验通过。R0.1 备份使用安全 online backup，保存同步前真实 schema v2 SQLite 与旧正式 Snapshot pair，未覆盖前三份历史备份。

## 4. 恢复与续发演练

- v1：批准备份恢复到系统临时目录；schema 1、1/13/1 聚合与 manifest 一致；v2 表不存在；显式 capability=false Server 的 legacy Job API 只读 smoke 通过；数据库指纹不变，端口和目录已清理。
- v2：post-upgrade 备份的 SQLite 与 Snapshot v2 恢复到系统临时目录；0/7/7 与 import_logs 2 聚合正确；consistency、roundtrip 和三个只读 API 通过；端口和目录已清理。
- Snapshot 续发：合成 v1 fixture 在单一事务提交 schema v2 与 7/7 backfill 后注入 Snapshot pair 发布失败；数据库保持 v2，partial state 为 `true/false/false`；普通 apply 重跑被拒绝；resume 校验 Backup ID、Commit、数据库指纹、migration audit 和聚合后仅发布 Snapshot；未重复 backfill，最终状态为 `true/true/true`；post-upgrade 备份绑定成功；二次 resume 返回 `already-resolved`。
- 所有恢复演练只使用临时目录或隔离副本，未触碰真实数据库。

## 5. 生产默认与事实源

- 默认 schema target=2，后端 capability=true，前端 flag=true，Snapshot schema=2。
- 新空库默认初始化 v2；已升级库正常打开；未升级 v1 生产库被明确拒绝且不自动建表/backfill。
- v1 仅由显式兼容配置启用。
- 默认 JobList 使用 summaries，JobDetail 使用 bundle；ResumeVersion、Application 和 Timeline 入口保持启用。
- Application 不持久化 stage、outcome、communicationStatus 或 Projection。
- 有 Application 时决策只读 ApplicationProjection；零 Application 才区分 legacy fallback 与 opportunity-only；invalid 不回退 legacy。
- v2 legacy write guard 返回 422，事件投影不反写 Job/Application。
- Application、ResumeVersion、FeedbackEvent、void、投递、消息、跟进和 Offer 结果均没有自动执行路径，Human-in-the-loop 保持。

## 6. 范围与隐私

未实现历史补录、全局漏斗、转化率、Runtime SSE Gate 2、AI 画像、EvidenceSufficiency、AI Proposal、StrategyWindow、Boss/猎聘抓取、自动投递或自动消息发送；未处理既有 chunk warning。

依赖与 `origin/main` 一致；DeepSeek/LLM/OCR 边界未变化；SQLite、Snapshot、备份和 apply-result 均未被 Git 跟踪。历史文档中 5 处本机绝对路径已替换为 `<workspace>`，未改变业务含义。

## 7. 测试结果

| Gate | 结果 |
|---|---|
| R0.1 目标测试 | 5 文件、21 测试通过 |
| B8 audit | 连续两次 `V070_B8_AUDIT_PASS`；历史升级、当前生产、当前 Snapshot 分段通过 |
| upgrade selftest | 5 文件、39 测试通过 |
| migration selftest | 通过 |
| 完整 Vitest | 41 文件、307 测试通过，无 skip/todo |
| typecheck / build | 通过 / 通过 |
| selftest | 全链路通过 |
| decision / backend API selftest | 通过 / 通过 |
| v2 smoke | 通过，临时目录清理 |
| snapshot:check | 正式同步后连续两次通过，当前聚合差异 0 |
| verify-real | 连续两次通过，当前不变量、Snapshot、前后指纹与无写入均通过 |
| verify-upgrade-attestation | 连续两次通过，当前增长不影响历史 B7-B 证明 |
| Router smoke | 连续两次通过，端口释放 |

测试没有调用真实 LLM、OCR 或外部业务服务，没有使用全局进程终止命令，也没有修改真实业务数据。

## 8. 已知非阻塞风险

- Vite 生产构建仍提示既有主 chunk 超过 500 kB。B8 明确禁止顺手优化 chunk，本轮只记录，不扩范围。
- 历史文档仍代表各自当时版本；当前产品边界继续以 `AGENTS.md`、README 和本技术设计为准。

## 9. 产品发布边界纠偏

B8 只完成可信求职记忆底座的工程审计，不构成完整 v0.7 产品发布候选。此前将 B8 识别为 Release Candidate 是把技术阶段完成误当成产品结果完成，本节现予纠正；第 2–8 节的既有测试、数据与恢复演练事实不受影响。

当前统一状态为：`v0.7 产品实施中`、`可信求职记忆底座已完成`、`动态画像与策略尚未完成`、`禁止发布`。App 版本继续保持 `0.6.2`，不得据此执行版本升级、合并、PR、Tag 或 Release。后续发布判断必须以 `docs/product/offerflow-v0.7-release-contract.md` 的全部产品结果为准。

R0.1 只修正生产基线与验证语义，并将正式 Snapshot v2 同步至当前真实数据库；它不改变 R1–R5 的未实现状态，不构成 RC，也不解除产品发布阻塞。
