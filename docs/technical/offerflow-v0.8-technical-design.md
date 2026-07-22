# OfferFlow v0.8 Technical Design

> **技术设计版本：** 1.0  
> **对应 PRD：** v2.1  
> **状态：** 已冻结；V8-2 已关闭并冻结（生产 schema v7 已受控激活，Radar 正式入口关闭）
> **原则：** SQLite + Node.js + Vue 3；不引入独立 Worker、消息队列或平行业务体系

---

## 1. 设计目标

1. 让原始来源、标准化事实、规则、AI 结果、用户动作与正式记忆可追溯；
2. 让历史输入不可被 UPDATE 覆盖；
3. 让 AI 作为不可信外部计算器，只返回业务 Payload；
4. 让页面刷新与进程重启不丢记录，但不伪装成真正断点续跑；
5. 让 v0.9 直接复用 v0.8 领域对象。

---

## 2. 逻辑架构

```text
Browser Extension / OfferFlow Import UI
                ↓
Capture Session（短期预览）
                ↓ commit
CaptureSnapshot（不可变）
                ↓
SourceRecord（来源身份与多次发现）
                ↓ N:M
RadarCandidate（生命周期聚合根）
                ↓ active_version_id
RadarCandidateVersion（不可变标准化事实）
       ├─ RuleAssessment
       ├─ AnalysisTask → JobMatchAnalysisRecord
       ├─ RadarAction
       └─ RadarRecommendationBatch
                         ↓
                  RadarPromotion
                         ↓
          Job / Application / FeedbackEvent
```

---

## 3. 核心不变量

### INV-01 快照不可变

`radar_capture_snapshots` 原始内容写入后不可修改。若采集内容改变，创建新快照。

### INV-02 CandidateVersion 不可变

标准化字段、质量问题、来源快照集合、内容 hash 写入后不可修改。手动纠错创建新版本。

### INV-03 Candidate 只保存生命周期

不保存 analyzing、ignored、promoted 等混合状态。

### INV-04 所有判断引用 candidate_version_id

规则、分析、动作、推荐与晋升必须绑定明确版本 ID，禁止只保存松散 hash。

### INV-05 AI 不决定挂载关系

Candidate ID、版本 ID、上下文版本、input hash、模型与审计字段由服务端生成。

### INV-06 无回复不进入正式负反馈

任何 `marked_applied_pending` 和超期均不得自动创建拒绝、负向 CandidateEvidence 或画像降级。

### INV-07 推荐默认只使用 current 分析

stale 分析只能作为旧版本参考，不得进入正式推荐计算。

---

## 4. 数据模型

具体命名可按仓库约定调整；领域边界不得改变。

### 4.1 `radar_capture_sessions`（短期技术对象）

用于 preview → correction → commit，不是长期产品领域。

```text
id
source_type                 browser | pasted_text | shared_link_and_text | json
status                      preview | committed | cancelled | expired
raw_input_json
preview_items_json
created_at
expires_at
committed_at
```

其中 `pasted_text` / `shared_link_and_text` / `json` 仅为已落库枚举和历史数据读取的 legacy compatibility。
当前产品入口只创建 `browser` 会话，不再暴露任何手工 JD 文本、链接组合或 JSON 导入入口。

约束：

- TTL 到期可清理；
- commit 必须幂等；
- committed session 不得再次生成重复快照；
- 不在导航中提供长期“导入批次”页面。

### 4.2 `radar_capture_snapshots`

```text
id
capture_session_id nullable
capture_method
provider_key nullable
provider_version nullable
source_domain nullable
source_url nullable
normalized_source_url nullable
external_record_id nullable
page_title nullable
visible_text
raw_snapshot_json
raw_content_hash
captured_at
created_at
```

索引建议：

- `(provider_key, external_record_id)`；
- `normalized_source_url`；
- `raw_content_hash`；
- `captured_at`。

### 4.3 `radar_source_records`

来源身份聚合，不保存标准化岗位事实。

```text
id
provider_key nullable
external_record_id nullable
normalized_source_url nullable
first_seen_at
last_seen_at
last_changed_at nullable
latest_snapshot_id
source_status               active | unknown
created_at
updated_at
```

唯一性：

- 稳定来源存在时，优先 `(provider_key, external_record_id)`；
- URL 只能作为次级身份，不能在所有来源上强行唯一。

### 4.4 `radar_candidates`

```text
id
primary_source_record_id nullable
active_version_id
lifecycle_status          active | merged | archived
merged_into_candidate_id nullable
created_at
updated_at
```

规则：

- `merged` 必须有 `merged_into_candidate_id`；
- `active` 不得有 `merged_into_candidate_id`；
- ignored/promoted 不得写入该表。

### 4.5 `radar_candidate_versions`

```text
id
candidate_id
version_no
normalized_json
quality_issues_json
source_snapshot_ids_json
content_hash
origin_type               captured | manual_correction | source_change | merge_resolution
correction_note nullable
supersedes_version_id nullable
created_at
```

唯一性：

- `(candidate_id, version_no)`；
- 同 candidate 下相同 `content_hash` 默认不创建新版本；
- `active_version_id` 必须指向同 candidate 的版本。

版本创建规则：

- 纯空白、排版、导航噪声变化：不创建；
- 薪资、地点、职责、要求、岗位性质或主要技术栈变化：创建；
- 用户修正任何标准化字段：创建；
- 合并裁决造成标准化事实变化：创建。

### 4.6 `radar_candidate_sources`

```text
candidate_id
source_record_id
first_linked_at
last_confirmed_at
link_reason                 primary | confirmed_duplicate | probable_confirmed | manual
```

主键：`(candidate_id, source_record_id)`。

### 4.7 `radar_rule_assessments`

系统规则结果不可变。

```text
id
candidate_id
candidate_version_id
rule_version
rule_key
category                    hard_constraint | risk | preference | state_suppression
severity
result                      hit | pass | unknown
matched_text nullable
source_path nullable
explanation
created_at
```

用户覆盖不 UPDATE 本表，由 RadarAction 记录：

```text
action_type = rule_override_set | rule_override_reverted
metadata.ruleAssessmentId
metadata.decision
metadata.reason
```

### 4.8 `analysis_tasks`

```text
id
task_type                    job_match_analysis | recommendation_batch
entity_type
entity_id
status                       queued | running | succeeded | failed | cancelled
input_hash
input_snapshot_json
attempt_count
max_attempts
started_at nullable
finished_at nullable
cancelled_at nullable
error_code nullable
error_message nullable
result_record_id nullable
created_at
updated_at
```

建议错误码：

- `INPUT_NOT_READY`；
- `INPUT_STALE_BEFORE_START`；
- `PROVIDER_TIMEOUT`；
- `PROVIDER_NETWORK_ERROR`；
- `PROVIDER_RATE_LIMIT`；
- `SCHEMA_INVALID`；
- `STRUCTURE_REPAIR_FAILED`；
- `CANCELLED_BY_USER`；
- `PROCESS_RESTART_INTERRUPTED`；
- `RESULT_WRITE_FAILED`；
- `CONFIGURATION_ERROR`。

### 4.9 `job_match_analysis_records`

服务端审计 Envelope：

```text
id
candidate_id
candidate_version_id
resume_version_id
job_match_profile_version_id
city_code nullable
capability_baseline_version_id nullable
market_position_version_id nullable
strategy_version_id nullable
rule_version
prompt_version
analysis_policy_version
model_provider
model_name
model_version nullable
input_hash
recommendation
confidence
payload_json
created_at
supersedes_analysis_id nullable
```

唯一约束建议：`input_hash`。

AI Payload：

```ts
interface JobMatchAiPayload {
  schemaVersion: '1.0'
  jobFacts: Array<{
    statement: string
    sourcePath: string
  }>
  dimensions: {
    roleFit: MatchDimension
    capabilityFit: MatchDimension
    businessAndCompanyFit: MatchDimension
    cityAndSalaryFit: MatchDimension
  }
  transferableEvidence: EvidenceReference[]
  gaps: AnalysisPoint[]
  risks: AnalysisPoint[]
  counterEvidence: AnalysisPoint[]
  uncertainties: AnalysisPoint[]
  recommendation: 'apply_now' | 'stretch' | 'verify' | 'skip'
  confidence: 'low' | 'medium' | 'high'
  summary: string
  recruiterQuestions: string[]
  communicationAngles: string[]
}
```

Payload 禁止包含数据库 ID、上下文版本、hash 与模型信息。

### 4.10 `radar_recommendation_batches`

```text
id
batch_key
status                       succeeded | failed
scope_json
candidate_version_ids_json
selected_candidate_version_ids_json
profile_versions_json
rule_version
recommendation_rule_version
analysis_policy_version
handled_state_hash
diagnosis_status             formed | insufficient_evidence
diagnosis_payload_json
empty_reason nullable
generated_at
created_at
```

`diagnosis_payload_json` 作为批次附属结果，不另建长期诊断主实体。

### 4.11 `radar_actions`

追加式用户事实流水。

```text
id
candidate_id
candidate_version_id
action_type
reason_code nullable
reason_text nullable
metadata_json
occurred_at
reverted_by_action_id nullable
created_at
```

动作类型：

```ts
type RadarActionType =
  | 'saved'
  | 'unsaved'
  | 'ignored'
  | 'ignore_reverted'
  | 'marked_priority'
  | 'priority_reverted'
  | 'marked_applied_pending'
  | 'applied_pending_reverted'
  | 'rule_override_set'
  | 'rule_override_reverted'
  | 'promotion_requested'
```

`marked_applied_pending` metadata：

```json
{
  "appliedAt": 0,
  "followUpDueAt": null,
  "sourceSnapshotId": "...",
  "channel": "boss"
}
```

不存在 `radar_application_marks`。

### 4.12 `radar_promotions`

```text
id
candidate_id
candidate_version_id
promotion_type               job_only | application | feedback
job_id
application_id nullable
feedback_event_id nullable
trigger_action_id nullable
idempotency_key
created_at
```

唯一约束：`idempotency_key`。

---

## 5. 标准化与变化识别

### 5.1 标准字段

```ts
interface RadarCandidateNormalized {
  company: string | null
  role: string | null
  city: string | null
  district: string | null
  salaryMinK: number | null
  salaryMaxK: number | null
  salaryPeriod: string | null
  experienceRequirement: string | null
  educationRequirement: string | null
  companySize: string | null
  industry: string | null
  jobNature: string | null
  workMode: string | null
  technicalStack: string[]
  responsibilities: string[]
  requirements: string[]
  publishedAt: number | null
  rawDescription: string
}
```

### 5.2 身份优先级

```text
providerKey + externalRecordId
→ normalizedSourceUrl
→ normalized content hash
→ company + role + city + salary + JD similarity
→ user decision
```

### 5.3 内容 hash

包含：

- 公司；
- 岗位；
- 城市；
- 薪资；
- 职责；
- 要求；
- 岗位性质；
- 主要技术栈。

忽略：

- 空白与排版；
- 页面导航；
- 推荐岗位列表；
- 页脚；
- 无意义相对时间文案；
- 平台埋点和动态广告。

### 5.4 变化类型

```ts
type CandidateChangeType =
  | 'new'
  | 'unchanged'
  | 'content_changed'
  | 'salary_changed'
  | 'location_changed'
  | 'manual_correction'
```

v0.8 不承诺岗位下架生命周期。

---

## 6. 采集与导入设计

### 6.1 P0 Provider

- `boss_current_page`：定向解析；
- `generic_visible_text`：通用降级。

`pasted_text` / `shared_link_and_text` / `json_import` 仅保留为历史数据读取、Preview/Snapshot
反序列化与 schema 枚举兼容；当前 create/add 写入 DTO 明确拒绝这些值。扩展仍使用 JSON HTTP body
并复用统一的 session/item route 与 service；删除产品入口不得破坏 `visibleText` 或 generic fallback。

猎聘专用适配为 P1。

### 6.2 通用可见文本边界

- 使用用户点击时的当前标签页；
- 获取 URL、标题和可见文本；
- 可使用语义化标签辅助提取，但不得承诺平台字段完整；
- 解析失败时仍保存原始文本并进入预览；
- 不执行页面脚本提供的指令；
- 不读取页面存储和凭据。

### 6.3 采集入口边界

- 用户可见入口只有浏览器扩展当前页采集；
- BOSS 定向与 generic visible-text item 复用 `add item → preview → correction → commit`；
- 空文本和超长文本由服务端 Zod 校验明确拒绝；
- 用户确认前不创建 Candidate；
- 页面、前端 API 包装和帮助文案均不得暴露手工 JD 输入；
- 不持久化独立导入批次领域。

---

## 7. 输入准备度

### 7.1 必需上下文

- active ResumeVersion；
- active JobMatchProfileVersion；
- CandidateVersion 达到最低岗位数据质量。

缺失任一项：`INPUT_NOT_READY`。

### 7.2 可选上下文

- CapabilityBaselineVersion；
- MarketPositionVersion；
- StrategyVersion / StrategyWindow；
- 城市专属视图。

降级规则：

- Capability 缺失：探索性分析，confidence 上限 medium；
- Market 缺失：不输出强市场供给与层级结论；
- Strategy 缺失：不输出强阶段策略结论；
- 非苏锡沪杭：全局画像、`cityCode=null`、城市证据不足。

---

## 8. Stale 判定

### 8.1 事实源

分析记录不可变。有效性由下列版本与当前 active 版本比较：

- CandidateVersion；
- ResumeVersion；
- JobMatchProfileVersion；
- CapabilityBaselineVersion；
- MarketPositionVersion；
- StrategyVersion；
- RuleVersion；
- PromptVersion；
- AnalysisPolicyVersion。

### 8.2 返回结构

```ts
interface AnalysisValidity {
  status: 'current' | 'stale'
  reasons: Array<
    | 'candidate_version_changed'
    | 'resume_version_changed'
    | 'job_match_profile_changed'
    | 'capability_baseline_changed'
    | 'market_position_changed'
    | 'strategy_changed'
    | 'rule_version_changed'
    | 'prompt_version_changed'
    | 'analysis_policy_changed'
    | 'model_policy_invalidated'
  >
}
```

模型升级默认不使全部历史结果过期。只有显式 Model Policy 将旧模型结果标记不可用于推荐时，产生 `model_policy_invalidated`。

### 8.3 推荐约束

- 正式推荐只使用 current；
- stale 结果可在详情页展示为旧版参考；
- 用户可重新分析；
- 不允许前端通过参数绕过 stale 约束。

---

## 9. 误区诊断实现边界

### 9.1 证据准备

服务端确定性生成批次摘要：

- 候选数量与城市/岗位族分布；
- 硬约束、风险与偏好命中统计；
- 四档建议分布；
- 主要能力证据与缺口；
- 当前画像、市场与策略可用性；
- 处理状态与历史高价值反馈摘要。

### 9.2 证据门

建议初始条件：

- 批次至少 5 个 CandidateVersion；
- 至少 3 个 current 成功分析；
- 至少一个模式由 3 个候选或 40% 候选支持；
- 至少检查一个反证来源；
- 结论可引用正式画像或规则字段。

阈值应版本化，评测后可调整。

### 9.3 输出

```ts
interface BatchDiagnosisPayload {
  type:
    | 'target_level_too_high'
    | 'role_direction_mismatch'
    | 'city_mismatch'
    | 'salary_mismatch'
    | 'strength_misread'
    | 'over_chasing_ai_fullstack'
    | 'repeating_low_value_pattern'
    | 'feedback_not_applied'
    | 'insufficient_evidence'
  headline: string
  diagnosis: string
  supportingEvidence: EvidenceReference[]
  counterEvidence: EvidenceReference[]
  confidence: 'low' | 'medium' | 'high'
  correctionDirection: string
  nextLowRiskAction: string
  missingEvidence: string[]
  uncertainties: string[]
}
```

---

## 10. 任务可靠性

### 10.1 状态机

```text
queued
  ↓
running
  ├─ succeeded
  ├─ failed
  └─ cancelled
```

数据库不引入“恢复中”等大量状态。用户可读恢复语义由 error code 表达。

### 10.2 创建顺序

1. 事务内读取并固定输入；
2. 计算 input hash；
3. 命中已有成功记录则复用；
4. 创建 queued task；
5. 返回 task ID；
6. 执行模型调用；
7. 校验 Payload；
8. 结构错误时最多一次修复；
9. 事务内写 AnalysisRecord + succeeded；
10. 写入失败不得产生第二份成功记录。

### 10.3 进程重启

启动时扫描非终态：

- queued：可重新调度；
- running：标记 failed，`error_code=PROCESS_RESTART_INTERRUPTED`；
- 用户点击重试后复用原 input snapshot 从头执行；
- 不继续旧 HTTP/SSE 请求。

### 10.4 取消

- running 时记录取消请求；
- Provider 支持 AbortSignal 时主动中断；
- 无法中断时，响应返回后仍不得写正式结果；
- cancelled 任务不能自动恢复。

---

## 11. API 契约

### 11.1 采集与预览

```http
POST /api/radar/capture-sessions
POST /api/radar/capture-sessions/:id/items
GET  /api/radar/capture-sessions/:id
POST /api/radar/capture-sessions/:id/commit
POST /api/radar/capture-sessions/:id/cancel
```

### 11.2 候选与版本

```http
GET  /api/radar/candidates
GET  /api/radar/candidates/:id
GET  /api/radar/candidates/:id/versions
POST /api/radar/candidates/:id/versions
POST /api/radar/candidates/:id/merge
GET  /api/radar/candidates/:id/changes
```

纠错通过创建新版本，不 PATCH 旧版本。

### 11.3 规则与分析

```http
GET  /api/radar/candidate-versions/:versionId/rules
POST /api/radar/candidates/:id/actions
POST /api/radar/candidate-versions/:versionId/analyze
GET  /api/radar/candidates/:id/analyses
GET  /api/radar/analyses/:id
```

### 11.4 推荐

```http
POST /api/radar/recommendation-batches
GET  /api/radar/recommendation-batches
GET  /api/radar/recommendation-batches/:id
```

### 11.5 动作与晋升

```http
GET  /api/radar/candidates/:id/actions
POST /api/radar/candidates/:id/actions
POST /api/radar/candidates/:id/promotions/preview
POST /api/radar/candidates/:id/promotions
```

### 11.6 任务

```http
GET  /api/analysis-tasks/:id
POST /api/analysis-tasks/:id/retry
POST /api/analysis-tasks/:id/cancel
```

### 11.7 写接口共同要求

- Zod 服务端校验；
- 稳定错误码；
- requestId / taskId；
- 幂等键；
- 事务；
- 不信任前端传入的 active 画像版本；
- 晋升前重新读取正式对象；
- AI Payload 无权指定数据库挂载关系。

---

## 12. 查询投影

为了前端易用，可构建只读投影：

```ts
interface RadarCandidateProjection {
  candidateId: string
  activeVersionId: string
  lifecycleStatus: 'active' | 'merged' | 'archived'
  analysisStatus: 'not_started' | 'running' | 'succeeded' | 'failed'
  analysisValidity: 'current' | 'stale' | 'none'
  saved: boolean
  ignored: boolean
  priority: boolean
  appliedPending: boolean
  promoted: boolean
}
```

投影可由 SQL、服务层或缓存生成，但不得反向成为事实源。

---

## 13. 事务与幂等

### 13.1 Commit 预览

单项事务：

```text
create snapshot
→ upsert source record
→ locate/confirm candidate
→ create candidate version if changed
→ update candidate active_version_id
```

单条扩展 Capture Item 按单项事务提交；BOSS 批量 Preview 仍在一个 commit 事务中处理确认项。

### 13.2 分析

`input_hash` 唯一。相同输入重复请求返回已有 task/result。

### 13.3 推荐

`batch_key` 包含：

- 排序后的 candidate_version_id 集合；
- active 正式上下文版本；
- rule/recommendation/prompt/policy 版本；
- handled state hash。

### 13.4 晋升

`idempotency_key` 至少包含 candidate_version_id、promotion_type 与目标正式对象范围。

---

## 14. 不采用的方案

- `radar_application_marks`；
- Candidate 混合状态；
- 只保存 candidateVersionHash；
- AI 返回内部 ID；
- 独立 BatchMisconception 主流程；
- `/radar/imports` 长期批次页面；
- v0.8 独立 Worker；
- 宣称真正断点续跑；
- 将模型升级自动等同于全量 stale；
- 猎聘专用适配作为发布硬门槛。
