# OfferFlow v0.7 最终验收矩阵

- 日期：2026-07-16
- 上位契约：`docs/product/offerflow-v0.7-release-contract.md`
- 状态口径：`engineeringVerified`（工程测试通过）/ `rehearsalVerified`（生产候选副本演练通过）/ `userRequired`（需用户在真实/演练环境确认）/ `productionRequired`（需 G6-B 真实生产切换后才能确认）/ `blocked`（被阻塞）。
- 规则：**G6-A 不得把任何 `productionRequired` 项标为通过。**

## G1 岗位匹配画像

| 验收点 | 状态 | 证据 |
|---|---|---|
| active 岗位匹配画像可读取 | rehearsalVerified | 候选烟测 `/strategy/current` 输入版本引用 + G5 window.sourceVersionIds |
| 四城市隔离 | engineeringVerified | G1/G4 既有测试；G6 未改语义 |
| proposal / version 流转 | engineeringVerified | G1 既有测试（已用户验收 2026-07-15） |

## G2 能力基线

| 验收点 | 状态 | 证据 |
|---|---|---|
| accepted evidence 完整 | rehearsalVerified | 晋升导出校验 evidence ⊆ accepted；候选库 candidate_evidence 行数保持 |
| active 能力基线 | engineeringVerified | G2 既有测试（已用户验收 2026-07-15） |
| 证据引用完整 | engineeringVerified | 晋升包 evidence 引用校验 |

## G3 历史补录与基础漏斗

| 验收点 | 状态 | 证据 |
|---|---|---|
| 历史补录 | engineeringVerified | G3 既有测试（真实库已 v4，已用户验收 2026-07-15） |
| 基础漏斗 | rehearsalVerified | 候选库 applications=9 / feedback_events=11 迁移后保持 |
| 终态与可信度 | engineeringVerified | funnel 既有测试 |

## G4 市场位置画像

| 验收点 | 状态 | 证据 |
|---|---|---|
| active 市场位置 V1 | rehearsalVerified | 晋升包 `g4ActiveVersionId=BCO_OHOKj4z4SZ7fkBaTC`，候选库导入后可读 |
| EvidenceSufficiency | engineeringVerified | G4 既有测试（已用户验收 2026-07-16） |
| DecisionGate | engineeringVerified | G4 既有测试 |
| 四城市视图 | userRequired | G6 候选环境用户复核（读侧） |
| AI 叙事受规则锁定 | engineeringVerified | G4/G5 AI 守卫测试 |

## G5 求职策略

| 验收点 | 状态 | 证据 |
|---|---|---|
| active StrategyWindow | rehearsalVerified | 晋升包 `g5ActiveWindowId=sw-069343080027d893`，候选库导入后可读，为证据收集窗口 |
| active StrategyVersion V1 | rehearsalVerified | 晋升包 `g5ActiveVersionId=WBvQlz3yIigQ4o2bPv8Wj`，`generationMode` 与 `decisionDiff` 保留 |
| 三类边界 | engineeringVerified | G5 既有测试（已用户验收 2026-07-16） |
| 行动清单 / 实验计划 | engineeringVerified | G5 既有测试 |
| AI 不修改门禁 | engineeringVerified | G5 AI overlay 守卫测试（`2038e54`/`6ba6c9d`） |
| 不自动执行 | engineeringVerified | 服务层无自动行动执行路径 |

## 全局非回归

| 验收点 | 状态 | 证据 |
|---|---|---|
| Job 行数不变 | rehearsalVerified | 演练报告 memoryCountsUnchanged=true（jobs=15） |
| Application 行数不变 | rehearsalVerified | applications=9 保持 |
| FeedbackEvent 行数不变 | rehearsalVerified | feedback_events=11 保持 |
| G1~G5 路由可达 | userRequired | G6 候选环境读侧烟测 |
| 普通用户字段不暴露 UUID/hash/rowVersion | engineeringVerified | G1~G5 页面既有断言 |
| App 版本仍 0.6.2 | engineeringVerified | package.json 未改 |
| 不存在自动 Boss 投递 | engineeringVerified | 代码无自动投递路径 |
| 不存在自动降薪/迁移/辞职/放弃方向 | engineeringVerified | G5 门禁与禁止措辞守卫 |
| AI 只在明确点击时调用 | engineeringVerified | 服务不在启动/测试中调用真实模型 |

## 真实生产项（G6-B，本轮不得标为通过）

| 验收点 | 状态 |
|---|---|
| 真实库 v4→v6 受控升级 | productionRequired |
| 正式生产入口开启 G4/G5 | productionRequired |
| 真实环境全链路烟测 | productionRequired |
| Snapshot 契约裁决执行 | productionRequired |
| 发布授权（push / main / Tag / Release） | productionRequired |
