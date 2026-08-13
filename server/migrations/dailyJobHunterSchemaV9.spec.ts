import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import {
  DAILY_JOB_HUNTER_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  runMigrations,
} from '../migrations';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-v9-migration-'));
let databaseSequence = 0;

function withTempDatabase(run: (db: Database.Database, dbPath: string) => void): void {
  databaseSequence += 1;
  const dbPath = path.join(tempDir, `scenario-${databaseSequence}.sqlite3`);
  const db = openDb(dbPath);
  try {
    assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
    run(db, dbPath);
  } finally {
    db.close();
  }
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function checkConstraint(db: Database.Database, table: string): string | null {
  const rows = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  return rows?.sql ?? null;
}

function getCaptureMethodValues(db: Database.Database): string[] {
  const sql = checkConstraint(db, 'radar_capture_snapshots') ?? '';
  const match = sql.match(/capture_method IN \(([^)]+)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .filter(Boolean);
}

function getOriginTypeValues(db: Database.Database): string[] {
  const sql = checkConstraint(db, 'radar_candidate_versions') ?? '';
  const match = sql.match(/origin_type IN \(([^)]+)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .filter(Boolean);
}

function getEvidenceLevelValues(db: Database.Database): string[] {
  const sql = checkConstraint(db, 'radar_candidate_versions') ?? '';
  const match = sql.match(/evidence_level IN \(([^)]+)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .filter(Boolean);
}

function migrationRecords(db: Database.Database): Array<{ version: number; name: string }> {
  return db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('v9 Migration: dailyJobHunterSchemaV9', () => {
  it('fresh DB creates all v1-v9 schemas and reaches LATEST_SCHEMA_VERSION', () => {
    withTempDatabase((db) => {
      const result = runMigrations(db, { targetVersion: LATEST_SCHEMA_VERSION });
      assert.equal(result.currentVersion, 9);
      assert.ok(result.newlyAppliedVersions.includes(9));

      // Verify capture_method CHECK includes new values
      const captureMethods = getCaptureMethodValues(db);
      assert.ok(captureMethods.includes('search_discovery'), '缺少 search_discovery');
      assert.ok(captureMethods.includes('open_web_fetch'), '缺少 open_web_fetch');
      assert.ok(captureMethods.includes('boss_current_page'), 'boss_current_page 不应丢失');
      assert.ok(captureMethods.includes('generic_visible_text'), 'generic_visible_text 不应丢失');

      // Verify origin_type CHECK includes evidence_upgrade
      const originTypes = getOriginTypeValues(db);
      assert.ok(originTypes.includes('evidence_upgrade'), '缺少 evidence_upgrade');
      assert.ok(originTypes.includes('captured'), 'captured 不应丢失');
      assert.ok(originTypes.includes('source_change'), 'source_change 不应丢失');

      // Verify evidence_level CHECK
      const evidenceLevels = getEvidenceLevelValues(db);
      assert.ok(evidenceLevels.includes('SEARCH_EVIDENCE'), '缺少 SEARCH_EVIDENCE');
      assert.ok(evidenceLevels.includes('FULL_EVIDENCE'), '缺少 FULL_EVIDENCE');
      assert.ok(evidenceLevels.includes('MANUAL_REVIEW_REQUIRED'), '缺少 MANUAL_REVIEW_REQUIRED');

      // Verify evidence_level column exists with correct default
      const cols = columnNames(db, 'radar_candidate_versions');
      assert.ok(cols.includes('evidence_level'), '缺少 evidence_level 列');
    });
  });

  it('v8 → v9 upgrade: preserves existing data and extends CHECK constraints', () => {
    withTempDatabase((db) => {
      // First: migrate to v8
      const v8Result = runMigrations(db, { targetVersion: 8 });
      assert.equal(v8Result.currentVersion, 8);

      // Insert v0.8-style capture snapshots (old capture_method values)
      db.exec(`
        INSERT INTO radar_capture_sessions (id, source_type, status, raw_input_json, preview_items_json, created_at, expires_at, committed_at)
        VALUES ('sess-v8', 'browser', 'committed', '{}', '[]', 100, 200, 150);
      `);
      db.exec(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, provider_key, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (
          'snap-boss', 'sess-v8', 'boss_current_page', 'boss-ext', 'JD text',
          '{}', 'hash-boss', 300, 400
        );
      `);
      db.exec(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, provider_key, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (
          'snap-paste', 'sess-v8', 'pasted_text', null, 'Pasted JD',
          '{}', 'hash-paste', 500, 600
        );
      `);

      // Insert v0.8-style candidate + versions
      const candId = 'cand-v8-test';
      db.exec(`
        INSERT INTO radar_candidates (id, lifecycle_status, created_at, updated_at)
        VALUES ('${candId}', 'active', 100, 100);
      `);
      db.exec(`
        INSERT INTO radar_candidate_versions (
          id, candidate_id, version_no, normalized_json, quality_issues_json,
          source_snapshot_ids_json, content_hash, origin_type, created_at
        ) VALUES (
          'ver-v8-1', '${candId}', 1, '{}', '[]', '["snap-boss"]', 'hash-abc', 'captured', 100
        );
      `);
      db.exec(`
        INSERT INTO radar_candidate_versions (
          id, candidate_id, version_no, normalized_json, quality_issues_json,
          source_snapshot_ids_json, content_hash, origin_type, created_at
        ) VALUES (
          'ver-v8-2', '${candId}', 2, '{}', '[]', '["snap-paste"]', 'hash-def', 'source_change', 200
        );
      `);
      db.exec(`UPDATE radar_candidates SET active_version_id = 'ver-v8-2' WHERE id = '${candId}'`);

      // Now upgrade to v9
      const v9Result = runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
      assert.equal(v9Result.currentVersion, 9);
      assert.ok(v9Result.newlyAppliedVersions.includes(9));

      // Verify old snapshots survived the table rebuild
      const snapshotCount = db.prepare(`SELECT COUNT(*) AS cnt FROM radar_capture_snapshots`).get() as { cnt: number };
      assert.equal(snapshotCount.cnt, 2);

      const bossSnapshot = db.prepare(`SELECT * FROM radar_capture_snapshots WHERE id = 'snap-boss'`).get() as Record<string, unknown> | undefined;
      assert.ok(bossSnapshot !== undefined);
      assert.equal(bossSnapshot.capture_method, 'boss_current_page');

      const pasteSnapshot = db.prepare(`SELECT * FROM radar_capture_snapshots WHERE id = 'snap-paste'`).get() as Record<string, unknown> | undefined;
      assert.ok(pasteSnapshot !== undefined);
      assert.equal(pasteSnapshot.capture_method, 'pasted_text');

      // Verify old versions survived the table rebuild
      const versionCount = db.prepare(`SELECT COUNT(*) AS cnt FROM radar_candidate_versions`).get() as { cnt: number };
      assert.equal(versionCount.cnt, 2);

      const v1 = db.prepare(`SELECT * FROM radar_candidate_versions WHERE id = 'ver-v8-1'`).get() as Record<string, unknown> | undefined;
      assert.ok(v1 !== undefined);
      assert.equal(v1.origin_type, 'captured');
      // evidence_level default for old rows should be 'FULL_EVIDENCE'
      assert.equal(v1.evidence_level, 'FULL_EVIDENCE');

      const v2 = db.prepare(`SELECT * FROM radar_candidate_versions WHERE id = 'ver-v8-2'`).get() as Record<string, unknown> | undefined;
      assert.ok(v2 !== undefined);
      assert.equal(v2.origin_type, 'source_change');
      assert.equal(v2.evidence_level, 'FULL_EVIDENCE');

      // Verify new CHECK accepts new values
      db.exec(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, provider_key, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (
          'snap-search', null, 'search_discovery', 'tavily', 'Search result snippet',
          '{}', 'hash-search', 700, 800
        );
      `);
      const searchSnapshot = db.prepare(`SELECT * FROM radar_capture_snapshots WHERE id = 'snap-search'`).get() as Record<string, unknown> | undefined;
      assert.ok(searchSnapshot !== undefined);
      assert.equal(searchSnapshot.capture_method, 'search_discovery');

      db.exec(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, provider_key, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (
          'snap-fetch', null, 'open_web_fetch', 'tavily', 'Fetched job page content',
          '{}', 'hash-fetch', 900, 1000
        );
      `);
      const fetchSnapshot = db.prepare(`SELECT * FROM radar_capture_snapshots WHERE id = 'snap-fetch'`).get() as Record<string, unknown> | undefined;
      assert.ok(fetchSnapshot !== undefined);
      assert.equal(fetchSnapshot.capture_method, 'open_web_fetch');

      // Re-insert through the rebuilt table (old table was renamed and dropped)
      const evUpgradeId = 'ver-v9-ev-upgrade';
      db.prepare(`
        INSERT INTO radar_candidate_versions (
          id, candidate_id, version_no, normalized_json, quality_issues_json,
          source_snapshot_ids_json, content_hash, origin_type, evidence_level,
          supersedes_version_id, created_at
        ) VALUES (
          ?, ?, 3, '{}', '[]', '["snap-search"]', 'hash-ghi',
          'evidence_upgrade', 'FULL_EVIDENCE', 'ver-v8-2', 300
        );
      `).run(evUpgradeId, candId);
      const evVersion = db.prepare(`SELECT * FROM radar_candidate_versions WHERE id = ?`).get(evUpgradeId) as Record<string, unknown> | undefined;
      assert.ok(evVersion !== undefined);
      assert.equal(evVersion.origin_type, 'evidence_upgrade');
      assert.equal(evVersion.evidence_level, 'FULL_EVIDENCE');
      assert.equal(evVersion.supersedes_version_id, 'ver-v8-2');

      // SEARCH_EVIDENCE version
      const searchEvId = 'ver-v9-search-ev';
      db.prepare(`
        INSERT INTO radar_candidate_versions (
          id, candidate_id, version_no, normalized_json, quality_issues_json,
          source_snapshot_ids_json, content_hash, origin_type, evidence_level,
          supersedes_version_id, created_at
        ) VALUES (
          ?, ?, 4, '{}', '[]', '["snap-search"]', 'hash-jkl',
          'captured', 'SEARCH_EVIDENCE', ?, 400
        );
      `).run(searchEvId, candId, evUpgradeId);
      const seVersion = db.prepare(`SELECT * FROM radar_candidate_versions WHERE id = ?`).get(searchEvId) as Record<string, unknown> | undefined;
      assert.ok(seVersion !== undefined);
      assert.equal(seVersion.evidence_level, 'SEARCH_EVIDENCE');

      // Verify foreign key integrity
      const fkViolations = db.pragma('foreign_key_check') as unknown[];
      assert.equal(fkViolations.length, 0, `FK violations: ${JSON.stringify(fkViolations)}`);

      // Reject invalid values
      assert.throws(() => {
        db.exec(`
          INSERT INTO radar_capture_snapshots (
            id, capture_session_id, capture_method, visible_text,
            raw_snapshot_json, raw_content_hash, captured_at, created_at
          ) VALUES (
            'bad-method', null, 'invalid_method', 'text', '{}', 'h', 1, 2
          );
        `);
      }, /CHECK constraint failed/);

      assert.throws(() => {
        db.exec(`
          INSERT INTO radar_candidate_versions (
            id, candidate_id, version_no, normalized_json, quality_issues_json,
            source_snapshot_ids_json, content_hash, origin_type, evidence_level, created_at
          ) VALUES (
            'bad-origin', '${candId}', 99, '{}', '[]', '[]', 'h99', 'invalid_origin', 'FULL_EVIDENCE', 100
          );
        `);
      }, /CHECK constraint failed/);

      assert.throws(() => {
        db.exec(`
          INSERT INTO radar_candidate_versions (
            id, candidate_id, version_no, normalized_json, quality_issues_json,
            source_snapshot_ids_json, content_hash, origin_type, evidence_level, created_at
          ) VALUES (
            'bad-ev', '${candId}', 100, '{}', '[]', '[]', 'h100', 'captured', 'INVALID_LEVEL', 100
          );
        `);
      }, /CHECK constraint failed/);
    });
  });

  it('rollback: v8 DB is not affected when v9 migration is NOT applied', () => {
    withTempDatabase((db) => {
      const result = runMigrations(db, { targetVersion: 8 });
      assert.equal(result.currentVersion, 8);

      // Insert v0.8 data
      const candId = 'cand-rollback';
      db.exec(`INSERT INTO radar_candidates (id, lifecycle_status, created_at, updated_at) VALUES ('${candId}', 'active', 1, 2)`);
      db.exec(`INSERT INTO radar_capture_sessions (id, source_type, status, raw_input_json, preview_items_json, created_at, expires_at) VALUES ('s-rb', 'browser', 'preview', '{}', '[]', 1, 99999)`);

      // Do NOT apply v9
      const records = migrationRecords(db);
      assert.equal(records.at(-1)?.version, 8);

      // Old constraints still work
      db.exec(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (
          'snap-rb', null, 'boss_current_page', 'text', '{}', 'hash-rb', 1, 1
        );
      `);

      // New values are rejected at v8
      assert.throws(() => {
        db.exec(`
          INSERT INTO radar_capture_snapshots (
            id, capture_session_id, capture_method, visible_text,
            raw_snapshot_json, raw_content_hash, captured_at, created_at
          ) VALUES (
            'snap-rb2', null, 'search_discovery', 'text', '{}', 'hash-rb2', 1, 2
          );
        `);
      }, /CHECK constraint failed/);

      // evidence_level column doesn't exist at v8
      const cols = columnNames(db, 'radar_candidate_versions');
      assert.ok(!cols.includes('evidence_level'), 'v8 不应有 evidence_level 列');
    });
  });

  it('fresh v9 DB: capture_session_id=NULL is allowed (search_discovery has no session)', () => {
    withTempDatabase((db) => {
      runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });

      db.exec(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, provider_key, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (
          'snap-no-session', NULL, 'search_discovery', 'tavily', 'Search Evidence content',
          '{}', 'hash-ns', 1, 2
        );
      `);

      const row = db.prepare(`SELECT * FROM radar_capture_snapshots WHERE id = 'snap-no-session'`).get() as Record<string, unknown>;
      assert.equal(row.capture_session_id, null);
      assert.equal(row.capture_method, 'search_discovery');
      assert.equal(row.provider_key, 'tavily');
    });
  });
});
