# OfferFlow v0.7 阶段交接（2026-07-15，G2 → G3）

## 1. G2 签收事实

- 验收人：用户
- 验收日期：2026-07-15
- 验收内容：候选能力证据审核、正式证据库、AI/手工能力基线提案、无正式证据时阻止生成基线、支持证据/反证/待验证项同时保留、接受/修改后接受/拒绝/稍后处理、能力基线版本历史与版本激活均已通过人工测试。
- 未发现阻塞 G3 的产品问题。
- 截图归档尚未完成，明确列为 G6 统一归档项，不在 G2/G3 单独补齐。
- 详见 [`offerflow-v0.7-g2-candidate-evidence-capability-baseline.md`](../product/offerflow-v0.7-g2-candidate-evidence-capability-baseline.md)。

## 2. 当前实施顺序

1. G1 全局岗位匹配画像（已验收）
2. G2 CandidateEvidence 与 CapabilityBaseline（已验收）
3. **G3 历史补录与基础漏斗（本轮）**
4. G4 MarketPositionProfile 与 EvidenceSufficiency
5. G5 StrategyWindow 与正式策略 Proposal Review
6. G6 最终验收与发布

v0.7 仍禁止发布，App 版本继续保持 `0.6.2`。

## 3. G3 分支与起点

- 分支：`feat/v0.7.0-g3-history-funnel`
- 分支起点：`feat/v0.7.0-g2-capability-baseline` 分支 HEAD `3826656acaf3be873add03f8802ec7441f398098`（`fix: 禁止服务启动时自动升级真实数据库`）

## 4. G3 产品边界（摘要，完整规则见 PRD §6.5/§11/§19.3/§27）

- 历史补录两层结构：最小历史基线（默认弱证据/回忆来源）+ 详细事件补录（复用 Job Memory v2 正式事件枚举）。
- 草稿 → 预览 → 用户确认 → 事务性正式写入，未确认不污染 Job Memory。
- 未投递记录不得计入投递分母、拒绝或无回复统计。
- 同一岗位允许多条独立 Application；区分 accidental duplicate 与 legitimate separate process。
- 基础漏斗从正式 ApplicationProjection / FeedbackEvent 投影读取，不使用旧 `communicationStatus`，不保存可漂移的统计副本。
- 允许新增 schema v4（纯新增表），但真实数据库 `data/offerflow.sqlite3` 本轮禁止升级；只在临时/内存库验证。

## 5. 未改变的结论

- v0.7 仍禁止发布、禁止合并 main、禁止升级版本、禁止创建 PR/Tag/Release。
- G4、G5 尚未开始，不得在本轮被宣称完成。

## 6. G3 产品收口纠正（2026-07-15 补充）

工程主体（schema v4、history-import 领域/server、funnel 领域/server、前端页面与路由）已实现，且自动化测试全绿，但用户实际验收发现：

- 历史补录页面无法进入完整流程验收（真实入口默认关闭历史补录，此前未提供隔离验收环境）；
- 基础漏斗页面默认把城市+具体岗位标题+渠道拼成复合分组，每组仅 1 条流程，不是有效的总览/分组漏斗；缺少岗位族、可信度总览、终态分布与单维分组。

因此：

- **G3 未验收**。测试全绿、工程实现完成，不等同于产品验收通过；此前如有任何交付报告将 G3 描述为“全部完成”，均以本节为准予以纠正。
- 历史补录真实库入口继续保持关闭（不升级 `data/offerflow.sqlite3` 到 v4）；新增隔离 sandbox 环境供用户人工验收，不影响真实数据。
- 基础漏斗信息架构（总览优先、单维分组、岗位族、可信度、终态分布、明细钻取）在本轮产品收口中重做。
- v0.7 继续禁止发布；不得在本节以外的任何位置提前标记 G3“已验收”。

## 7. 真实数据库受控升级与生产烟测（2026-07-15 补充）

- 真实数据库 `data/offerflow.sqlite3` 已使用仓库既有的 `scripts/upgradeRealDatabase.ts`（`--confirm --expected-source-fingerprint=... --backup-dir=backups/history-funnel`）由 schema v3 受控升级到 v4；升级前独立备份并校验哈希、完整性、行数一致，升级后经工具自带校验与 `scripts/v070VerifyReal.ts`（`verifierBusinessWrites=0`）只读复核，均通过。
- 正式环境入口已开放历史补录：`server/index.ts` 的生产 `buildServer()` 增加 `historyImport: { enabled: true }`；`src/config/features.ts` 的 `historyImportEnabled` 默认值改为 `true`；G3 sandbox（`scripts/devG3Sandbox.ts`、独立测试库、sandbox 提示）保持不变。
- 已完成不写正式业务数据的最小生产烟测：岗位台账、岗位匹配画像（G1）、能力基线（G2）、基础漏斗（已投递=9，与升级前一致）均可正常查看；历史补录导航与页面可正常进入；创建一个空草稿会话并验证可重新进入、随后丢弃，丢弃后会话状态为 `discarded`；`jobs`/`applications`/`feedback_events` 行数在烟测前后均保持 15/9/11 不变；浏览器控制台与后端日志均无异常。
- Snapshot v4 尚未发布，未执行 `snapshot:check` 的发布动作（该命令当前预期为非绿，属已知的正式数据漂移，非阻塞项）。
- **G3 仍未正式验收**：本节仅记录真实库受控升级与生产烟测已完成，产品逻辑此前已在 sandbox 中经用户验收，但本轮未新增用户对生产环境的最终签收动作；G3 最终签收、Snapshot 发布、合并 main、进入 G4，均等待用户后续明确裁决。
