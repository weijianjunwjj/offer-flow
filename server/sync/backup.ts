import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../db';
import { doctorDatabase } from './doctor';
import { ensureSyncDirs, getSyncPaths, timestampForFile } from './paths';
import type { BackupResult } from './types';

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function backupDatabase(dbPath = getDbPath()): BackupResult {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  const warnings: string[] = [];
  const stamp = `${timestampForFile()}-${process.pid}-${Date.now() % 100000}`;
  const result: BackupResult = { ok: true, warnings };

  if (fs.existsSync(dbPath)) {
    const sqliteBackupPath = path.join(paths.backupsDir, `offerflow-${stamp}.sqlite3`);
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.exec(`VACUUM INTO ${sqlStringLiteral(sqliteBackupPath)}`);
      const backupDoctor = doctorDatabase(sqliteBackupPath);
      if (!backupDoctor.ok) {
        result.ok = false;
        warnings.push(`sqlite backup integrity check failed: ${backupDoctor.error ?? backupDoctor.integrity.join('; ')}`);
      }
      result.sqliteBackupPath = sqliteBackupPath;
    } finally {
      db.close();
    }
  } else {
    warnings.push('database file does not exist; skipped sqlite backup');
  }

  if (fs.existsSync(paths.snapshotPath)) {
    const snapshotBackupPath = path.join(paths.backupsDir, `offerflow.snapshot-${stamp}.json`);
    fs.copyFileSync(paths.snapshotPath, snapshotBackupPath);
    result.snapshotBackupPath = snapshotBackupPath;
  }
  if (fs.existsSync(paths.manifestPath)) {
    const manifestBackupPath = path.join(paths.backupsDir, `offerflow.manifest-${stamp}.json`);
    fs.copyFileSync(paths.manifestPath, manifestBackupPath);
    result.manifestBackupPath = manifestBackupPath;
  }

  return result;
}
