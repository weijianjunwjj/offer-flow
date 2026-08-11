# OfferFlow v0.9 数据模型设计

> **版本：** 1.0  
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`  
> **创建日期：** 2026-08-11  

---

## 0. 设计约定

- `existing` = v0.8 已存在的表，v0.9 不做修改
- `new` = v0.9 新增的表
- `additive extension` = v0.8 表上新增的字段/约束（仅追加，不反向改写）

---

## 1. 新增表

### 1.1 `daily_search_plans` [new]

```sql
CREATE TABLE daily_search_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
  active_version_id TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= created_at)),
  FOREIGN KEY (active_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE SET NULL
);

CREATE INDEX daily_search_plans_status_idx ON daily_search_plans(status, updated_at DESC);
```

### 1.2 `daily_search_plan_versions` [new]

```sql
CREATE TABLE daily_search_plan_versions (
  id TEXT PRIMARY KEY,
  search_plan_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  
  cities_json TEXT NOT NULL,
  role_directions_json TEXT NOT NULL,
  base_keywords_json TEXT NOT NULL,
  expanded_keywords_json TEXT NOT NULL DEFAULT '[]',
  
  hard_constraints_json TEXT NOT NULL DEFAULT '[]',
  source_configs_json TEXT NOT NULL,
  
  schedule_json TEXT NOT NULL,
  scan_budget_json TEXT NOT NULL,
  analysis_budget_json TEXT NOT NULL,
  
  brief_policy_json TEXT NOT NULL,
  exploration_policy_json TEXT NOT NULL DEFAULT '{}',
  notification_policy_json TEXT NOT NULL,
  
  latest_catch_up_time TEXT NOT NULL,
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR (typeof(activated_at) = 'integer' AND activated_at >= 0)),
  supersedes_version_id TEXT,
  
  FOREIGN KEY (search_plan_id) REFERENCES daily_search_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE SET NULL,
  UNIQUE (search_plan_id, version)
);

CREATE INDEX daily_search_plan_versions_plan_idx ON daily_search_plan_versions(search_plan_id, version DESC);
```

### 1.3 `source_runs` [new]

```sql
CREATE TABLE source_runs (
  id TEXT PRIMARY KEY,
  search_plan_version_id TEXT NOT NULL,
  
  source_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('SCHEDULED', 'CATCH_UP', 'MANUAL', 'RETRY')),
  retry_of_run_id TEXT,
  
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'RUNNING', 'WAITING_FOR_USER', 
    'PARTIALLY_SUCCEEDED', 'SUCCEEDED', 'FAILED', 
    'CANCELLED', 'INTERRUPTED'
  )),
  phase TEXT NOT NULL CHECK (phase IN (
    'PREPARING', 'DISCOVERING', 'INGESTING', 
    'ANALYZING', 'RECOMMENDING', 'BUILDING_BRIEF'
  )),
  
  scheduled_for INTEGER NOT NULL CHECK (typeof(scheduled_for) = 'integer' AND scheduled_for >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0)),
  finished_at INTEGER CHECK (finished_at IS NULL OR (typeof(finished_at) = 'integer' AND finished_at >= started_at)),
  
  planned_task_count INTEGER NOT NULL DEFAULT 0 CHECK (planned_task_count >= 0),
  completed_task_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_task_count >= 0),
  
  scanned_count INTEGER NOT NULL DEFAULT 0,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  analysis_requested_count INTEGER NOT NULL DEFAULT 0,
  analysis_succeeded_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  alerted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  
  coverage_json TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  cost_summary_json TEXT NOT NULL DEFAULT '{}',
  
  error_code TEXT,
  error_message TEXT,
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  
  FOREIGN KEY (search_plan_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (retry_of_run_id) REFERENCES source_runs(id) ON DELETE SET NULL,
  CHECK (retry_of_run_id IS NULL OR retry_of_run_id <> id)
);

CREATE INDEX source_runs_plan_idx ON source_runs(search_plan_version_id, created_at DESC);
CREATE INDEX source_runs_trigger_idx ON source_runs(trigger_type, status, scheduled_for);
CREATE INDEX source_runs_retry_idx ON source_runs(retry_of_run_id);
CREATE INDEX source_runs_status_idx ON source_runs(status, created_at DESC);
```

**唯一性约束**：同一 `search_plan_version_id` + 同一自然日 + `trigger_type='SCHEDULED'` 最多一个成功/部分成功 Run。由应用层保证，不在 DB 层做强约束（避免跨日期边界问题）。

### 1.4 `daily_job_briefs` [new]

```sql
CREATE TABLE daily_job_briefs (
  id TEXT PRIMARY KEY,
  brief_date TEXT NOT NULL CHECK (length(trim(brief_date)) > 0),
  
  search_plan_version_id TEXT NOT NULL,
  source_run_ids_json TEXT NOT NULL,
  
  recommendation_batch_id TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK (status IN ('GENERATING', 'READY', 'IN_REVIEW', 'COMPLETED', 'FAILED')),
  
  coverage_json TEXT NOT NULL,
  cost_summary_json TEXT NOT NULL DEFAULT '{}',
  empty_reason TEXT,
  
  generated_at INTEGER NOT NULL CHECK (typeof(generated_at) = 'integer' AND generated_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= generated_at)),
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  
  FOREIGN KEY (search_plan_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (recommendation_batch_id) REFERENCES radar_recommendation_batches(id) ON DELETE RESTRICT
);

CREATE INDEX daily_job_briefs_date_idx ON daily_job_briefs(brief_date DESC, status);
CREATE INDEX daily_job_briefs_status_idx ON daily_job_briefs(status, created_at);
```

**不包含 `selected_candidate_ids_json`**：推荐岗位的唯一权威来源是 `recommendation_batch_id` 引用的 `radar_recommendation_batches.selected_candidate_version_ids_json`。

### 1.5 `job_judgments` [new]

```sql
CREATE TABLE job_judgments (
  id TEXT PRIMARY KEY,
  
  daily_brief_id TEXT NOT NULL,
  
  radar_candidate_id TEXT NOT NULL,
  candidate_version_id TEXT NOT NULL,
  match_analysis_id TEXT,
  
  judgment TEXT NOT NULL CHECK (judgment IN (
    'VERY_SUITABLE', 'SOMEWHAT_SUITABLE', 
    'NOT_VERY_SUITABLE', 'VERY_UNSUITABLE'
  )),
  
  system_recommendation TEXT NOT NULL CHECK (system_recommendation IN ('apply_now', 'stretch', 'verify', 'skip')),
  system_confidence TEXT NOT NULL CHECK (system_confidence IN ('low', 'medium', 'high')),
  
  judged_at INTEGER NOT NULL CHECK (typeof(judged_at) = 'integer' AND judged_at >= 0),
  
  supersedes_judgment_id TEXT,
  reverted_at INTEGER,
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  
  FOREIGN KEY (daily_brief_id) REFERENCES daily_job_briefs(id) ON DELETE RESTRICT,
  FOREIGN KEY (radar_candidate_id) REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_version_id) REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (match_analysis_id) REFERENCES job_match_analysis_records(id) ON DELETE SET NULL,
  FOREIGN KEY (supersedes_judgment_id) REFERENCES job_judgments(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX job_judgments_active_idx 
  ON job_judgments(daily_brief_id, radar_candidate_id, candidate_version_id) 
  WHERE supersedes_judgment_id IS NULL AND reverted_at IS NULL;

CREATE INDEX job_judgments_brief_idx ON job_judgments(daily_brief_id, judged_at);
CREATE INDEX job_judgments_candidate_idx ON job_judgments(radar_candidate_id, judged_at DESC);
```

**说明**：partial unique index `job_judgments_active_idx` 保证每个 (brief, candidate, version) 组合最多一个有效判断（未被取代、未被撤销）。

### 1.6 `judgment_reasons` [new]

```sql
CREATE TABLE judgment_reasons (
  id TEXT PRIMARY KEY,
  judgment_id TEXT NOT NULL,
  
  reason_code TEXT,
  reason_text TEXT,
  
  polarity TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'neutral')),
  
  related_jd_evidence_json TEXT,
  
  source TEXT NOT NULL CHECK (source IN ('USER_SELECTED', 'USER_TEXT', 'AI_EXTRACTED', 'SKIPPED')),
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  
  FOREIGN KEY (judgment_id) REFERENCES job_judgments(id) ON DELETE CASCADE
);

CREATE INDEX judgment_reasons_judgment_idx ON judgment_reasons(judgment_id);
```

### 1.7 `preference_signals` [new]

```sql
CREATE TABLE preference_signals (
  id TEXT PRIMARY KEY,
  judgment_id TEXT NOT NULL,
  
  feature_key TEXT NOT NULL CHECK (length(trim(feature_key)) > 0),
  feature_value_json TEXT NOT NULL,
  
  direction TEXT NOT NULL CHECK (direction IN ('positive', 'negative')),
  strength TEXT NOT NULL CHECK (strength IN ('strong', 'medium', 'weak')),
  
  scope_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  invalidated_at INTEGER CHECK (invalidated_at IS NULL OR (typeof(invalidated_at) = 'integer' AND invalidated_at >= created_at)),
  
  FOREIGN KEY (judgment_id) REFERENCES job_judgments(id) ON DELETE CASCADE
);

CREATE INDEX preference_signals_judgment_idx ON preference_signals(judgment_id);
CREATE INDEX preference_signals_feature_idx ON preference_signals(feature_key, direction, invalidated_at);
CREATE INDEX preference_signals_active_idx ON preference_signals(feature_key, direction) 
  WHERE invalidated_at IS NULL;
```

### 1.8 `preference_rules` [new]

```sql
CREATE TABLE preference_rules (
  id TEXT PRIMARY KEY,
  
  rule_type TEXT NOT NULL CHECK (rule_type IN ('RANK_BOOST', 'RANK_PENALTY', 'SUPPRESS', 'SEARCH_EXPAND')),
  feature_key TEXT NOT NULL CHECK (length(trim(feature_key)) > 0),
  
  condition_json TEXT NOT NULL,
  effect_json TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'ACTIVE', 'DISABLED', 'DELETED')),
  explanation TEXT NOT NULL,
  
  activation_mode TEXT NOT NULL CHECK (activation_mode IN ('EXPLICIT_CONFIRM', 'THRESHOLD_AUTO', 'PROPOSED')),
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  disabled_at INTEGER CHECK (disabled_at IS NULL OR (typeof(disabled_at) = 'integer' AND disabled_at >= created_at))
);

CREATE INDEX preference_rules_feature_idx ON preference_rules(feature_key, status);
CREATE INDEX preference_rules_status_idx ON preference_rules(status, rule_type);
```

**`preference_rule_sources` 关联表**：追溯 Rule 的来源 Signals：

```sql
CREATE TABLE preference_rule_sources (
  rule_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, signal_id),
  FOREIGN KEY (rule_id) REFERENCES preference_rules(id) ON DELETE CASCADE,
  FOREIGN KEY (signal_id) REFERENCES preference_signals(id) ON DELETE CASCADE
);

CREATE INDEX preference_rule_sources_signal_idx ON preference_rule_sources(signal_id);
```

### 1.9 `notification_channels` [new]

```sql
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('QQ_SMTP_EMAIL')),
  display_name TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED', 'CONFIGURING', 'ERROR')),
  
  sender_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  secret_ref TEXT NOT NULL,  -- encrypted secret reference
  
  config_json TEXT NOT NULL,
  
  last_tested_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at)
);

CREATE INDEX notification_channels_type_idx ON notification_channels(channel_type, status);
```

**Secret 说明**：`secret_ref` 存储经 SecretStore 保护后的密文引用（Production: Windows DPAPI；Development: 环境变量）。API 响应用 `"***"` 掩码。解密能力绑定当前 Windows 用户/机器。备份数据库不包含明文 Secret。跨机器 restore 后需重新配置。

### 1.10 `notification_outbox` [new]

```sql
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  
  channel_id TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'HIGH_PRIORITY_ALERT', 'DAILY_BRIEF', 'RUN_FAILED', 'ACTION_REQUIRED', 'TEST_EMAIL'
  )),
  
  idempotency_key TEXT NOT NULL,
  
  subject TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'SCHEDULED', 'SENDING', 
    'SENT', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'ACTION_REQUIRED'
  )),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  
  scheduled_at INTEGER CHECK (scheduled_at IS NULL OR (typeof(scheduled_at) = 'integer' AND scheduled_at >= 0)),
  locked_at INTEGER CHECK (locked_at IS NULL OR (typeof(locked_at) = 'integer' AND locked_at >= 0)),
  
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at INTEGER CHECK (next_retry_at IS NULL OR (typeof(next_retry_at) = 'integer' AND next_retry_at >= 0)),
  
  last_error_code TEXT,
  last_error_message TEXT,
  
  sent_at INTEGER CHECK (sent_at IS NULL OR (typeof(sent_at) = 'integer' AND sent_at >= 0)),
  
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX notification_outbox_idempotency_idx ON notification_outbox(idempotency_key);
CREATE INDEX notification_outbox_status_idx ON notification_outbox(status, priority DESC, scheduled_at, created_at);
CREATE INDEX notification_outbox_channel_idx ON notification_outbox(channel_id, status);
CREATE INDEX notification_outbox_locked_idx ON notification_outbox(locked_at, status) WHERE status = 'SENDING';
```

### 1.11 `notification_links` [new]

```sql
CREATE TABLE notification_links (
  notification_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'RADAR_CANDIDATE', 'CANDIDATE_VERSION', 'RADAR_RECOMMENDATION_BATCH', 
    'DAILY_JOB_BRIEF', 'SOURCE_RUN'
  )),
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  PRIMARY KEY (notification_id, entity_type, entity_id),
  FOREIGN KEY (notification_id) REFERENCES notification_outbox(id) ON DELETE CASCADE
);

CREATE INDEX notification_links_entity_idx ON notification_links(entity_type, entity_id);
```

---

## 2. 现有表 Additive 变更

### 2.1 `radar_capture_snapshots` [表重建 migration]

**变更**：扩展 `capture_method` CHECK 约束，新增 `'api_discovery'`。

**这不是普通 ADD COLUMN**——修改 CHECK 约束在 SQLite 中需要 **表重建 migration**（与 schema v8 的 `radar_actions.action_type` 扩展的流程一致）。

当前真实 CHECK（`server/migrations/radarDomainSchemaV7.ts`）：
```sql
capture_method TEXT NOT NULL CHECK (
  capture_method IN (
    'boss_current_page', 'generic_visible_text',
    'pasted_text', 'shared_link_and_text', 'json_import'
  )
)
```

变更为：
```sql
capture_method TEXT NOT NULL CHECK (
  capture_method IN (
    'boss_current_page', 'generic_visible_text',
    'pasted_text', 'shared_link_and_text', 'json_import',
    'api_discovery'
  )
)
```

**迁移方式**（SQLite 表重建）：

```
backup
↓
transaction
↓
CREATE TABLE radar_capture_snapshots_v9_new (
  同结构 + 扩展 CHECK
)
↓
INSERT INTO ... SELECT ...
  (copy 所有既有行，不改写任何数据)
↓
preserve FK / indexes / constraints
↓
DROP TABLE radar_capture_snapshots
↓
ALTER TABLE radar_capture_snapshots_v9_new RENAME TO radar_capture_snapshots
↓
PRAGMA foreign_key_check
↓
integrity verification
↓
v0.8 Radar regression
```

**设计选择**：
- **方案 A（采用）**：扩展现有 CHECK。需要表重建 migration，但与既有 v8 表重建流程完全一致。
- **方案 B（放弃）**：新增独立列 `discovery_method TEXT`。分裂语义、查询复杂。

**绝对禁止**：`PRAGMA writable_schema` 直接手改生产 schema、把 `api_discovery` 假装成 `json_import` 或其他错误旧语义。

**不新增列**。已有 `capture_session_id` 字段已支持 NULL（Active Discovery 使用 `captureSessionId=null`）。

**`secret_ref` 说明更新**：加密方式由 SecretStore 抽象负责（Windows DPAPI / 开发环境变量），不再绑定特定加密算法。

---

## 3. 枚举扩展汇总

| 表 | 字段 | 新增值 | 迁移方式 | 注意事项 |
|----|------|--------|----------|----------|
| `radar_capture_snapshots` | `capture_method` | `'api_discovery'` | **表重建**（CHECK 约束变更；与 schema v8 的 `radar_actions` 表重建流程一致） | 禁止 `PRAGMA writable_schema`；必须 backup → 事务 → 重建 → FK check → 完整性验证 → v0.8 Radar 回归 |

**不新增枚举值但有语义扩展的字段**：无。所有 v0.9 新语义由新表承载，不对 v0.8 表做语义重定义。

---

## 4. 不新增的 Shadow Models

以下明确不创建：

- ❌ `opportunities` / `opportunity_events` — 使用现有 `radar_candidates`
- ❌ `search_candidates` / `search_candidate_versions` — 使用现有 `radar_candidates` / `radar_candidate_versions`
- ❌ `search_analysis_tasks` / `search_analysis_records` — 使用现有 `analysis_tasks` / `job_match_analysis_records`
- ❌ `preference_candidate_assessments` — 使用现有 `radar_rule_assessments`（`category='preference'`）
- ❌ `raw_source_snapshots` — 使用现有 `radar_capture_snapshots`
- ❌ `daily_selected_candidates` — 使用现有 `radar_recommendation_batches.selected_candidate_version_ids_json`
- ❌ `search_recommendation_batches` — 使用现有 `radar_recommendation_batches`
- ❌ `agent_sessions` / `agent_steps` / `generic_checkpoints` — v0.9 不建设通用 Agent Runtime

---

## 5. 外键关系总览

```
daily_search_plans
  └─ active_version_id → daily_search_plan_versions.id

daily_search_plan_versions
  ├─ search_plan_id → daily_search_plans.id
  └─ supersedes_version_id → daily_search_plan_versions.id

source_runs
  ├─ search_plan_version_id → daily_search_plan_versions.id
  └─ retry_of_run_id → source_runs.id

daily_job_briefs
  ├─ search_plan_version_id → daily_search_plan_versions.id
  └─ recommendation_batch_id → radar_recommendation_batches.id

job_judgments
  ├─ daily_brief_id → daily_job_briefs.id
  ├─ radar_candidate_id → radar_candidates.id
  ├─ candidate_version_id → radar_candidate_versions.id
  ├─ match_analysis_id → job_match_analysis_records.id
  └─ supersedes_judgment_id → job_judgments.id

judgment_reasons
  └─ judgment_id → job_judgments.id

preference_signals
  └─ judgment_id → job_judgments.id

preference_rules
  (独立实体)

preference_rule_sources
  ├─ rule_id → preference_rules.id
  └─ signal_id → preference_signals.id

notification_channels
  (独立实体)

notification_outbox
  └─ channel_id → notification_channels.id

notification_links
  └─ notification_id → notification_outbox.id
```

---

## 6. 索引策略

### 6.1 查询热点

| 查询 | 索引 |
|------|------|
| 按状态列出 Plan | `daily_search_plans(status, updated_at DESC)` |
| 按 Plan 查 Version 历史 | `daily_search_plan_versions(search_plan_id, version DESC)` |
| 按 PlanVersion 查 SourceRun | `source_runs(search_plan_version_id, created_at DESC)` |
| 按触发类型查 SourceRun | `source_runs(trigger_type, status, scheduled_for)` |
| 按日期查 DailyBrief | `daily_job_briefs(brief_date DESC, status)` |
| 按 Brief 查活跃 Judgment | `job_judgments_active_idx` (partial unique + filter) |
| 按 Candidate 查 Judgment 历史 | `job_judgments(radar_candidate_id, judged_at DESC)` |
| 按特征查活跃 Signal | `preference_signals(feature_key, direction) WHERE invalidated_at IS NULL` |
| 按状态查 PreferenceRule | `preference_rules(status, rule_type)` |
| 按幂等键查 Outbox | `notification_outbox_idempotency_idx` (UNIQUE) |
| 按状态查待发送 Outbox | `notification_outbox(status, priority DESC, scheduled_at, created_at)` |
| 查超时 SENDING | `notification_outbox(locked_at, status) WHERE status = 'SENDING'` |
| 按实体查通知关联 | `notification_links(entity_type, entity_id)` |

### 6.2 外键索引

所有外键均已建立索引（通过显式 CREATE INDEX 或主键）。详见各表定义。

---

## 7. Migration Schema 版本

- 当前 `LATEST_SCHEMA_VERSION = 8`
- v0.9 新增：migration 9 — `009_v0_9_daily_job_hunter_schema`
- `PRODUCTION_SCHEMA_VERSION` 保持 2（生产底座下限）
- 新 Migration 在沙箱/测试库自动应用；生产库需显式授权
- Migration 文件：`server/migrations/dailyJobHunterSchemaV9.ts`
- 注册位置：`server/migrations.ts` 的 `SCHEMA_MIGRATIONS` 数组
