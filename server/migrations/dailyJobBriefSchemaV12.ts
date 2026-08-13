import type { SqliteDatabase } from '../db';

/**
 * v0.9 Phase 4（T040）DailyJobBrief schema（v12，仅限沙箱/测试/演练库）。
 *
 * 纯新增一张表：`daily_job_briefs` —— 每日岗位简报（下游 projection / persistence）。
 *
 * 不修改 v1-v11 既有表的其余语义与数据。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/tasks.md T040
 *   specs/001-daily-job-hunter/data-model.md §1.4
 *
 * 关键约束：
 *   - search_plan_version_id + source_run_ids_json 构成 provenance 主链（来自 T021/T029）；
 *   - recommendation_batch_id 是正式推荐的唯一权威引用（FK 关联 radar_recommendation_batches）；
 *   - discovery_item_ids_json 引用 SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 候选版本 ID，
 *     是 supplementary 发现条目，不是第二套推荐（非权威，不建 FK，存为 JSON 数组）；
 *   - cost_summary_json 可空（T043 依赖延后 Amendment）：null = cost summary 尚未计算；
 *   - 纯新增表，无既有行复制，无需表重建流程。
 */

const CREATE_DAILY_JOB_BRIEFS_SQL = `
CREATE TABLE daily_job_briefs (
  id TEXT PRIMARY KEY,
  brief_date TEXT NOT NULL CHECK (length(trim(brief_date)) > 0),

  search_plan_version_id TEXT NOT NULL,
  source_run_ids_json TEXT NOT NULL,

  recommendation_batch_id TEXT NOT NULL,
  discovery_item_ids_json TEXT,

  status TEXT NOT NULL CHECK (status IN ('GENERATING', 'READY', 'IN_REVIEW', 'COMPLETED', 'FAILED')),

  coverage_json TEXT NOT NULL,
  cost_summary_json TEXT,
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
`;

export function createDailyJobBriefSchemaV12(db: SqliteDatabase): void {
  db.exec(CREATE_DAILY_JOB_BRIEFS_SQL);
}
