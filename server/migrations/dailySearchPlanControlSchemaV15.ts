import type { SqliteDatabase } from '../db';

/**
 * v0.9 Phase 3（T032 Plan Control）Skip Today 持久化 schema（v15，仅限沙箱/测试/演练库）。
 *
 * 为「Skip Today」补最小持久化：用户明确跳过某 PlanVersion 某自然日的自动调度。
 * 不改历史 migration（v11/v12/v13/v14 语义不变）。
 *
 * 逻辑 identity = (search_plan_version_id, scheduled_day)：
 *   - 同 PlanVersion 同自然日重复 skip 由 PRIMARY KEY 幂等收敛；
 *   - 下一自然日自动恢复（不创建通用的日历 exceptions engine）。
 *
 * 为什么用独立表而不是 SourceRun 表达 skip：
 *   SourceRun 是「一次真实运行」记录；skip 是「不运行」的声明，二者语义不同。
 *   且 SourceRun 的 trigger_type / status contract 无 SKIPPED 值，为 skip 硬造状态会
 *   混淆「跳过」与「运行」。故采用最小 additive 表。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/spec.md FR-006
 *   T032 Plan Control（Skip Today P0 Reality Check：SourceRun 无法表达 skip）
 */

const SKIP_TABLE_SQL = `
CREATE TABLE daily_search_plan_skips (
  search_plan_version_id TEXT NOT NULL,
  scheduled_day TEXT NOT NULL CHECK (length(trim(scheduled_day)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  PRIMARY KEY (search_plan_version_id, scheduled_day),
  FOREIGN KEY (search_plan_version_id) REFERENCES daily_search_plan_versions(id) ON DELETE CASCADE
);

CREATE INDEX daily_search_plan_skips_version_idx
  ON daily_search_plan_skips(search_plan_version_id, scheduled_day);
`;

export function createDailySearchPlanControlSchemaV15(db: SqliteDatabase): void {
  db.exec(SKIP_TABLE_SQL);
}
