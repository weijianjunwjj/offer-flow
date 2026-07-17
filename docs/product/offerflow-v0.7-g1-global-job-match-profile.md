# OfferFlow v0.7 G1 全局岗位匹配画像

- 日期：2026-07-14
- 分支：`feat/v0.7.0-g1-global-job-match-profile`
- App 版本：`0.6.2`
- 状态：G1 已由用户验收；v0.7 仍禁止发布

## 0. G1 验收记录

- 验收人：用户
- 验收日期：2026-07-15
- 验收结果：G1 五视图（全局岗位匹配画像 + 苏州 / 无锡 / 上海 / 杭州四城市视图）与提案审核（手工提案、AI 提案、接受、修改后接受、拒绝、稍后处理、正式版本与版本历史）全部通过。
- 未发现阻塞 G2 的问题。
- 未改变 v0.7 发布结论：v0.7 仍禁止发布、禁止合并 main、禁止升级版本或创建 PR/Tag/Release。
- 下一阶段：G2（CandidateEvidence 与 CapabilityBaseline）。

范围界定：G1 全局岗位匹配画像属于用户可见的 MVP，已实现并由用户验收；它不等于 G4。正式 MarketPositionProfile 与 EvidenceSufficiency（四城独立画像、三档岗位区间与多维充分性计算）仍属于 G4，尚未完成。G1 验收只覆盖岗位匹配画像 MVP 子集，不代表 G4 正式市场画像与充分性门禁已完成。

## 1. 用户批准的实施顺序调整

用户明确批准：

> 全局岗位匹配画像作为下一阶段优先交付；历史补录与基础漏斗后移，但仍保留在 v0.7 发布范围内。

当前顺序固定为：

1. G1 全局岗位匹配画像 MVP
2. G2 CandidateEvidence 与 CapabilityBaseline
3. G3 历史补录与基础漏斗
4. G4 正式 MarketPositionProfile 与 EvidenceSufficiency
5. G5 StrategyWindow 与 Proposal Review
6. G6 最终产品验收与发布

本调整只改变实施顺序，不删除、延期到 v0.8 或降低任何 v0.7 发布结果。

## 2. G1 产品边界

G1 在 `/job-match-profile` 提供：

- 全局岗位定位；
- 苏州、无锡、上海、杭州四个独立视图；
- 冲刺、主攻、稳妥岗位区间；
- 核心优势、待验证能力、主要限制；
- 理想公司与团队环境、可接受范围；
- 支持证据、反证、最大不确定性；
- 样本不足、探索性、可行动三种置信状态；
- Proposal Review 与版本历史。

G1 是用户可见的岗位匹配画像 MVP，不冒充 G2 的正式长期能力基线，也不冒充 G4 的正式市场画像和多维充分性计算。

## 3. 持久化和 Human-in-the-loop

- 不新增表、schema 或 migration。
- 使用 Profile `data_json` 的 `jobMatchProfileState` 扩展保存状态。
- 状态包含 `stateVersion`、`activeVersionId`、`proposals`、`versions`。
- 已激活版本不可原地修改；接受新提案生成新版本。
- 手工与 AI 使用同一严格 Draft Schema。
- AI 只生成 proposal；用户可直接接受、修改后接受、拒绝或稍后处理。
- 未确认 proposal 不影响正式画像。
- API 写入使用 `expectedStateVersion` 做乐观并发检查。

## 4. 四城市隔离

能力、项目和技术栈事实可以跨城市复用。薪资、供给、回复/面试转化、学历门槛、公司偏好与渠道表现不得跨城市混算。

借用证据必须包含来源城市、借用原因、权重与不适用范围。样本不足时仍显示探索性草案，但禁止正式降薪、降级或下调长期定位。

## 5. 当前实现

- 领域 Schema、提案状态机、版本激活与历史切换；
- Profile JSON API 与乐观并发；
- 复用现有 LLM Provider 的 AI proposal 接口；
- 一级路由和导航；
- 全局与四城市页面；
- Proposal Review：接受、修改后接受、拒绝、稍后处理；
- 版本历史和默认折叠技术信息；
- 领域测试与 `job-match-profile:smoke`。

## 6. 未解除的 Gate

以下完成前，G1 不得宣告验收完成：

- typecheck、目标测试、完整测试、build 与 selftest 全部通过；
- 页面真实挂载验证；
- 七张验收截图完成；
- 用户验收全局和四城市五个视图。

本分支不得合并 main、创建 PR、升级版本、Tag 或 Release。不得在 G1 中实现历史漏斗、正式 CapabilityBaseline、正式 MarketPositionProfile 或 StrategyWindow。
