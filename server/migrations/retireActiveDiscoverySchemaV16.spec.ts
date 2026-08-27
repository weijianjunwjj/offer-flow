import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import {
  LATEST_SCHEMA_VERSION,
  RETIRED_ACTIVE_DISCOVERY_SCHEMA_VERSION,
  runMigrations,
} from '../migrations';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-retire-discovery-'));
let sequence = 0;

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function withDb(run: (db: Database.Database) => void): void {
  sequence += 1;
  const db = openDb(path.join(tempDir, `scenario-${sequence}.sqlite3`));
  try {
    run(db);
  } finally {
    db.close();
  }
}

const RETIRED_TABLES = [
  'daily_search_plans',
  'daily_search_plan_versions',
  'source_runs',
  'daily_job_briefs',
  'daily_search_plan_skips',
] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function seedRetiredRows(db: Database.Database): void {
  db.prepare(`
    INSERT INTO daily_search_plans
      (id, name, status, active_version_id, created_at, updated_at, deleted_at)
    VALUES ('plan-1', 'legacy plan', 'active', NULL, 1, 1, NULL)
  `).run();
  db.prepare(`
    INSERT INTO daily_search_plan_versions (
      id, search_plan_id, version, cities_json, role_directions_json,
      base_keywords_json, expanded_keywords_json, hard_constraints_json,
      source_configs_json, schedule_json, scan_budget_json, analysis_budget_json,
      brief_policy_json, exploration_policy_json, notification_policy_json,
      latest_catch_up_time, created_at, activated_at, supersedes_version_id
    ) VALUES (
      'plan-version-1', 'plan-1', 1, '[]', '[]', '[]', '[]', '[]',
      '[]', '{}', '{}', '{}', '{}', '{}', '{}', '12:00', 1, 1, NULL
    )
  `).run();
  db.prepare("UPDATE daily_search_plans SET active_version_id = 'plan-version-1' WHERE id = 'plan-1'").run();
  db.prepare(`
    INSERT INTO source_runs (
      id, search_plan_version_id, source_key, source_version, trigger_type,
      status, phase, scheduled_for, coverage_json, created_at, updated_at,
      search_plan_id, scheduled_day
    ) VALUES (
      'run-1', 'plan-version-1', 'legacy-provider', '1', 'MANUAL',
      'SUCCEEDED', 'DISCOVERING', 1, '{}', 1, 1, 'plan-1', NULL
    )
  `).run();
  db.prepare(`
    INSERT INTO radar_recommendation_batches (
      id, batch_key, status, scope_json, candidate_version_ids_json,
      selected_candidate_version_ids_json, profile_versions_json, rule_version,
      recommendation_rule_version, analysis_policy_version, handled_state_hash,
      diagnosis_status, diagnosis_payload_json, empty_reason, generated_at, created_at
    ) VALUES (
      'batch-1', 'batch-key-1', 'succeeded', '{}', '[]', '[]', '{}',
      'rule-1', 'recommendation-rule-1', 'analysis-policy-1', 'handled-hash-1',
      'insufficient_evidence', NULL, 'no_candidates_in_scope', 1, 1
    )
  `).run();
  db.prepare(`
    INSERT INTO daily_job_briefs (
      id, brief_date, search_plan_version_id, source_run_ids_json,
      recommendation_batch_id, discovery_item_ids_json, status, coverage_json,
      cost_summary_json, empty_reason, generated_at, completed_at, created_at, updated_at
    ) VALUES (
      'brief-1', '2026-08-27', 'plan-version-1', '["run-1"]',
      'batch-1', '[]', 'READY', '{}', NULL, NULL, 1, NULL, 1, 1
    )
  `).run();
  db.prepare(`
    INSERT INTO daily_search_plan_skips
      (search_plan_version_id, scheduled_day, reason, created_at)
    VALUES ('plan-version-1', '2026-08-27', 'legacy skip', 1)
  `).run();
}

describe('schema v16 active discovery retirement', () => {
  it('upgrades a populated v15 database without touching shared Radar data', () => {
    withDb((db) => {
      runMigrations(db, { targetVersion: 15 });
      seedRetiredRows(db);
      expect(db.prepare('SELECT COUNT(*) AS count FROM radar_recommendation_batches').get()).toEqual({ count: 1 });

      const result = runMigrations(db, { targetVersion: RETIRED_ACTIVE_DISCOVERY_SCHEMA_VERSION });

      expect(result.currentVersion).toBe(16);
      for (const table of RETIRED_TABLES) expect(tableExists(db, table)).toBe(false);
      expect(tableExists(db, 'radar_candidates')).toBe(true);
      expect(tableExists(db, 'radar_recommendation_batches')).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM radar_recommendation_batches').get()).toEqual({ count: 1 });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
    });
  });

  it('fresh migration chain ends at latest without recreating retired tables', () => {
    withDb((db) => {
      const result = runMigrations(db, { targetVersion: LATEST_SCHEMA_VERSION });
      expect(result.currentVersion).toBe(RETIRED_ACTIVE_DISCOVERY_SCHEMA_VERSION);
      for (const table of RETIRED_TABLES) expect(tableExists(db, table)).toBe(false);
      expect(tableExists(db, 'radar_capture_snapshots')).toBe(true);
      expect(tableExists(db, 'radar_candidate_versions')).toBe(true);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });
});
