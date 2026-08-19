# OfferFlow v1.0

**Status:** PLANNED / BACKLOG
**Source:** Deferred from OfferFlow v0.9 Final Scope Freeze
**Scope Freeze Source Date:** 2026-08-19

## 1. Release Intent

OfferFlow v1.0 承接 v0.9 Final Scope Freeze 中主动移出的用户交互、通知与偏好学习能力。

v0.9 已冻结为 Daily Job Hunter Core：

DailySearchPlan
→ Scheduler
→ Active Discovery
→ Evidence
→ Analysis
→ Recommendation
→ DailyJobBrief

v1.0 不重新实现上述核心链路，而是在其上增加：

用户通知
→ 用户审批
→ 用户理由
→ 偏好学习
→ 后续搜索与推荐反馈闭环

本文件仅作为 Deferred Scope Backlog。

本轮不定义 v1.0 implementation plan、schema、migration 或具体技术实现。

---

## 2. Deferred Scope from v0.9

### 2.1 Notification / QQ SMTP

**来源：v0.9 T044–T051**

包含：

- NotificationChannel
- QQ SMTP Channel
- Secret-backed SMTP authorization
- NotificationOutbox
- Outbox Worker
- TEST_EMAIL
- HIGH_PRIORITY_ALERT
- DAILY_BRIEF
- RUN_FAILED
- ACTION_REQUIRED
- 有界 retry / backoff
- FAILED_FINAL / ACTION_REQUIRED 状态
- 邮件模板
- Notifications 页面
- Email Settings 页面
- 通知幂等

目标：

让 Daily Job Hunter 的结果可以主动汇报给用户，
但邮件失败不得影响 Discovery / Analysis / Recommendation / DailyBrief 主业务事实。

---

### 2.2 JobJudgment / 四档审批

**来源：v0.9 T052–T056**

包含：

- JobJudgment Repository
- JobJudgment API
- VERY_SUITABLE
- SOMEWHAT_SUITABLE
- NOT_VERY_SUITABLE
- VERY_UNSUITABLE
- JudgmentCard
- DailyBrief 审批流程
- 审批进度派生
- Judgment 修改 / supersede
- Judgment reason
- evidenceLevel-aware approval
- 智能追问
- 用户跳过 / 快速审批

目标：

将 DailyJobBrief 从"系统给结果"
升级为"系统汇报、用户逐条裁决"。

---

### 2.3 Preference Learning

**来源：v0.9 T057–T063**

包含：

- PreferenceSignal
- PreferenceRule
- Rule proposal
- EXPLICIT_CONFIRM
- THRESHOLD_AUTO
- PROPOSED
- HIGH_IMPACT rule confirmation
- Preference-aware Recommendation
- Preference-aware Search
- Repeated Mistake Protection
- Exploration slot
- Preference Rule API
- Preference UI
- Judgment 修改 / 撤销后的 preference recalculation

目标：

建立：

JobJudgment
→ PreferenceSignal
→ PreferenceRule
→ Search / Recommendation feedback

长期减少重复推荐用户已经明确不喜欢的岗位。

---

### 2.4 Cost Visibility Completion

来源：

v0.9 T043 / T072 中未完成的完整成本闭环。

v0.9 允许保留：

costSummaryJson = null / partial placeholder contract

v1.0 再完成：

- estimatedSearchCredits
- actualSearchCredits
- analysisCount
- model usage
- token usage
- actual cost
- DailyBrief cost presentation

不得为了成本展示重新设计 v0.9 已冻结的 Pipeline。

---

## 3. Deferred Production Validation

以下原 v0.9 验收项随对应能力迁移至 v1.0：

- SMTP failure matrix
- QQ SMTP real delivery
- Notification idempotency
- Email duplicate rate
- JobJudgment 修改 / 撤销
- Judgment → PreferenceSignal
- PreferenceRule proposal / activation
- Preference recalculation
- Repeated Mistake Rate
- Preference-aware recommendation
- Preference-aware search
- Cost Visibility 完整验收

v1.0 Production Validation 应基于已经冻结的 v0.9 Daily Job Hunter Core，
不得重新证明或重写 v0.9 Discovery 主链。

---

## 4. v0.9 Production Baseline

v1.0 的基础不是设计稿，而是已经通过真实生产路径的 v0.9 Core。

Production Run:

98ab9fc3-8fd0-4215-832e-b352fc01f223

Result:

- SourceRun = SUCCEEDED
- discovered = 277
- fetchAttempted = 50
- fetchSucceeded = 27
- validationPassed = 19
- evidenceUpgraded = 19
- analysisSucceeded = 6
- recommendationEligible = 6
- selected = 6
- analysisBlocked = 7
- analysisBlockedBy.SNAPSHOT_INVALID = 7
- stale_source_version = 0
- PIPELINE_FAILED = false

因此 v1.0 默认继承：

Active Discovery
Evidence Model
Content Acquisition
Evidence Upgrade
Analysis
Recommendation
DailyJobBrief

这些不是 v1.0 待重写模块。

---

## 5. Non-Goals of This Backlog

本文件不：

- 定义 v1.0 schema
- 创建 migration
- 定义 API contract
- 选择 SMTP library
- 设计 Preference algorithm
- 修改 v0.9 业务代码
- 启动 v1.0 implementation
- 承诺 v1.0 release date

这些必须在未来正式 v1.0 Spec / Plan 阶段决定。

---

## 6. Release Boundary

### OfferFlow v0.9

Daily Job Hunter Core

系统主动：

找岗位
→ 获取可信证据
→ 分析
→ 推荐
→ 生成 DailyBrief

### OfferFlow v1.0

Personal Job Agent

在 v0.9 基础上进一步实现：

主动汇报
→ 用户审批
→ 理由理解
→ 偏好学习
→ 后续主动搜索和推荐反馈闭环

---

**Backlog Status:** CREATED
**Implementation Status:** NOT STARTED
**Target Release:** OfferFlow v1.0
