import fs from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../db';
import { ensureInitializedDatabase } from './database';
import { doctorDatabase } from './doctor';
import { exportSnapshot } from './exportSnapshot';
import { importSnapshot } from './importSnapshot';
import { ensureSyncDirs, getSyncPaths, timestampForFile } from './paths';
import type { DoctorResult, ImportSnapshotResult } from './types';

export interface BootstrapSyncResult {
  doctor: DoctorResult | null;
  importResult: ImportSnapshotResult | null;
  recoveredFromCorruption: boolean;
  warnings: string[];
}

function moveIfExists(sourcePath: string, targetDir: string, stamp: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const parsed = path.parse(sourcePath);
  const targetPath = path.join(targetDir, `${parsed.name}.${stamp}${parsed.ext}`);
  fs.renameSync(sourcePath, targetPath);
}

export function isolateCorruptDatabase(dbPath = getDbPath()): void {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  const stamp = timestampForFile();
  moveIfExists(dbPath, paths.corruptedDir, stamp);
  moveIfExists(`${dbPath}-wal`, paths.corruptedDir, stamp);
  moveIfExists(`${dbPath}-shm`, paths.corruptedDir, stamp);
}

export function runStartupSync(dbPath = getDbPath()): BootstrapSyncResult {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  const warnings: string[] = [];
  const snapshotExists = fs.existsSync(paths.snapshotPath);

  if (!fs.existsSync(dbPath)) {
    ensureInitializedDatabase(dbPath);
  }

  let doctor = doctorDatabase(dbPath);
  let recoveredFromCorruption = false;

  if (!doctor.ok) {
    console.error('[sync] local SQLite is corrupt; isolating database before recovery');
    isolateCorruptDatabase(dbPath);
    recoveredFromCorruption = true;
    if (!snapshotExists) {
      throw new Error(
        `local SQLite is corrupt and ${paths.snapshotPath} does not exist; refusing to create an empty replacement silently`,
      );
    }
    ensureInitializedDatabase(dbPath);
    const recovered = importSnapshot(dbPath, { backupBeforeImport: false });
    doctor = doctorDatabase(dbPath);
    if (!doctor.ok) {
      throw new Error(`database recovery failed: ${doctor.error ?? doctor.integrity.join('; ')}`);
    }
    return {
      doctor,
      importResult: recovered,
      recoveredFromCorruption,
      warnings: [...warnings, ...recovered.warnings],
    };
  }

  if (snapshotExists) {
    const importResult = importSnapshot(dbPath, { backupBeforeImport: true });
    return {
      doctor,
      importResult,
      recoveredFromCorruption,
      warnings: [...warnings, ...doctor.warnings, ...importResult.warnings],
    };
  }

  return {
    doctor,
    importResult: null,
    recoveredFromCorruption,
    warnings: [...warnings, ...doctor.warnings],
  };
}

export function createShutdownSnapshotExporter(dbPath = getDbPath()): () => void {
  let didExport = false;
  return () => {
    if (didExport) {
      return;
    }
    didExport = true;
    try {
      exportSnapshot(dbPath);
    } catch (error) {
      console.error('[sync] failed to export snapshot during shutdown:', error);
      throw error;
    }
  };
}
