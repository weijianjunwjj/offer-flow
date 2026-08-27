import type { SqliteDatabase } from '../db';

/**
 * Historical v14 source_runs scheduling-dedup schema.
 *
 * 为自动调度闭环补持久化层 run dedupe，不改历史 migration（v11/v12/v13 语义不变）。
 *
 * 变更内容（全部 additive，无表重建）：
 *   1. `search_plan_id`：冗余 plan identity provenance，用于 FR-007「同一计划同时最多一个 active run」。
 *   2. `scheduled_day`：该 occurrence 在 PlanVersion.schedule.timezone 下的本地自然日 YYYY-MM-DD
 *      （SCHEDULED / CATCH_UP 必填；MANUAL / RETRY 为 NULL）。
 *   3. 三个 partial UNIQUE INDEX：
 *      - (search_plan_version_id, scheduled_for) WHERE trigger_type IN ('SCHEDULED','CATCH_UP')
 *        同一 planned occurrence 最多一个自动 run（解决 timer / startup race）。
 *      - (search_plan_version_id, scheduled_day) WHERE trigger_type = 'CATCH_UP'
 *        FR-005：每 PlanVersion 每自然日最多一次 CATCH_UP。
 *      - (search_plan_id) WHERE status IN ('PENDING','RUNNING','WAITING_FOR_USER')
 *        FR-007：同一计划同时最多一个活跃 run（active statuses 来自真实 SourceRun 状态机）。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/spec.md FR-005 / FR-007 / FR-008
 *   specs/001-daily-job-hunter/data-model.md §1.3
 *   Historical schedule timezone / occurrence identity decision.
 */

const SOURCE_RUN_DEDUPE_SQL = `
ALTER TABLE source_runs ADD COLUMN search_plan_id TEXT;
ALTER TABLE source_runs ADD COLUMN scheduled_day TEXT;

CREATE UNIQUE INDEX source_runs_occurrence_unique_idx
  ON source_runs (search_plan_version_id, scheduled_for)
  WHERE trigger_type IN ('SCHEDULED', 'CATCH_UP');

CREATE UNIQUE INDEX source_runs_catchup_day_unique_idx
  ON source_runs (search_plan_version_id, scheduled_day)
  WHERE trigger_type = 'CATCH_UP';

CREATE UNIQUE INDEX source_runs_active_plan_unique_idx
  ON source_runs (search_plan_id)
  WHERE status IN ('PENDING', 'RUNNING', 'WAITING_FOR_USER');
`;

export function createDailyJobSchedulerSchemaV14(db: SqliteDatabase): void {
  db.exec(SOURCE_RUN_DEDUPE_SQL);
}
