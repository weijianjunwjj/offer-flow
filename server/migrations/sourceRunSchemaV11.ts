import type { SqliteDatabase } from '../db';

/**
 * v0.9 Phase 3（T029）SourceRun schema（v11，仅限沙箱/测试/演练库）。
 *
 * 纯新增一张表：`source_runs` —— 一次真实 Daily Discovery execution 的稳定运行身份。
 *
 * SourceRun 语义（A，非 B）：
 *   - 包裹整个 DailyPipeline run（phase 从 PREPARING 到 BUILDING_BRIEF），
 *     而非"单次 Search Provider / Discovery source 调用"；
 *   - 名字中的 "source" 指"自动化来源驱动的发现"（区别于手工 Browser Capture），
 *     不是"一个 search provider 请求"。此语义由 phase 枚举跨度与
 *     analysis/recommendation 计数列共同确立（data-model.md §1.3）。
 *
 * 不修改 v1-v10 既有表的其余语义与数据。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/tasks.md T029
 *   specs/001-daily-job-hunter/data-model.md §1.3
 *
 * 关键约束：
 *   - search_plan_version_id 外键 RESTRICT 关联 daily_search_plan_versions（provenance 主链）；
 *   - retry_of_run_id 自引用表达重试链，CHECK 禁止自环；
 *   - 纯新增表，无既有行复制，无需表重建流程。
 */

const CREATE_SOURCE_RUNS_SQL = `
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
`;

export function createSourceRunSchemaV11(db: SqliteDatabase): void {
  db.exec(CREATE_SOURCE_RUNS_SQL);
}
