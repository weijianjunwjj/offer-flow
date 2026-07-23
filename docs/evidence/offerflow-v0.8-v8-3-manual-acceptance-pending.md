# V8-3 人工评审工作台 · 人工验收证据（已验收）· v2

**状态：ACCEPTED / ACTIVATION PENDING**

本轮 MA-01～MA-04 由受控评审沙箱（schema v8、非生产、会话级临时库）操作采集，
用户复核已完成，验收结论为 ACCEPTED（采用下述证据例外）。

## 最终验收口径

- V8-3 = ACCEPTED / ACTIVATION PENDING
- RC-05 = Done；RC-06 = Done
- schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
- 生产 schema = v7；Radar 正式入口 = DISABLED
- 生产 v8 激活仍需独立授权（BR-1），本轮未执行

## 验收证据例外

- MA-01、MA-02 静态截图受内层滚动容器裁切，未能完整呈现全部区域；
- 相关能力已经由真实浏览器验证、Review Playwright E2E、组件测试、API 测试和审计数据共同证明；
- MA-03、MA-04 静态证据完整；
- 不再补拍截图；
- 此例外不影响最终验收结论。

## v2 修订说明（相对上一版证据）

上一版证据基于旧 fixture，且记载“工作台 UI 无独立 signals 字段”。本轮功能提交后：

- 工作台**已渲染**结构化「疑似重复信号」区（signalType / field / 双方值 / strength / explanation），
  故 MA-01 截图与描述据实更新，旧“无 signals 字段”表述作废。
- MA-02 改为从「已确认不同」筛选重开 `rvsb-22` 详情，展示用户裁决原因 + 裁决审计时间线
  （文件名 `v8-3-ma-02-confirmed-distinct-detail.png`）。
- MA-04 override 审计目标为专用评估 `rvsb-77`（salary_ceiling），set→revert 终态 none
  （文件名 `v8-3-ma-04-rule-evidence-override-audit.png`）。
- 所有数值取自本轮运行中的 v2 证据 sandbox 只读查询与生产库只读核验，未沿用旧值。

## 采集环境

- 入口：受控评审沙箱 `#/radar/review`（flag 打开、schema v8 临时库，非生产，端口 17395/17396）
- 全新独立临时 v8 库，重新 seed 同一确定性 fixture（ID 前缀 `rvsb-*`），与生产库完全隔离
- 生产数据库仅只读核验，未执行任何写入
- 时间来自确定性 fixture 时钟，仅用于可重复验收，不代表真实生产时间（UI 显示 1970 属预期）

## 截图落盘清单

| 文件 | 覆盖 | 说明 |
|---|---|---|
| `v8-3-ma-01-duplicate-comparison.png` | MA-01 | suspected_duplicate 并排对比 + 4 条结构化信号 + 确认相同/确认不同 |
| `v8-3-ma-02-confirmed-distinct-detail.png` | MA-02 | confirmed_distinct 详情：用户原因 + 裁决审计时间线（重开自筛选） |
| `v8-3-ma-03-change-and-conflict.png` | MA-03 | material_change 变化字段 + identity_conflict 内联冲突/阻断 |
| `v8-3-ma-04-rule-evidence-override-audit.png` | MA-04 | 规则证据三态 + salary_ceiling override set→revert 审计 |

**保持 USER REVIEW PENDING 的瞬时态（不伪造重建）：** 提交成功 toast、二次确认弹窗等交互瞬时态
未持久化为截图，其结果由数据库审计动作交叉佐证（见审计 JSON）。

## MA-01 疑似重复对比与结构化信号

- suspected_duplicate 候选对：`rvsb-5`（同城科技）× `rvsb-10`（同城科技(分部)）
- 两侧全字段：公司 / 岗位（前端工程师）/ 城市（苏州）/ 薪资（15-25K/month）/ 学历（本科）/ 经验（3-5年）
- 结构化「疑似重复信号」4 条（signalType · field · A/B 值 · 强度 · 说明）：
  - `company_name_similar` · company · 同城科技 ｜ 同城科技(分部) · 0.86 · 公司名高度相似
  - `role_title_equal` · role · 前端工程师 ｜ 前端工程师 · 1 · 岗位标题完全一致
  - `same_city` · city · 苏州 ｜ 苏州 · 1 · 工作城市相同
  - `same_salary_range` · salary · 15-25K/月 ｜ 15-25K/月 · 1 · 薪资区间相同
- 「确认相同」「确认不同」按钮均可用

## MA-02 确认不同（confirmed_distinct）详情

- 关系 `rvsb-22`：`rvsb-15`（蓝鲸网络）× `rvsb-20`（蓝鲸传媒），终态 `confirmed_distinct`
- 用户裁决原因：`两家为不同法人主体，虽同名但注册地与招聘主体不同`
- 裁决审计时间线：`确认不同 → confirmed_distinct`（RadarAction `duplicate_rejected`）
- 已移出默认待处理列表，经「已确认不同」筛选可重开并保持

## MA-03 变化与冲突

- material_change（候选版本 `rvsb-44`）changedFields：
  - `salaryMinK` 15 → 20（changed_fact / value_changed）
  - `salaryMaxK` 25 → 35（changed_fact / value_changed）
- identity_conflict：冲突原因 `tier2_multiple_matches`；阻断 `identity_conflict: tier2_multiple_matches`
  （该 feed 项无候选、打开按钮禁用，属设计预期）

## MA-04 规则证据三态与 override 审计

- RuleEvidence 三态：`structured`（salary_floor `rvsb-71`，sha256 `357bcdec…`）、
  `legacy_scalar`（city_whitelist `rvsb-72`，evidence_json NULL）、
  `corrupt`（commute_radius `rvsb-73`，sha256 `55ac744f…`，损坏原因：evidence_json 未通过契约校验）
- override 审计目标：`salary_ceiling`（评估 `rvsb-77`）none → pass → none
  - `rule_override_set`：原因「经复核该薪资上限可接受」
  - `rule_override_reverted`：原因「策略调整，恢复规则默认判定」
- 原 RuleAssessment 保持不变：result=`hit`，evidence_json sha256 `e7f8489accdb…`
  （明示“原始规则评估未被覆盖操作修改（覆盖仅追加审计事件）”）

## 数据不变量（只读核验）

### 人工验收 sandbox（schema v8，会话级临时库，非生产）

- jobs = 0；applications = 0；feedback_events = 0（评审未创建正式记录）
- candidates = 11 未减少（confirmed_same 不物理合并）；candidate_versions = 12；rule_assessments = 6
- 原 RuleAssessment 未被 UPDATE 或删除（E2E 全表行签名断言佐证）

### 真实生产数据库（`data/offerflow.sqlite3`，仅只读核验）

- schema version = 7（schema_migrations MAX 与 app_meta.schema_version 一致）
- jobs = 15；applications = 9；feedback_events = 11
- `radar_candidate_relations` 表不存在（v8 relations schema 未激活）
- 未执行 migration；未发生写入；仅只读核验

## 验收结论

用户已复核上述截图与审计 JSON，V8-3 / RC-05 / RC-06 验收结论为 ACCEPTED（采用上述证据例外，
`passed=true`、`acceptanceStatus=accepted_activation_pending`）。生产 schema 仍为 v7、Radar 正式入口
仍 DISABLED，生产 v8 激活需独立授权（BR-1）后另行执行。审计明细见
[offerflow-v0.8-v8-3-manual-acceptance-audit.json](offerflow-v0.8-v8-3-manual-acceptance-audit.json)。
