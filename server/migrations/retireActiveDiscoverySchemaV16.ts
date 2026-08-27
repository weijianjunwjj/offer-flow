import type { SqliteDatabase } from '../db';

/**
 * Forward-only retirement of the v0.9 active web discovery subsystem.
 *
 * Historical migrations v9-v15 stay immutable so existing databases and fresh
 * migration chains remain verifiable. This migration removes only the five
 * subsystem-owned tables after their runtime, API, UI, scheduler, and snapshot
 * consumers have been removed. Shared Radar candidate/source/analysis tables
 * are intentionally preserved, including already-ingested candidate history.
 */
export function retireActiveDiscoverySchemaV16(db: SqliteDatabase): void {
  db.exec(`
    DROP TABLE IF EXISTS daily_job_briefs;
    DROP TABLE IF EXISTS daily_search_plan_skips;
    DROP TABLE IF EXISTS source_runs;
    DROP TABLE IF EXISTS daily_search_plans;
    DROP TABLE IF EXISTS daily_search_plan_versions;
  `);
}
