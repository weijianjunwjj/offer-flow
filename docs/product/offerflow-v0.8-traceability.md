# OfferFlow v0.8 PRD—Implementation Traceability

> **矩阵版本：** 1.0  
> **对应 PRD：** v2.1  
> **状态：** 文档基线完成；RC-04 的 V8-1 migration/域模型/Repository 部分已实施（见下表备注），其余全部为 Not Started

---

## 1. 用户结果追踪

| ID | 用户结果 | PRD | Technical Design | Evaluation | 波次 | 实施状态 | 验收证据 |
|---|---|---|---|---|---|---|---|
| RC-01 | BOSS 当前页采集 | 6.1 P0-01 / US-01 | 6.1 / 11.1 | 2.2 / 9 | V8-2 | Not Started | 真实页截图、preview payload |
| RC-02 | 通用可见文本降级 | 6.1 P0-02 / US-01 | 6.2 | 2.2 / 4 | V8-2 | Not Started | 非 BOSS 页面截图、未知字段验证 |
| RC-03 | 文本与标准 JSON | 6.1 P0-03 / US-02 | 4.1 / 6.3 | 2.3 / 9 | V8-2 | Not Started | 文本、单 JSON、小数组验收 |
| RC-04 | 不可变 Snapshot/Version | 4.3–4.5 / P0-04/05 | 3 / 4.2 / 4.5 | 5.1 | V8-1/2 | Partial（V8-1 全部子项完成，V8-2 未开始，整体不算完成） | 见下方 RC-04 分项证据 |
| RC-05 | 重复与变化 | P0-06 / US-03 | 5 | 5.1 | V8-3 | Not Started | fixture、Diff 截图、hash 结果 |
| RC-06 | 透明规则 | P0-07 / US-04 | 4.7 | 3 / 4 | V8-3 | Not Started | 命中原文、覆盖动作截图 |
| RC-07 | 可解释单岗位分析 | P0-08 / US-05 | 4.9 / 7 / 8 | 4 / 5.2 | V8-4 | Not Started | Payload、Envelope、证据引用 |
| RC-08 | 0～8 条推荐 | P0-09 / US-06 | 4.10 / 13.3 | 7 | V8-5 | Not Started | 正常批次与空推荐截图 |
| RC-09 | 误区或证据不足 | 4.8 / 11.3 / US-07 | 9 | 5.4 / 7 | V8-5 | Not Started | formed/insufficient 两类样本 |
| RC-10 | RadarAction | P0-10 / US-08 | 4.11 / 12 | 5.5 | V8-5 | Not Started | 动作流水、撤销、投影 |
| RC-11 | RadarPromotion | P0-11 / US-09 | 4.12 / 13.4 | 8 | V8-6 | Not Started | 晋升预览、幂等、反向追踪 |
| RC-12 | 可靠任务与发布闭环 | P0-12 / US-10 / 12.2 | 4.8 / 10 | 6 / 9 | V8-4/6 | Not Started | 故障日志、migration、恢复、截图 |

### 1.1 RC-04 分项证据（区分实现层次，不得合并为单一完成结论）

| 分项 | 状态 | 证据 |
|---|---|---|
| Schema / migration 实现 | Done | `server/migrations/radarDomainSchemaV7.ts`（12 表、FK/CHECK 约束、10 个索引）；`server/migrations.ts` 注册 v7；`RADAR_DOMAIN_SCHEMA_VERSION=7`，`PRODUCTION_SCHEMA_VERSION` 仍为 2，不影响生产默认路径 |
| 域模型 / Repository 实现 | Done | `src/domain/radar/`、`server/radar/`；`radar.spec.ts` 覆盖循环 FK 三步事务、Repository 不暴露 update/updateVersion |
| 自动化测试 | Done | `scripts/migrations.selftest.ts` v7 升级/幂等/约束测试块；`server/radar/radar.spec.ts`；全量 `vitest run` |
| 生产数据库副本迁移演练 | Done（本次执行） | 对生产库只读副本执行：一致性备份 → 复制为演练库 → 正式 `initSchema` 入口从 v6 升到 v7 → 12 张雷达表/10 个索引存在且为空 → 全部 v0.7 业务表行数与内容 hash 保持不变（仅 `schema_migrations` 按预期新增 1 行、`app_meta.schema_version` 按预期由 6 更新为 7）→ `integrity_check=ok`、`foreign_key_check` 无异常 → 再次运行 migration 确认幂等 → 循环 FK 三步事务与 `marked_applied_pending` Action 数据冒烟通过，未产生正式 Application → 生产库文件 hash 全程不变。演练全部在系统临时目录中进行，未提交、未保留任何数据库文件 |
| 备份与恢复验证 | Done（本次执行） | 对迁移前一致性副本（非生产库本身）执行项目现有正式备份机制 `backupDatabase()`（`VACUUM INTO` + `doctorDatabase` 校验），恢复到独立临时位置后验证 schema version、`integrity_check=ok`、`foreign_key_check` 无异常，核心 v0.7 表行数与 hash 与备份源一致；备份/恢复均使用临时 `OFFERFLOW_BACKUP_DIR`/`OFFERFLOW_SYNC_DIR`，未写入真实 `backups/`、`sync/` 目录，事后已清理 |
| V8-2 真实采集写入 DB 行与截图 | Not Started | 依赖浏览器采集桥，属于 V8-2 范围，本次未实施、未提前实施 |

RC-04 作为整体用户结果仍标记 **Partial**：V8-1 范围内的六项子证据全部完成，但 RC-04 定义本身包含"手动纠错和实质变化均创建新版本"的用户可见行为，其真实输入来源（BOSS 采集/降级采集/文本导入）在 V8-2 才会交付，因此在 V8-2 完成前不得将 RC-04 整行标记为 Done。

### 1.2 schema v7 生产激活时点（V8-1 结单前审计）

已审计 `initSchema` 实际调用链、`PRODUCTION_SCHEMA_VERSION`/`LATEST_SCHEMA_VERSION` 分工与真实生产库
当前状态，结论：当前策略安全且与 v3~v6 历史模式一致，**未修改任何代码**。`PRODUCTION_SCHEMA_VERSION`
保持 2 不变；schema v7（12 张雷达表）目前只在显式指定 `targetVersion: 7` 的测试/演练库中创建，真实生产
库启动不会自动迁移到 v7。v7 切换为生产默认目标的时点固定在 **V8-2**（届时才会有路由调用 radar
Repository，需要这些表真实存在）。详细证据与调用链见
`docs/runbooks/offerflow-v0.8-migration-recovery.md` 第 1.1 节。

---

## 2. 红队问题追踪

| ID | 问题 | 最终裁决 | 落地位置 | 状态 |
|---|---|---|---|---|
| RT-01 | 缺少不可变 RadarCandidateVersion | 新增独立版本实体 | TD 4.5 | Resolved in Docs |
| RT-02 | radar_application_marks 影子 Application | 完全删除，改 Action | TD 4.11 | Resolved in Docs |
| RT-03 | Candidate 状态混合 | 仅 active/merged/archived | PRD 4.4 / TD 4.4 | Resolved in Docs |
| RT-04 | AI 返回内部 ID | Envelope/Payload 分离 | PRD 4.10 / TD 4.9 | Resolved in Docs |
| RT-05 | 输入准备度缺失 | 必需/可选/降级规则 | PRD 5 / TD 7 | Resolved in Docs |
| RT-06 | stale 缺失 | 确定性派生 reasons | PRD 4.11 / TD 8 | Resolved in Docs |
| RT-07 | 浏览器适配过载 | BOSS + 通用降级；猎聘 P1 | PRD 6 | Resolved in Docs |
| RT-08 | 误区必出矛盾 | 诊断结果必出，误区有证据门 | PRD 4.8 / 11 | Resolved in Docs |
| RT-09 | 断点续跑伪承诺 | 记录恢复 + 固定输入重试 | PRD 9.7 / TD 10 | Resolved in Docs |
| RT-10 | 文档混杂 | 拆分七份文档 | PRD 0.2 | Resolved in Docs |
| RT-11 | 非目标城市未定义 | 全局画像、cityCode=null | PRD 5.2 | Resolved in Docs |
| RT-12 | JSON 批次过度设计 | 保留标准输入，删除长期批次领域 | PRD P0-03 / TD 4.1 | Resolved in Docs |

---

## 3. 明确删除或后移

| 项目 | 决定 | 目标版本/位置 |
|---|---|---|
| 猎聘专用字段适配 | 后移 | P1 |
| `/radar/imports` | 删除 | 不实现 |
| `radar_import_batches` | 删除 | 不实现 |
| `radar_application_marks` | 删除 | 不实现 |
| Candidate ignored/promoted 状态 | 删除 | Action/Promotion 派生 |
| AI 内部 ID 输出 | 删除 | 服务端 Envelope |
| 真正断点续跑承诺 | 删除 | 固定输入重试 |
| DeepSeek SSE 产品绑定 | 删除 | 技术实现自行选择 |
| 完整 SourceConfig/SourceRun | 后移 | v0.9 |
| 自动反馈画像进化 | 后移 | v0.9 |

---

## 4. 用户可见截图清单

- [ ] BOSS 扩展采集成功
- [ ] 通用可见文本降级预览
- [ ] 文本/JSON 导入预览
- [ ] CandidateVersion 历史与 Diff
- [ ] 数据质量与未知字段
- [ ] 透明规则命中原文
- [ ] 用户规则覆盖与撤销
- [ ] 单岗位分析四档建议
- [ ] stale 分析提示
- [ ] 0～8 条推荐
- [ ] 空推荐
- [ ] 正式误区诊断
- [ ] 证据不足诊断
- [ ] 收藏/忽略/重点/已投递
- [ ] 无回复不创建 Application
- [ ] 晋升预览与正式关联
- [ ] 任务失败、重试和刷新恢复

---

## 5. 发布授权追踪

| 动作 | 当前授权 |
|---|---|
| 冻结 PRD v2.1 | 未授权 |
| 开始 V8-1 实施 | 未授权 |
| 合并 main | 未授权 |
| 推送 main | 未授权 |
| Tag | 未授权 |
| Release | 未授权 |
