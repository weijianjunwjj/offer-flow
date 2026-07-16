import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { getDatabaseSchemaVersion } from '../migrations';
import { prepareReleaseCandidate, rehearseRollback } from './rehearsal';

const HASH = 'a'.repeat(64);
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()?.(); } catch { /* best-effort temp cleanup (Windows handle latency) */ } } });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-g6-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedV4Real(dbPath: string): void {
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: 4 });
  db.prepare('INSERT INTO profiles (id,data_json,updated_at) VALUES (?,?,?)').run('p1', JSON.stringify({ name: 'x' }), 1);
  const insJob = db.prepare('INSERT INTO jobs (id,company,role,city,salary_range,match_score,communication_status,updated_at,created_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insJob.run('j1', 'A', '后端', '苏州', '20-30K', 80, 'none', 1, 1, JSON.stringify({ id: 'j1' }));
  insJob.run('j2', 'B', '前端', '上海', '25-35K', 75, 'none', 1, 1, JSON.stringify({ id: 'j2' }));
  db.close();
}

function seedV6Source(dbPath: string): void {
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: 6 });
  const now = 1000;
  const mpVersion = { id: 'mpv-1', version: 1, status: 'active', proposalId: 'mpp-1', createdAt: now, activatedAt: now, global: {}, inputSnapshot: { inputHash: HASH } };
  const mpProposal = { id: 'mpp-1', status: 'accepted', generatedBy: 'ai', createdAt: now, inputSnapshot: { inputHash: HASH } };
  db.prepare("INSERT INTO market_position_meta (id,state_version,active_version_id,updated_at) VALUES ('default',2,'mpv-1',?)").run(now);
  db.prepare('INSERT INTO market_position_proposals (id,status,generated_by,input_fingerprint,data_json,created_at) VALUES (?,?,?,?,?,?)').run('mpp-1', 'accepted', 'ai', HASH, JSON.stringify(mpProposal), now);
  db.prepare('INSERT INTO market_position_versions (id,version,status,proposal_id,data_json,created_at,activated_at) VALUES (?,?,?,?,?,?,?)').run('mpv-1', 1, 'active', 'mpp-1', JSON.stringify(mpVersion), now, now);
  const swVersion = { id: 'swv-1', version: 1, status: 'active', proposalId: 'swp-1', createdAt: now, activatedAt: now, window: { id: 'sw-w-1', dataCutoffAt: now, sourceVersionIds: { jobMatchProfileVersionId: null, capabilityBaselineVersionId: null, marketPositionVersionId: 'mpv-1' } }, inputSnapshot: { marketPositionVersionId: 'mpv-1', acceptedEvidenceIds: [], inputHash: HASH }, generationMode: 'ai', decisionDiff: [] };
  const swProposal = { id: 'swp-1', status: 'accepted', generatedBy: 'ai', createdAt: now, inputSnapshot: { inputHash: HASH } };
  db.prepare("INSERT INTO strategy_meta (id,state_version,active_version_id,updated_at) VALUES ('default',2,'swv-1',?)").run(now);
  db.prepare('INSERT INTO strategy_proposals (id,status,generated_by,input_fingerprint,data_json,created_at) VALUES (?,?,?,?,?,?)').run('swp-1', 'accepted', 'ai', HASH, JSON.stringify(swProposal), now);
  db.prepare('INSERT INTO strategy_versions (id,version,status,proposal_id,data_json,created_at,activated_at) VALUES (?,?,?,?,?,?,?)').run('swv-1', 1, 'active', 'swp-1', JSON.stringify(swVersion), now, now);
  db.close();
}

describe('生产迁移演练', () => {
  function setup(): { real: string; source: string; out: string } {
    const d = tempDir();
    const real = path.join(d, 'real-v4.sqlite3');
    const source = path.join(d, 'source-v6.sqlite3');
    const out = path.join(d, 'out');
    seedV4Real(real);
    seedV6Source(source);
    return { real, source, out };
  }

  it('v4→v5→v6 连续迁移，新表初始为空，晋升后 G4/G5 active 正确，真实库 hash 不变', () => {
    const { real, source, out } = setup();
    const report = prepareReleaseCandidate({ realDatabasePath: real, sandboxSourcePath: source, outputDir: out });
    expect(report.realSchemaVersion).toBe(4);
    expect(report.migrationSequence).toEqual([5, 6]);
    expect(report.candidateSchemaVersion).toBe(6);
    expect(report.candidateIntegrityOk).toBe(true);
    expect(report.candidateFkViolations).toBe(0);
    expect(report.g45TablesEmptyAfterMigration).toBe(true);
    expect(report.preservedPreserved).toBe(true);
    expect(report.promotionVerified).toBe(true);
    expect(report.memoryCountsUnchanged).toBe(true);
    expect(report.reimportAlreadyApplied).toBe(true);
    expect(report.realDbUnchanged).toBe(true);
    expect(report.g4ActiveVersionId).toBe('mpv-1');
    expect(report.g5ActiveVersionId).toBe('swv-1');

    // 候选库确实带有 active G4/G5，且 G5 引用正确 G4。
    const cand = openDb(report.candidatePath);
    expect((cand.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get() as any).active_version_id).toBe('mpv-1');
    expect((cand.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get() as any).active_version_id).toBe('swv-1');
    cand.close();
  });

  it('回滚演练：恢复升级前 v4 备份，schema=4、hash 与备份及真实基线一致、G1~G3 行数一致', () => {
    const { real, source, out } = setup();
    prepareReleaseCandidate({ realDatabasePath: real, sandboxSourcePath: source, outputDir: out });
    const rollback = rehearseRollback({ realDatabasePath: real, outputDir: out });
    expect(rollback.restoredSchemaVersion).toBe(4);
    expect(rollback.restoredIntegrityOk).toBe(true);
    expect(rollback.restoredFkViolations).toBe(0);
    expect(rollback.hashMatchesBackup).toBe(true);
    expect(rollback.hashMatchesRealBaseline).toBe(true);
    expect(rollback.preservedCountsMatch).toBe(true);
    const restored = openDb(rollback.restoredPath);
    expect(getDatabaseSchemaVersion(restored)).toBe(4);
    restored.close();
  });

  it('真实库演练前后 schema 保持 v4（未升级）', () => {
    const { real, source, out } = setup();
    prepareReleaseCandidate({ realDatabasePath: real, sandboxSourcePath: source, outputDir: out });
    const db = openDb(real) as SqliteDatabase;
    expect(getDatabaseSchemaVersion(db)).toBe(4);
    db.close();
  });
});
