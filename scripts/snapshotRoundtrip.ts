import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const sourceSnapshotPath = path.join(projectRoot, 'sync', 'offerflow.snapshot.json');
const sourceManifestPath = path.join(projectRoot, 'sync', 'offerflow.manifest.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-snapshot-roundtrip-'));
const dbPath = path.join(tempDir, 'data', 'offerflow.sqlite3');
const importSyncDir = path.join(tempDir, 'import-sync');
const exportSyncDir = path.join(tempDir, 'export-sync');

process.env.OFFERFLOW_DB_PATH = dbPath;
process.env.OFFERFLOW_SYNC_DIR = importSyncDir;
process.env.OFFERFLOW_BACKUP_DIR = path.join(tempDir, 'backups');
process.env.OFFERFLOW_CORRUPTED_DIR = path.join(tempDir, 'corrupted');
process.env.OFFERFLOW_DEVICE_ID_PATH = path.join(tempDir, 'device-id.txt');

const { ensureInitializedDatabase } = await import('../server/sync/database');
const { importSnapshot } = await import('../server/sync/importSnapshot');
const { exportSnapshot } = await import('../server/sync/exportSnapshot');
const { auditSnapshotConsistency, BUSINESS_SYNC_TABLES } = await import(
  '../server/sync/consistency'
);

function readBusinessTables(snapshotPath: string): Record<string, unknown> {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
    tables: Record<string, unknown>;
  };
  return Object.fromEntries(BUSINESS_SYNC_TABLES.map((table) => [table, snapshot.tables[table]]));
}

try {
  fs.mkdirSync(importSyncDir, { recursive: true });
  fs.copyFileSync(sourceSnapshotPath, path.join(importSyncDir, 'offerflow.snapshot.json'));
  fs.copyFileSync(sourceManifestPath, path.join(importSyncDir, 'offerflow.manifest.json'));
  const sourceSnapshot = JSON.parse(fs.readFileSync(sourceSnapshotPath, 'utf8')) as {
    appVersion: string;
  };
  const sourceBusinessTables = readBusinessTables(sourceSnapshotPath);

  ensureInitializedDatabase(dbPath);
  importSnapshot(dbPath, { backupBeforeImport: false });
  const importedAudit = auditSnapshotConsistency(dbPath);
  assert.equal(importedAudit.ok, true);

  process.env.OFFERFLOW_SYNC_DIR = exportSyncDir;
  process.env.OFFERFLOW_DEVICE_ID_PATH = path.join(tempDir, 'export-device-id.txt');
  const exported = exportSnapshot(dbPath);
  const exportedBusinessTables = readBusinessTables(
    path.join(exportSyncDir, 'offerflow.snapshot.json'),
  );
  assert.deepEqual(exportedBusinessTables, sourceBusinessTables);

  console.log(
    JSON.stringify(
      {
        ok: true,
        appVersion: sourceSnapshot.appVersion,
        importedCounts: Object.fromEntries(
          BUSINESS_SYNC_TABLES.map((table) => [
            table,
            importedAudit.tables[table].databaseCount,
          ]),
        ),
        reExportedCounts: Object.fromEntries(
          BUSINESS_SYNC_TABLES.map((table) => [table, exported.tableCounts[table] ?? 0]),
        ),
        businessTablesSemanticallyEqual: true,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
