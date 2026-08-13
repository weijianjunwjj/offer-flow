import type { SqliteDatabase } from '../db';

/**
 * v0.9 Phase 4（T040 hardening）DailyJobBrief 幂等约束（v13，仅限沙箱/测试/演练库）。
 *
 * 追加一条 UNIQUE INDEX，把 DailyJobBrief 的 logical identity 提升到 persistence 层。
 *
 * DailyJobBrief authoritative identity = (brief_date, search_plan_version_id)：
 *   - spec.md FR-023 / User Story 8：每天每次每日流水线运行恰好一份 DailyJobBrief；
 *   - FR-005：(自然日, PlanVersion) 最多一次 CATCH_UP 运行——(day, version) 是运行聚合的稳定键；
 *   - search_plan_version_id 在 brief 上为 NOT NULL 单值，source_run_ids 是可增长的可变列表
 *     （SCHEDULED + CATCH_UP + MANUAL + RETRY 都会追加 run id），不是稳定身份。
 *
 * 因此 source_run_ids 明确不属于 identity；本迁移不为其做 canonicalization。
 *
 * 约束效果：即使两次独立写入使用不同的 brief.id，只要 (brief_date, search_plan_version_id)
 * 相同，第二次写入必然被 UNIQUE 拒绝，不可能持久化两条重复 logical brief。
 *
 * 不修改 v1-v12 既有表的其余语义与数据；不重建 daily_job_briefs 表。
 * 用 CREATE UNIQUE INDEX 而非表级 UNIQUE 约束，因为 SQLite 无法通过 ALTER TABLE
 * 给既有表追加表级 UNIQUE 约束，而 UNIQUE INDEX 提供相同的持久化唯一性保证，
 * 是给既有表追加唯一性约束的最小、无数据移动方案（对齐 v12 的 CREATE INDEX 风格）。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/spec.md FR-023 / User Story 8
 *   specs/001-daily-job-hunter/plan.md §2.16
 *   specs/001-daily-job-hunter/data-model.md §1.4
 */

const CREATE_DAILY_JOB_BRIEF_IDEMPOTENCY_SQL = `
CREATE UNIQUE INDEX daily_job_briefs_logical_identity_idx
  ON daily_job_briefs (brief_date, search_plan_version_id);
`;

export function createDailyJobBriefIdempotencySchemaV13(db: SqliteDatabase): void {
  db.exec(CREATE_DAILY_JOB_BRIEF_IDEMPOTENCY_SQL);
}
