/**
 * Phase 1 hardening: backup → migration → restore roundtrip test.
 *
 * 验证 rollback strategy（backup/restore，不是 SQL down-migration）：
 *   1. 在 v8 DB 中创建标准 v0.8 Radar 数据
 *   2. 备份 v8 DB 文件
 *   3. 应用 v9 migration
 *   4. 验证 v9 schema 正确（search_discovery/open_web_fetch/evidence_level/evidence_upgrade）
 *   5. 恢复 v8 备份
 *   6. 验证恢复到精确的 v8 状态（schema + 数据完整 + v0.8 Radar 流正常）
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import {
  DAILY_JOB_HUNTER_SCHEMA_VERSION,
  RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION,
  runMigrations,
} from '../migrations';

let databaseSequence = 0;
const tempDir = mkdtempSync(pathJoin(tmpdir(), 'offerflow-v9-backup-restore-'));

function withTempDatabase(run: (db: Database.Database, dbPath: string) => void): void {
  databaseSequence += 1;
  const dbPath = pathJoin(tempDir, `scenario-${databaseSequence}.sqlite3`);
  const db = openDb(dbPath);
  try {
    assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
    run(db, dbPath);
  } finally {
    db.close();
  }
}

describe('V9 backup/restore rollback', () => {
  it('v8 backup → apply v9 → restore v8 backup → v0.8 Radar flow intact', () => {
    withTempDatabase((db, dbPath) => {
      // Phase 1: build v8 schema with v0.8 radar data
      const v8Result = runMigrations(db, { targetVersion: RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION });
      assert.equal(v8Result.currentVersion, 8);

      // Write canonical v0.8 radar data
      const now = Date.now();
      const sessionId = 'sess-br-test';
      db.prepare(`
        INSERT INTO radar_capture_sessions (id, source_type, status, raw_input_json, preview_items_json, created_at, expires_at, committed_at)
        VALUES (?, 'browser', 'committed', '{}', '[]', ?, ?, ?)
      `).run(sessionId, now, now + 3600000, now);

      const snapshotId = 'snap-br-1';
      db.prepare(`
        INSERT INTO radar_capture_snapshots (
          id, capture_session_id, capture_method, provider_key, visible_text,
          raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES (?, ?, 'boss_current_page', 'boss-ext', 'JD content for backup test', '{}', 'hash-br', ?, ?)
      `).run(snapshotId, sessionId, now, now);

      const sourceRecordId = 'src-br-1';
      db.prepare(`
        INSERT INTO radar_source_records (
          id, provider_key, external_record_id, normalized_source_url,
          first_seen_at, last_seen_at, latest_snapshot_id, source_status, created_at, updated_at
        ) VALUES (?, 'boss-ext', 'ext-123', 'https://zhipin.com/job/123', ?, ?, ?, 'active', ?, ?)
      `).run(sourceRecordId, now, now, snapshotId, now, now);

      const candidateId = 'cand-br-1';
      db.prepare(`
        INSERT INTO radar_candidates (id, primary_source_record_id, lifecycle_status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
      `).run(candidateId, sourceRecordId, now, now);

      const versionId = 'ver-br-1';
      db.prepare(`
        INSERT INTO radar_candidate_versions (
          id, candidate_id, version_no, normalized_json, quality_issues_json,
          source_snapshot_ids_json, content_hash, origin_type, created_at
        ) VALUES (?, ?, 1, '{"company":"Test"}', '[]', '["snap-br-1"]', 'hash-v1', 'captured', ?)
      `).run(versionId, candidateId, now);

      db.prepare('UPDATE radar_candidates SET active_version_id = ? WHERE id = ?').run(versionId, candidateId);

      // Verify v0.8 data
      assert.ok(db.prepare('SELECT 1 FROM radar_candidates WHERE id = ?').get(candidateId));
      assert.ok(db.prepare('SELECT 1 FROM radar_candidate_versions WHERE id = ?').get(versionId));
      assert.equal(
        (db.prepare("SELECT capture_method FROM radar_capture_snapshots WHERE id = ?").get(snapshotId) as Record<string, unknown>).capture_method,
        'boss_current_page',
      );

      // Verify v8 does NOT have evidence_level
      const v8Cols = (db.pragma(`table_info(radar_candidate_versions)`) as Array<{ name: string }>).map(c => c.name);
      assert.ok(!v8Cols.includes('evidence_level'), 'v8 should not have evidence_level');

      // Phase 2: backup
      const backupPath = `${dbPath}.v8-backup`;
      copyFileSync(dbPath, backupPath);
      assert.ok(readFileSync(backupPath).length > 0);

      // Phase 3: apply v9
      const v9Result = runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
      assert.equal(v9Result.currentVersion, 9);
      assert.ok(v9Result.newlyAppliedVersions.includes(9));

      // Verify v9 schema
      const v9Cols = (db.pragma(`table_info(radar_candidate_versions)`) as Array<{ name: string }>).map(c => c.name);
      assert.ok(v9Cols.includes('evidence_level'), 'v9 should have evidence_level');

      // Original data survives
      assert.ok(db.prepare('SELECT 1 FROM radar_candidates WHERE id = ?').get(candidateId));
      assert.ok(db.prepare('SELECT 1 FROM radar_candidate_versions WHERE id = ?').get(versionId));

      // Old version rows get DEFAULT evidence_level=FULL_EVIDENCE
      const evLevel = (db.prepare('SELECT evidence_level FROM radar_candidate_versions WHERE id = ?').get(versionId) as Record<string, unknown>).evidence_level;
      assert.equal(evLevel, 'FULL_EVIDENCE');

      // New values accepted
      db.prepare(`
        INSERT INTO radar_capture_snapshots (
          id, capture_method, visible_text, raw_snapshot_json, raw_content_hash, captured_at, created_at
        ) VALUES ('snap-search-br', 'search_discovery', 'search evidence', '{}', 'hash-search-br', ?, ?)
      `).run(now, now);

      assert.ok(db.prepare("SELECT 1 FROM radar_capture_snapshots WHERE id = 'snap-search-br'").get());

      // Close and restore
      db.close();

      // Phase 4: restore backup → overwrite file
      copyFileSync(backupPath, dbPath);

      // Phase 5: reopen and verify v8 state
      const restored = openDb(dbPath);
      try {
        const restoredVersion = restored.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
        assert.equal(restoredVersion.v, 8, 'restored DB should be at v8');

        // v0.8 data intact
        assert.ok(restored.prepare('SELECT 1 FROM radar_candidates WHERE id = ?').get(candidateId));
        assert.ok(restored.prepare('SELECT 1 FROM radar_candidate_versions WHERE id = ?').get(versionId));
        assert.ok(restored.prepare('SELECT 1 FROM radar_capture_snapshots WHERE id = ?').get(snapshotId));

        // search_discovery value NOT accepted in v8
        assert.throws(() => {
          restored.prepare(`
            INSERT INTO radar_capture_snapshots (
              id, capture_method, visible_text, raw_snapshot_json, raw_content_hash, captured_at, created_at
            ) VALUES ('bad-search', 'search_discovery', 'text', '{}', 'hb', ?, ?)
          `).run(now, now);
        }, /CHECK constraint failed/);

        // evidence_level column does NOT exist
        const restoredCols = (restored.pragma(`table_info(radar_candidate_versions)`) as Array<{ name: string }>).map(c => c.name);
        assert.ok(!restoredCols.includes('evidence_level'), 'restored v8 should not have evidence_level');

        // v0.8 Radar flow: can insert new capture snapshot
        restored.prepare(`
          INSERT INTO radar_capture_snapshots (
            id, capture_method, visible_text, raw_snapshot_json, raw_content_hash, captured_at, created_at
          ) VALUES ('snap-br-2', 'boss_current_page', 'another JD', '{}', 'hash-br2', ?, ?)
        `).run(now, now);
        assert.ok(restored.prepare("SELECT 1 FROM radar_capture_snapshots WHERE id = 'snap-br-2'").get());
      } finally {
        restored.close();
      }
    });
  });
});
