# OfferFlow v0.9 数据模型设计

> **版本：** 2.0  
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment v3：Jooble → Tavily Search API，新增 Evidence Level / Source Policy 字段设计，移除 Jooble-specific 字段）

---

## 0. 设计约定

- `existing` = v0.8 已存在的表，v0.9 不做修改
- `new` = v0.9 新增的表
- `additive extension` = v0.8 表上新增的字段/约束（仅追加，不反向改写）

---

## 1. 新增表（11 张）

### 1.1 `daily_search_plans` [new]（保持）

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

### 1.2 `daily_search_plan_versions` [new]（保持，sourceConfigs 更新 providerKey）

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

**`source_configs_json` 示例：**
```json
[{"providerKey": "tavily", "searchDepth": "basic", "country": "china", "enabled": true}]
```

### 1.3 `source_runs` [new]（结构更新——Provider-neutral）

```sql
CREATE TABLE source_runs (
  id TEXT PRIMARY KEY,
  search_plan_version_id TEXT NOT NULL,
  
  source_key TEXT NOT NULL,         -- 'tavily'
  source_version TEXT NOT NULL,     -- Provider version
  
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
  
  -- Provider-neutral 搜索计数
  queries_attempted INTEGER NOT NULL DEFAULT 0 CHECK (queries_attempted >= 0),
  queries_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (queries_succeeded >= 0),
  queries_failed INTEGER NOT NULL DEFAULT 0 CHECK (queries_failed >= 0),
  results_discovered INTEGER NOT NULL DEFAULT 0 CHECK (results_discovered >= 0),
  relevant_results INTEGER NOT NULL DEFAULT 0 CHECK (relevant_results >= 0),
  
  -- Ingestion 计数
  new_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  
  -- Evidence 计数
  search_evidence_persisted INTEGER NOT NULL DEFAULT 0,
  manual_review_required INTEGER NOT NULL DEFAULT 0,
  full_evidence_count INTEGER NOT NULL DEFAULT 0,
  
  -- Analysis / Recommendation 计数
  analysis_eligible_count INTEGER NOT NULL DEFAULT 0,
  analysis_requested_count INTEGER NOT NULL DEFAULT 0,
  analysis_succeeded_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  alerted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  
  -- Cost
  estimated_search_credits INTEGER,
  actual_search_credits INTEGER,
  
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

**移除的 Jooble-specific 字段：** `scanned_count`、`ingested_count`、`planned_task_count`、`completed_task_count`（替换为 `queries_attempted`/`queries_succeeded`/`queries_failed`/`results_discovered`/`relevant_results` 和 evidence 计数）。

### 1.4 `daily_job_briefs` [new]（新增 `discovery_item_ids_json`）

```sql
CREATE TABLE daily_job_briefs (
  id TEXT PRIMARY KEY,
  brief_date TEXT NOT NULL CHECK (length(trim(brief_date)) > 0),
  
  search_plan_version_id TEXT NOT NULL,
  source_run_ids_json TEXT NOT NULL,
  
  recommendation_batch_id TEXT NOT NULL,
  discovery_item_ids_json TEXT,     -- 新增：SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 发现条目引用
  
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

**`discovery_item_ids_json`** 不是第二套推荐。它引用 CandidateVersion IDs 中 `evidenceLevel IN ('SEARCH_EVIDENCE', 'MANUAL_REVIEW_REQUIRED')` 的条目。正式推荐唯一权威来源仍为 `recommendation_batch_id`。

### 1.5 `job_judgments` [new]（保持）

同旧 Plan。不重复。

### 1.6 `judgment_reasons` [new]（保持）

同旧 Plan。不重复。

### 1.7 `preference_signals` [new]（保持）

同旧 Plan。不重复。

### 1.8 `preference_rules` [new]（保持）

同旧 Plan。不重复。`preference_rule_sources` 关联表保持。

### 1.9 `notification_channels` [new]（保持）

同旧 Plan。不重复。

### 1.10 `notification_outbox` [new]（保持）

同旧 Plan。不重复。

### 1.11 `notification_links` [new]（保持）

同旧 Plan。不重复。

---

## 2. 现有表 Additive 变更

### 2.1 `radar_capture_snapshots` [表重建 migration]

**变更**：扩展 `capture_method` CHECK 约束。

当前真实 CHECK：
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
    'search_discovery',
    'open_web_fetch'
  )
)
```

新增值语义：
- `'search_discovery'`：Tavily Search API 返回的结果（SEARCH_EVIDENCE）
- `'open_web_fetch'`：Content Acquisition 成功 Fetch 的内容（FULL_EVIDENCE）

**迁移方式**：SQLite 表重建 migration（与 schema v8 的 `radar_actions.ENABLE_LONG_CHECK` 重建流程一致）：
```
backup → transaction → CREATE TABLE new → INSERT SELECT → 
FK/index → DROP old → RENAME new → PRAGMA foreign_key_check → integrity
```

**绝对禁止**：`PRAGMA writable_schema` 直接修改生产 schema。

### 2.2 `radar_candidate_versions` [additive column + CHECK 扩展]

**变更 A**：新增 `evidence_level` 列。

```sql
ALTER TABLE radar_candidate_versions 
ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'FULL_EVIDENCE' CHECK (
  evidence_level IN ('SEARCH_EVIDENCE', 'FULL_EVIDENCE', 'MANUAL_REVIEW_REQUIRED')
);
```

默认值 `'FULL_EVIDENCE'` 对已有行兼容（v0.8 所有 CandidateVersion 均视为 FULL_EVIDENCE）。

**变更 B**：扩展 `origin_type` CHECK 约束。

当前真实 CHECK（`server/migrations/radarDomainSchemaV7.ts`）：
```sql
origin_type TEXT NOT NULL CHECK (
  origin_type IN ('captured', 'manual_correction', 'source_change', 'merge_resolution')
)
```

需要扩展为（**这也需要表重建 migration**）：
```sql
origin_type TEXT NOT NULL CHECK (
  origin_type IN ('captured', 'manual_correction', 'source_change', 'merge_resolution', 'evidence_upgrade')
)
```

`'evidence_upgrade'` 语义：同一岗位从 SEARCH_EVIDENCE 升级为 FULL_EVIDENCE（不是 Material Change）。

### 2.3 `radar_rule_assessments` [无变更]

`category='preference'` 已在 v0.8 枚举中预留（`const RADAR_RULE_CATEGORIES = ['hard_constraint', 'risk', 'preference', 'state_suppression']`）。无需 migration。

---

## 3. 枚举扩展汇总

| 表 | 字段 | 变更 | 迁移方式 | 新增值 |
|----|------|------|----------|--------|
| `radar_capture_snapshots` | `capture_method` | CHECK 扩展 | **表重建** | `'search_discovery'`, `'open_web_fetch'` |
| `radar_candidate_versions` | `evidence_level` | **新增 additive 列** | ALTER TABLE ADD COLUMN | `'SEARCH_EVIDENCE'`, `'MANUAL_REVIEW_REQUIRED'` |
| `radar_candidate_versions` | `origin_type` | CHECK 扩展 | **表重建** | `'evidence_upgrade'` |

**已移除：** `'api_discovery'`（Jooble-era，从未落地到生产 schema，无迁移负担）。

---

## 4. 不新增的 Shadow Models

以下明确不创建：

- ❌ `search_evidence` — 复用 `radar_capture_snapshots`
- ❌ `source_policies` — P0 为 code/config policy
- ❌ `discovery_candidates` / `search_candidates` — 使用现有 `radar_candidates`
- ❌ `search_candidate_versions` — 使用现有 `radar_candidate_versions`
- ❌ `web_opportunities` / `search_opportunities` — 使用现有 `radar_candidates`
- ❌ `search_recommendation_batches` / `discovery_recommendations` — 使用现有 `radar_recommendation_batches`
- ❌ `search_daily_brief_items` — 使用 DailyJobBrief 的 `discovery_item_ids_json`
- ❌ `search_analysis_tasks` — 使用现有 `analysis_tasks`
- ❌ `preference_candidate_assessments` — 使用现有 `radar_rule_assessments`（`category='preference'`）
- ❌ `raw_source_snapshots` — 使用现有 `radar_capture_snapshots`
- ❌ `jooble_search_tasks` — Jooble 已 REJECTED
- ❌ 任何 Tavily-specific 领域表 — Tavily DTO 停留在 Adapter boundary

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
  (discovery_item_ids_json 引用 radar_candidate_versions —— 非 FK，存为 JSON 数组)

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

## 6. 索引策略（保持）

同旧 Plan。主要变化：
- `source_runs` 新字段按需建索引
- `job_judgments` 可能需要 `candidate_version_id` + `evidence_level` 相关查询索引（实施时评估）

---

## 7. Migration Schema 版本

- 当前 `LATEST_SCHEMA_VERSION = 8`
- v0.9 新增：migration 9 — `009_v0_9_daily_job_hunter_schema`
- `PRODUCTION_SCHEMA_VERSION` 保持 2（生产底座下限）
- Migration 文件：`server/migrations/dailyJobHunterSchemaV9.ts`
- 注册位置：`server/migrations.ts` 的 `SCHEMA_MIGRATIONS` 数组

---

## 8. 数据模型变化总结

| 维度 | Before (Plan v2.0) | After (Plan v3.0) | Why |
|------|-------------------|-------------------|-----|
| 新表数量 | 12（含 `preference_rule_sources`） | 11（同上，减去 1） | 无 `source_policies` 表（P0 = code/config） |
| `capture_method` 新增值 | `'api_discovery'` | `'search_discovery'`, `'open_web_fetch'` | Jooble→Tavily + Content Acquisition 拆分 |
| `radar_candidate_versions` 新增列 | 无 | `evidence_level` (additive) | SEARCH_EVIDENCE/FULL_EVIDENCE/MANUAL_REVIEW_REQUIRED |
| `origin_type` 新增值 | 无 | `'evidence_upgrade'` | Evidence Upgrade 与 Material Change 分开 |
| `source_runs` 结构 | Jooble-specific（`scannedCount`/`ingestedCount`/`plannedTaskCount`/`completedTaskCount`/pages） | Provider-neutral（`queriesAttempted`/`queriesSucceeded`/`resultsDiscovered` + evidence 计数） | Jooble page model 不再适用 |
| `daily_job_briefs` 新增列 | 无 | `discovery_item_ids_json` (nullable) | SEARCH_EVIDENCE 发现条目 supplementary reference |
| `source_policies` 表 | 未决定 | **不创建** | P0 = code/config policy |
| Jooble-specific 字段 | 存在于 Plan 文档中 | **全部移除** | Jooble REJECTED_AFTER_PREVALIDATION |
