import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-sync-'));
const dbPath = path.join(tempDir, 'data', 'offerflow.sqlite3');
const syncDir = path.join(tempDir, 'sync');
const backupsDir = path.join(tempDir, 'backups');
const corruptedDir = path.join(tempDir, 'data', 'corrupted');
const deviceIdPath = path.join(tempDir, 'data', 'device-id.txt');

process.env.OFFERFLOW_DB_PATH = dbPath;
process.env.OFFERFLOW_SYNC_DIR = syncDir;
process.env.OFFERFLOW_BACKUP_DIR = backupsDir;
process.env.OFFERFLOW_CORRUPTED_DIR = corruptedDir;
process.env.OFFERFLOW_DEVICE_ID_PATH = deviceIdPath;

const { openDb } = await import('../server/db');
const { initSchema } = await import('../server/schema');
const { ensureInitializedDatabase } = await import('../server/sync/database');
const { doctorDatabase } = await import('../server/sync/doctor');
const { exportSnapshot } = await import('../server/sync/exportSnapshot');
const { importSnapshot } = await import('../server/sync/importSnapshot');
const { runStartupSync } = await import('../server/sync/bootstrap');
const { runSync } = await import('../server/sync/syncRunner');
const { getSyncPaths } = await import('../server/sync/paths');
const { sha256Hex, toStableJson, atomicWriteJson } = await import('../server/sync/hash');
const { SNAPSHOT_SCHEMA_VERSION } = await import('../server/sync/types');

function writeJob(id: string, updatedAt: number, company: string): void {
  const db = openDb(dbPath);
  try {
    initSchema(db);
    const job = {
      id,
      createdAt: updatedAt,
      updatedAt,
      company,
      role: '前端',
      city: '苏州',
      salaryRange: '20K',
      jdText: '',
      promptText: '',
      aiRawResult: '',
      aiPastedAt: null,
      parseStatus: 'none',
      report: null,
      matchScore: '',
      companyInput: {
        sizeTier: 'unknown',
        staffRange: '',
        companyType: '',
        financingStage: '',
        commuteTime: '',
        commuteWay: '',
        companyNote: '',
        opportunityNote: '',
      },
      companyAssessment: null,
      opportunityAnalysis: null,
      communicationStatus: 'not_contacted',
      followupCount: 0,
      highValueSignal: false,
    };
    db.prepare(
      `INSERT INTO jobs (
        id, company, role, city, salary_range, match_score,
        communication_status, updated_at, created_at, data_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company = excluded.company,
        role = excluded.role,
        city = excluded.city,
        salary_range = excluded.salary_range,
        match_score = excluded.match_score,
        communication_status = excluded.communication_status,
        updated_at = excluded.updated_at,
        created_at = excluded.created_at,
        data_json = excluded.data_json`,
    ).run(
      id,
      company,
      '前端',
      '苏州',
      '20K',
      null,
      'not_contacted',
      updatedAt,
      updatedAt,
      JSON.stringify(job),
    );
  } finally {
    db.close();
  }
}

function readJobCompany(id: string): string {
  const db = openDb(dbPath);
  try {
    const row = db.prepare('SELECT company FROM jobs WHERE id = ?').get(id) as
      | { company: string }
      | undefined;
    return row?.company ?? '';
  } finally {
    db.close();
  }
}

function rewriteSnapshot(mutator: (snapshot: Record<string, unknown>) => void): void {
  const paths = getSyncPaths(dbPath);
  const snapshot = JSON.parse(fs.readFileSync(paths.snapshotPath, 'utf8')) as Record<
    string,
    unknown
  >;
  mutator(snapshot);
  const snapshotJson = toStableJson(snapshot);
  fs.writeFileSync(paths.snapshotPath, snapshotJson, 'utf8');
  const manifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    databaseSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: String(snapshot.exportedAt),
    deviceId: String(snapshot.deviceId),
    appVersion: String(snapshot.appVersion),
    snapshotHash: sha256Hex(snapshotJson),
    tableCounts: {
      jobs: (
        snapshot.tables as { jobs?: { rows?: unknown[] } }
      ).jobs?.rows?.length ?? 0,
    },
  };
  atomicWriteJson(paths.manifestPath, manifest);
}

try {
  ensureInitializedDatabase(dbPath);

  const firstExport = exportSnapshot(dbPath);
  const paths = getSyncPaths(dbPath);
  assert.equal(fs.existsSync(paths.snapshotPath), true);
  assert.equal(fs.existsSync(paths.manifestPath), true);
  assert.equal(fs.existsSync(`${paths.snapshotPath}.tmp`), false);
  assert.equal(firstExport.tableCounts.jobs, 0);

  writeJob('job-1', 1000, 'remote');
  exportSnapshot(dbPath);

  fs.appendFileSync(paths.snapshotPath, '\n');
  await assert.rejects(async () => {
    importSnapshot(dbPath);
  }, /hash mismatch/);
  const startupWithBadSnapshot = runStartupSync(dbPath);
  assert.equal(startupWithBadSnapshot.importResult, null);
  assert.equal(
    startupWithBadSnapshot.warnings.some((warning) => warning.includes('hash mismatch')),
    true,
  );
  exportSnapshot(dbPath);

  fs.rmSync(dbPath, { force: true });
  ensureInitializedDatabase(dbPath);
  const inserted = importSnapshot(dbPath, { backupBeforeImport: false });
  assert.equal(inserted.inserted > 0, true);
  assert.equal(readJobCompany('job-1'), 'remote');

  writeJob('job-1', 2000, 'local-newer');
  const keptLocal = importSnapshot(dbPath, { backupBeforeImport: false });
  assert.equal(keptLocal.updated, 0);
  assert.equal(readJobCompany('job-1'), 'local-newer');

  rewriteSnapshot((snapshot) => {
    const rows = ((snapshot.tables as { jobs: { rows: Array<Record<string, unknown>> } }).jobs
      .rows);
    const row = rows.find((item) => item.id === 'job-1');
    assert.notEqual(row, undefined);
    if (row !== undefined) {
      row.company = 'remote-newer';
      row.updated_at = 3000;
      row.data_json = JSON.stringify({
        ...(JSON.parse(String(row.data_json)) as Record<string, unknown>),
        company: 'remote-newer',
        updatedAt: 3000,
      });
    }
  });
  const remoteWins = importSnapshot(dbPath, { backupBeforeImport: false });
  assert.equal(remoteWins.updated, 1);
  assert.equal(readJobCompany('job-1'), 'remote-newer');

  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO import_logs (
        id, source, profile_count, job_count, ignored_key_count, warning_count, created_at, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source = excluded.source, data_json = excluded.data_json`,
    ).run('log-1', 'local', 0, 0, 0, 0, 1, JSON.stringify({ source: 'local' }));
  } finally {
    db.close();
  }
  exportSnapshot(dbPath);
  rewriteSnapshot((snapshot) => {
    const rows = (
      snapshot.tables as { import_logs: { rows: Array<Record<string, unknown>> } }
    ).import_logs.rows;
    const row = rows.find((item) => item.id === 'log-1');
    assert.notEqual(row, undefined);
    if (row !== undefined) {
      row.source = 'remote';
      row.data_json = JSON.stringify({ source: 'remote' });
    }
  });
  const noUpdatedAt = importSnapshot(dbPath, { backupBeforeImport: false });
  assert.equal(
    noUpdatedAt.warnings.some((warning) => warning.includes('updated_at is unavailable')),
    true,
  );

  const corruptPath = path.join(tempDir, 'corrupt.sqlite3');
  fs.writeFileSync(corruptPath, 'not sqlite', 'utf8');
  assert.equal(doctorDatabase(corruptPath).ok, false);

  runSync(dbPath);
  runSync(dbPath);

  fs.writeFileSync(paths.lockPath, 'active', 'utf8');
  assert.throws(() => runSync(dbPath), /lock file is still active/);
  fs.unlinkSync(paths.lockPath);

  console.log('sync.selftest: passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
