# OfferFlow Host Snapshot V3：schema v8 表审计与组件契约

> 状态：已实现；仅用于离线导出和全新候选库恢复。本文不授权读取、复制或替换真实数据库。

## 1. 审计结论

schema v8 共有 38 张 OfferFlow 表。Host Snapshot V3 的 `offerflow` 组件纳入 35 张，排除 3 张：

- `schema_migrations`：由受信任的当前 migration bootstrap 确定性重建，不能让数据快照覆盖 migration 事实；
- `import_logs`：历史导入执行摘要，不是当前业务事实；正式结果已进入业务表。Snapshot V2 仍按既有契约保留它；
- `radar_rule_assessments`：由冻结 CandidateVersion、规则版本和规则投影确定性重算；分析任务已冻结实际使用的投影。

没有“待定”表。运行时任务、短期会话、回执和派生批次没有按类别一刀切排除；当它们承载未完成用户工作、幂等安全、不可重现输入或审计链时仍纳入。

## 2. 全表分类

分类：`权威业务`、`可重算派生`、`缓存`、`运行时任务`、`migration/meta`、`临时/审计`。

| 表 | 创建 migration | 分类 | 主要读写模块 | 外键依赖 | V3 | 理由 |
|---|---|---|---|---|---|---|
| `analysis_tasks` | `007_v0_8_radar_domain_schema` | 运行时任务 | `radar/analysisTaskRepository`、`radar/analysis` | 无 | 是 | 保存不可替代的 input snapshot/hash 与可恢复任务状态。 |
| `app_meta` | `001_v0_6_baseline` | migration/meta | `migrations`、Job Memory、sync | 无 | 是 | 除 schema 外还含 active resume 等权威指针；恢复后校验 schema v8。 |
| `applications` | `002_v0_7_job_memory_schema` | 权威业务 | Job Memory、Radar promotion | `jobs`、`resume_versions`、自身 | 是 | 正式求职流程事实。 |
| `candidate_evidence` | `003_v0_7_capability_baseline_schema` | 权威业务 | capability baseline | 无 | 是 | 经人工/AI 审核的证据不可安全重算。 |
| `capability_baseline_meta` | `003_v0_7_capability_baseline_schema` | 权威业务 | capability baseline | 无 | 是 | active version 权威指针。 |
| `capability_baseline_proposals` | `003_v0_7_capability_baseline_schema` | 权威业务 | capability baseline | 无 | 是 | 提案及人工裁决历史。 |
| `capability_baseline_versions` | `003_v0_7_capability_baseline_schema` | 权威业务 | capability baseline | 无 | 是 | 正式不可变能力基线。 |
| `capability_command_receipts` | `003_v0_7_capability_baseline_schema` | 临时/审计 | capability repository | 无 | 是 | 幂等权威回执；丢失可能重放高影响命令。 |
| `feedback_events` | `002_v0_7_job_memory_schema` | 权威业务 | Job Memory、Radar promotion | `applications`、自身 | 是 | append-only 求职反馈事实。 |
| `historical_baseline_drafts` | `004_v0_7_history_funnel_schema` | 临时/审计 | history import | session、resume、job、application、自身 | 是 | 未确认草稿及正式对象追踪不可安全重算。 |
| `historical_event_drafts` | `004_v0_7_history_funnel_schema` | 临时/审计 | history import | baseline draft、`feedback_events` | 是 | 人工补录事件与确认结果追踪。 |
| `historical_import_receipts` | `004_v0_7_history_funnel_schema` | 临时/审计 | history receipt repository | import session | 是 | 历史补录幂等回执。 |
| `historical_import_sessions` | `004_v0_7_history_funnel_schema` | 临时/审计 | history import | 无 | 是 | 未完成人工补录会话及草稿 FK 根。 |
| `import_logs` | `001_v0_6_baseline` | 临时/审计 | local import、upgrade、sync | 无 | 否 | 仅执行摘要，不是当前事实；V2 契约保持原样。 |
| `job_match_analysis_records` | `007_v0_8_radar_domain_schema` | 权威业务 | radar analysis | candidate/version、resume、自身 | 是 | 不可复现的模型结果和 Envelope 历史。 |
| `jobs` | `001_v0_6_baseline` | 权威业务 | job repository、Job Memory、promotion | 无 | 是 | 正式岗位记忆。 |
| `market_position_meta` | `005_v0_7_market_position_schema` | 权威业务 | market position | 无 | 是 | active version 权威指针。 |
| `market_position_proposals` | `005_v0_7_market_position_schema` | 权威业务 | market position | 无 | 是 | 提案及人工裁决历史。 |
| `market_position_receipts` | `005_v0_7_market_position_schema` | 临时/审计 | market position repository | 无 | 是 | 命令幂等权威回执。 |
| `market_position_versions` | `005_v0_7_market_position_schema` | 权威业务 | market position | 无 | 是 | 正式不可变版本。 |
| `profiles` | `001_v0_6_baseline` | 权威业务 | profile repository、sync | 无 | 是 | 正式用户画像。 |
| `radar_actions` | `007_v0_8_radar_domain_schema` | 权威业务 | radar action | candidate/version、自身 | 是 | 人工动作事实和撤销链。 |
| `radar_candidate_relations` | `008_v0_8_radar_candidate_relations_schema` | 权威业务 | relation repository、review | candidates、actions、自身 | 是 | 重复裁决及演进历史。 |
| `radar_candidate_sources` | `007_v0_8_radar_domain_schema` | 权威业务 | candidate repository | candidates、source records | 是 | 候选与来源的权威关联。 |
| `radar_candidate_versions` | `007_v0_8_radar_domain_schema` | 权威业务 | candidate repository、review | candidates、自身 | 是 | 不可变标准化岗位事实版本。 |
| `radar_candidates` | `007_v0_8_radar_domain_schema` | 权威业务 | candidate repository、review | source/version、自身 | 是 | Candidate 生命周期权威数据。 |
| `radar_capture_sessions` | `007_v0_8_radar_domain_schema` | 临时/审计 | capture repository、routes | 无 | 是 | 保存未完成预览，也是不可变 capture snapshot 的可选来源。 |
| `radar_capture_snapshots` | `007_v0_8_radar_domain_schema` | 权威业务 | capture repository、commit | capture session | 是 | 不可变原始来源事实。 |
| `radar_promotions` | `007_v0_8_radar_domain_schema` | 权威业务 | radar promotion | candidate/version、job/application/event/action | 是 | Radar 到正式记忆的权威晋升追踪。 |
| `radar_recommendation_batches` | `007_v0_8_radar_domain_schema` | 可重算派生 | recommendation repository/service | 无 | 是 | 算法可再跑，但历史诊断与晋升追踪不能逐字段保证重现。 |
| `radar_rule_assessments` | `007_v0_8_radar_domain_schema` | 可重算派生 | rule repository、review、analysis input | candidate/version | 否 | 冻结版本和规则确定性重算；任务保留实际投影。 |
| `radar_source_records` | `007_v0_8_radar_domain_schema` | 权威业务 | source repository、commit | capture snapshots | 是 | 来源身份和最后不可变快照指针。 |
| `resume_versions` | `002_v0_7_job_memory_schema` | 权威业务 | resume repository | 无 | 是 | 正式不可变简历版本。 |
| `schema_migrations` | migration runner metadata | migration/meta | `migrations` | 无 | 否 | 由当前受信 migration bootstrap 重建，禁止快照覆盖。 |
| `strategy_meta` | `006_v0_7_strategy_window_schema` | 权威业务 | strategy window | 无 | 是 | active version 权威指针。 |
| `strategy_proposals` | `006_v0_7_strategy_window_schema` | 权威业务 | strategy window | 无 | 是 | 提案及人工裁决历史。 |
| `strategy_receipts` | `006_v0_7_strategy_window_schema` | 临时/审计 | strategy repository | 无 | 是 | 命令幂等权威回执。 |
| `strategy_versions` | `006_v0_7_strategy_window_schema` | 权威业务 | strategy window | 无 | 是 | 正式不可变策略版本。 |

schema v8 当前没有独立缓存表。上述结论同时固化在 `OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY`；测试将 registry 与临时 v8 数据库的实际表集合逐项比对，防止新增表静默遗漏。

## 3. 双组件与 manifest

- Host format/version：`host.snapshot.v3` / `3`；Host identity 为 `offerflow`、应用版本、数据库 schema v8、创建时间。
- OfferFlow component：稳定名 `offerflow`，format `offerflow.snapshot.v3`，35 张显式权威表；每表记录列、主键、行数和内容 digest，组件有完整 digest。
- NovaWing component：直接注册正式包 `createNovaWingSnapshotComponent()`；只接受其公开的 `nw_meta`、`nw_proposals`、`nw_mainline_entries`。
- 组合 manifest 使用正式包的注册、创建、验证和恢复后验证 API；未知/缺失组件、版本、owner 越权、重复表/组件、schema/行数/digest 篡改均硬拒绝。
- Host component manifest 按表名字典序规范化；转回 NovaWing component manifest 时显式按 NovaWing 公开 registry 顺序排列，避免依赖隐式顺序。

## 4. 一致性、恢复与安全边界

- 导出要求服务离线且所有业务连接关闭；专用 OfferFlow 连接用 `BEGIN IMMEDIATE` 建立一致性边界并阻止外部写入，专用 NovaWing `node:sqlite` 连接在同一文件上只读，二者捕获同一 point-in-time。
- V3 数据与 manifest 写入同一 staging 目录，完整回读验证后以目录 rename 发布；失败删除 staging，不留下半份文件，也不覆盖 V2 文件名。
- 恢复只写调用方指定、工作区外、原先不存在的新候选文件：先 OfferFlow v8 migrations，再公开 NovaWing migration apply，再恢复两组件，执行 integrity/FK、两个组件和 Host 组合校验，最后用正常 validate-only Runtime 双驱动读取并做关闭/rename 探针。
- 任一步失败删除候选库、sidecar 和报告。实现不包含正式文件替换逻辑，也不自动启用 feature flag。
- 导出前扫描凭证键、常见 token/provider key、`process.env` 和绝对路径；命中即停止，不静默删改权威数据。CLI 和报告不包含绝对路径、SQL、SQLite 原文或业务正文。
