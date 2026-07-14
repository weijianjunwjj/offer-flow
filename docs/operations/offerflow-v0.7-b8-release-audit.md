# OfferFlow v0.7.0-B B8 发布前审计

## 1. 结论

- 工程审计：通过。B0–B8 可信求职记忆底座的既有测试、恢复演练和真实数据只读复核事实保持有效。
- 产品发布验收：失败。动态画像、证据充分性、阶段策略与 Proposal Review 尚未实现；当前为 `v0.7 产品实施中`，禁止发布。
- App 版本：仍为 `0.6.2`。
- 技术设计：B0–B8 已完成。
- main：未合并；未创建 PR、Tag 或 Release。
- B8 没有新增产品功能、数据库结构或依赖。

## 2. 真实数据只读复核

| 项目 | 结果 |
|---|---|
| schema / migration | 2 / 连续 |
| integrity / foreign keys | ok / 0 |
| profiles / jobs | 1 / 13 |
| 原始 import_logs / migration audit | 1 / 1 |
| resume_versions / applications / feedback_events | 0 / 7 / 7 |
| Projection | valid 0 / degraded 7 / invalid 0 |
| backfill | skip 6 / manual review 0 / 二次新增 0 |
| Job hash / legacy 字段变化 | 0 / 0 |
| 正式 Snapshot | schema 2，所有同步表差异 0 |
| 复核前后 | 数据库与 Snapshot 规范化指纹均未变化 |

迁移 Event 均为 `legacy_status_imported`，来源为 `system_migration`，置信度为 inferred、证据级别为 weak；没有伪造 applied、rejected、message_viewed 等具体业务事件。所有迁移 Application 的 ResumeVersion 仍为未知，Projection 未持久化。

## 3. 关键备份

| 备份 | schema | 大小 | 短哈希 | integrity/FK | Snapshot | apply 绑定 |
|---|---:|---:|---|---|---|---|
| `20260714-102807-b7a-6f0ac3d1` | 1 | 270336 B | `ba0d599568ad` | ok / 0 | v1，2 文件 | 通过 |
| `20260714-112449-b7a-8d54a08b` | 1 | 270336 B | `ba0d599568ad` | ok / 0 | v1，2 文件 | 通过 |
| `20260714-112746-b7b-475bd682` | 2 | 356352 B | `b147f7533535` | ok / 0 | v2，2 文件 | 通过 |

三份备份均为普通目录、非符号链接、被 Git ignore；完整 manifest hash/size 校验通过，审计前后未被覆盖。

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
| B8 目标测试 | 4 文件、25 测试通过 |
| B8 audit | 连续两次 `V070_B8_AUDIT_PASS` |
| upgrade selftest | 4 文件、35 测试通过 |
| migration selftest | 通过 |
| server/job-memory/snapshot/sync | 11 文件、91 测试通过 |
| 完整 Vitest | 37 文件、292 测试通过，无 skip/todo |
| typecheck / build | 通过 / 通过 |
| selftest | 全链路通过 |
| decision / backend API selftest | 通过 / 通过 |
| v2 smoke | 通过，临时目录清理 |
| snapshot:check | 连续两次通过，聚合一致 |
| verify-real | 连续两次通过，聚合一致、二次新增 0 |
| Router smoke | 连续两次通过，端口释放 |
| OFFER_FLOW_JSON eval | 10/10，通过率 100% |

测试没有调用真实 LLM、OCR 或外部业务服务，没有使用全局进程终止命令，也没有修改真实业务数据。

## 8. 已知非阻塞风险

- Vite 生产构建仍提示既有主 chunk 超过 500 kB。B8 明确禁止顺手优化 chunk，本轮只记录，不扩范围。
- 历史文档仍代表各自当时版本；当前产品边界继续以 `AGENTS.md`、README 和本技术设计为准。

## 9. 产品发布边界纠偏

B8 只完成可信求职记忆底座的工程审计，不构成完整 v0.7 产品发布候选。此前将 B8 识别为 Release Candidate 是把技术阶段完成误当成产品结果完成，本节现予纠正；第 2–8 节的既有测试、数据与恢复演练事实不受影响。

当前统一状态为：`v0.7 产品实施中`、`可信求职记忆底座已完成`、`动态画像与策略尚未完成`、`禁止发布`。App 版本继续保持 `0.6.2`，不得据此执行版本升级、合并、PR、Tag 或 Release。后续发布判断必须以 `docs/product/offerflow-v0.7-release-contract.md` 的全部产品结果为准。
