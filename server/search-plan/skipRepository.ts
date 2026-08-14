import type { SqliteDatabase } from '../db';

/**
 * OfferFlow v0.9 — DailySearchPlan Skip Repository（T032 Skip Today 持久化）。
 *
 * 纯持久化层：只负责「某 PlanVersion 某自然日被用户明确跳过」的读写，不做调度判定。
 * 逻辑 identity = (search_plan_version_id, scheduled_day)，由主键保证幂等：
 *   重复 skip 同一天收敛为一行，不产生重复记录。
 */

export interface DailySearchPlanSkip {
  searchPlanVersionId: string;
  /** 该 PlanVersion schedule.timezone 下的自然日 YYYY-MM-DD。 */
  scheduledDay: string;
  reason: string;
  createdAt: number;
}

interface SkipRow {
  search_plan_version_id: unknown;
  scheduled_day: unknown;
  reason: unknown;
  created_at: unknown;
}

export class SkipRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** 幂等写入 skip（同 PlanVersion 同自然日重复调用只保留一行）。 */
  skip(searchPlanVersionId: string, scheduledDay: string, reason: string, createdAt: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO daily_search_plan_skips (
        search_plan_version_id, scheduled_day, reason, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(searchPlanVersionId, scheduledDay, reason, createdAt);
  }

  /** 该 PlanVersion 该自然日是否已被跳过。 */
  isSkipped(searchPlanVersionId: string, scheduledDay: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM daily_search_plan_skips
         WHERE search_plan_version_id = ? AND scheduled_day = ?`,
      )
      .get(searchPlanVersionId, scheduledDay) as { present: number } | undefined;
    return row !== undefined;
  }

  /** 列出某 PlanVersion 的全部 skip（测试/诊断用）。 */
  listByVersion(searchPlanVersionId: string): DailySearchPlanSkip[] {
    const rows = this.db
      .prepare(
        `SELECT search_plan_version_id, scheduled_day, reason, created_at
         FROM daily_search_plan_skips
         WHERE search_plan_version_id = ?
         ORDER BY scheduled_day DESC`,
      )
      .all(searchPlanVersionId) as SkipRow[];
    return rows.map((row) => ({
      searchPlanVersionId: row.search_plan_version_id as string,
      scheduledDay: row.scheduled_day as string,
      reason: row.reason as string,
      createdAt: row.created_at as number,
    }));
  }
}
