import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-snapshot-consistency-'));
const dbPath = path.join(tempDir, 'data', 'offerflow.sqlite3');
const importedDbPath = path.join(tempDir, 'imported', 'offerflow.sqlite3');
const syncDir = path.join(tempDir, 'sync');
const roundtripSyncDir = path.join(tempDir, 'roundtrip-sync');

process.env.OFFERFLOW_DB_PATH = dbPath;
process.env.OFFERFLOW_SYNC_DIR = syncDir;
process.env.OFFERFLOW_BACKUP_DIR = path.join(tempDir, 'backups');
process.env.OFFERFLOW_CORRUPTED_DIR = path.join(tempDir, 'corrupted');
process.env.OFFERFLOW_DEVICE_ID_PATH = path.join(tempDir, 'device-id.txt');

const { openDb } = await import('../server/db');
const { initSchema } = await import('../server/schema');
const { exportSnapshot } = await import('../server/sync/exportSnapshot');
const { importSnapshot } = await import('../server/sync/importSnapshot');
const { runSync } = await import('../server/sync/syncRunner');
const { auditSnapshotConsistency, BUSINESS_SYNC_TABLES } = await import(
  '../server/sync/consistency'
);

function writeJob(targetDbPath: string, id: string, updatedAt: number, company: string): void {
  const db = openDb(targetDbPath);
  try {
    initSchema(db);
    const record = { id, createdAt: 100, updatedAt, company };
    db.prepare(
      `INSERT INTO jobs (
        id, company, role, city, salary_range, match_score,
        communication_status, updated_at, created_at, data_json
      ) VALUES (?, ?, '', '', '', NULL, 'not_contacted', ?, 100, ?)
      ON CONFLICT(id) DO UPDATE SET
        company = excluded.company,
        updated_at = excluded.updated_at,
        data_json = excluded.data_json`,
    ).run(id, company, updatedAt, JSON.stringify(record));
  } finally {
    db.close();
  }
}

function businessTables(snapshotPath: string): Record<string, unknown> {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
    tables: Record<string, unknown>;
  };
  return Object.fromEntries(BUSINESS_SYNC_TABLES.map((table) => [table, snapshot.tables[table]]));
}

try {
  const db = openDb(dbPath);
  try {
    initSchema(db);
    db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)').run(
      'default',
      '{"targetRole":"frontend"}',
      100,
    );
    db.prepare(
      `INSERT INTO import_logs (
        id, source, profile_count, job_count, ignored_key_count, warning_count, created_at, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('log-1', 'fixture', 1, 1, 0, 0, 100, '{"id":"log-1"}');
  } finally {
    db.close();
  }
  writeJob(dbPath, 'job-existing', 100, 'snapshot-version');
  exportSnapshot(dbPath);

  // Reproduce the real risk: the tracked snapshot is stale while SQLite has a newer row and a local-only row.
  writeJob(dbPath, 'job-existing', 200, 'database-newer');
  writeJob(dbPath, 'job-local-only', 300, 'database-only');
  const stale = auditSnapshotConsistency(dbPath);
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.tables.jobs.onlyInDatabase, ['job-local-only']);
  assert.equal(stale.tables.jobs.changed[0]?.id, 'job-existing');

  runSync(dbPath);
  const repaired = auditSnapshotConsistency(dbPath);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.tables.profiles.databaseCount, 1);
  assert.equal(repaired.tables.jobs.databaseCount, 2);
  assert.equal(repaired.tables.import_logs.databaseCount, 1);
  const repairedBusinessTables = businessTables(path.join(syncDir, 'offerflow.snapshot.json'));

  const importedDb = openDb(importedDbPath);
  try {
    initSchema(importedDb);
  } finally {
    importedDb.close();
  }
  importSnapshot(importedDbPath, { backupBeforeImport: false });
  assert.equal(auditSnapshotConsistency(importedDbPath).ok, true);

  process.env.OFFERFLOW_SYNC_DIR = roundtripSyncDir;
  process.env.OFFERFLOW_DEVICE_ID_PATH = path.join(tempDir, 'roundtrip-device-id.txt');
  exportSnapshot(importedDbPath);
  assert.deepEqual(
    businessTables(path.join(roundtripSyncDir, 'offerflow.snapshot.json')),
    repairedBusinessTables,
  );

  console.log('snapshotConsistency.selftest: passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
