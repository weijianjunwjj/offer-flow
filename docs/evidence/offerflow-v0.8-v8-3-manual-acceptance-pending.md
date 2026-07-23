# V8-3 人工评审工作台 · 人工验收证据（待用户复核）

**状态：EVIDENCE CAPTURED / USER REVIEW PENDING**

本轮 MA-01～MA-04 由受控评审沙箱（schema v8、非生产、会话级临时库）操作采集，
最终用户复核仍待完成。执行者不得仅凭自身操作报告将验收门改为 Done。

## 冻结口径（本文件不改变任何状态）

- V8-3 = IMPLEMENTATION COMPLETE / MANUAL ACCEPTANCE PENDING
- RC-05 = Partial；RC-06 = Partial
- schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
- 生产 schema = v7；Radar 正式入口 = DISABLED

## 采集环境

- 入口：受控评审沙箱 `#/radar/review`（flag 打开、schema v8 临时库，非生产）
- 生产数据库仅进行只读核验，未执行任何写入
- 关联标识：relation `rvsb-11`；candidate `rvsb-5` / `rvsb-10`；
  material 候选版本 `rvsb-44`；override 评估 `rvsb-76`（education_floor）

## 截图落盘情况（如实）

截图来自两处，须区分：

- **当前验收 sandbox**（承载真实验收痕迹：rvsb-11=confirmed_distinct、三条 RadarAction）：MA-02 / MA-03 / MA-04 三张
- **独立证据专用 sandbox**（全新临时 v8 库、重新 seed 同一确定性 fixture、与验收 sandbox 及生产库完全隔离、截图后停止并清理临时库）：MA-01 一张

MA-01 原图在会话内曾生成但**未持久化**，且验收 sandbox 中该关系已 confirmed_distinct 移出默认列表、UI 无历史视图，无法在不改验收数据下重开，故按边界在独立证据 sandbox 重现补拍（未修改验收 sandbox、未连接生产库）。

| 文件 | 覆盖 | 来源 | 说明 |
|---|---|---|---|
| `v8-3-ma-01-duplicate-comparison.png` | MA-01 | 证据 sandbox | suspected_duplicate 并排对比 + 全字段 + 确认相同/确认不同按钮 |
| `v8-3-ma-02-list-after-confirm-distinct.png` | MA-02 终态 | 验收 sandbox | 待处理列表仅剩 needs_recheck（suspected 已移除，刷新后保持） |
| `v8-3-ma-03-change-and-conflict.png` | MA-03 | 验收 sandbox | material_change 变化字段 + identity_conflict 内联冲突/阻断 |
| `v8-3-ma-04-rule-evidence-override.png` | MA-04 | 验收 sandbox | 规则证据三态 + override 标签（education_floor 撤销后 none 终态） |

**仍未持久化 / 保持 USER REVIEW PENDING 的中间态截图（瞬时态，不伪造重建）：**
- MA-02「确认不同已完成」toast + 填原因二次确认弹窗
- MA-04 override 设置/撤销的成功 toast 与 none→pass→none 过程弹窗

以上瞬时态在交互会话中实际出现过，其结果以数据库审计动作交叉佐证（见审计 JSON）。

> 关于 signals：当前工作台 UI 未渲染独立的 “signals” 字段（组件/fixture/API 均无该字段）；
> 岗位识别信号通过 decisionType 标签（如 new_identity）与关系状态呈现，MA-01 截图已含这些标签。

## MA-01 疑似重复对比

- suspected_duplicate 候选对：`rvsb-5`（同城科技）× `rvsb-10`（同城科技(分部)）
- 两侧字段：公司 / 岗位（前端工程师）/ 城市（苏州）/ 薪资（15-25K/month）/ 学历（本科）/ 经验（3-5年）
- decisionType 标签（new_identity）与 suspected_duplicate 状态可见
- 「确认相同」「确认不同」按钮均可用（截图含底部动作区）
- 截图：`v8-3-ma-01-duplicate-comparison.png`（独立证据 sandbox 补拍，非验收 sandbox）
- signals 非工作台独立 UI 字段（见上方说明）

## MA-02 确认不同（confirmed_distinct）

- 用户原因：`两家为不同法人主体，虽同名但注册地与招聘主体不同`
- 关系终态：`confirmed_distinct`（relation `rvsb-11`）
- RadarAction：`duplicate_rejected` @ `1784786712509`
- 提交后移出默认待处理列表；刷新后仍保持（截图：`v8-3-ma-02-list-after-confirm-distinct.png`）
- 成功 toast 与二次确认弹窗为瞬时态，未持久化 → PENDING

## MA-03 变化与冲突

- material_change（候选版本 `rvsb-44`）changedFields：
  - `salaryMinK` 15 → 20（classification：changed_fact / value_changed）
  - `salaryMaxK` 25 → 35（classification：changed_fact / value_changed）
- identity_conflict：冲突原因 `tier2_multiple_matches`；阻断 `identity_conflict: tier2_multiple_matches`
  （该 feed 项无候选、打开按钮禁用，属设计预期）
- 截图：`v8-3-ma-03-change-and-conflict.png`

## MA-04 规则证据与 override

- RuleEvidence 三态：`structured`（salary_floor / education_floor）、`legacy_scalar`（city_whitelist）、
  `corrupt`（commute_radius，损坏原因：evidence_json 未通过契约校验）
- structured 字段可见：rawValue（原值 20）、normalizedValue（规范化 20）、confidence（置信度 0.92）、
  excerpt（摘要）、explanation（说明）
- override：`education_floor`（评估 `rvsb-76`）none → pass → none
  - `rule_override_set` @ `1784786791559`
  - `rule_override_reverted` @ `1784786843660`
- 原 RuleAssessment 保持不变：result=`hit`，evidence_json SHA-256 = `2ec8b49b501eae39c87e2fe6bd1d6d931a7b212edf4158b6d81d0e60e2270cce`
- 截图：`v8-3-ma-04-rule-evidence-override.png`（override 撤销后 none 终态；过程弹窗为瞬时态 → PENDING）

## 数据不变量（只读核验）

两套数据库须分开表述，切勿混淆：

### 人工验收 sandbox（schema v8，会话级临时库，非生产）

- 验收前后 jobs = 0；applications = 0；feedback_events = 0
- 人工评审操作没有创建正式 Job / Application / FeedbackEvent
- Candidate 未被 confirmed_same 物理合并（candidates = 11 未减少）
- 原 RuleAssessment 未被 UPDATE 或删除

### 真实生产数据库（`data/offerflow.sqlite3`，仅只读核验）

- schema version = 7
- jobs = 15；applications = 9；feedback_events = 11
- 原有数据行数未变化；未执行 migration；未发生写入
- 仅进行只读核验，未执行任何写入

## 待办

用户复核上述截图与审计 JSON 后，方可决定是否推进 V8-3 / RC-05 / RC-06 状态。
在此之前一律保持 Partial / PENDING。审计明细见
[offerflow-v0.8-v8-3-manual-acceptance-audit.json](offerflow-v0.8-v8-3-manual-acceptance-audit.json)。
