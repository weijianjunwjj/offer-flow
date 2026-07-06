import fs from 'node:fs';
import { getDbPath } from '../db';
import { backupDatabase } from './backup';
import { ensureInitializedDatabase } from './database';
import { doctorDatabase } from './doctor';
import { exportSnapshot } from './exportSnapshot';
import { importSnapshot } from './importSnapshot';
import { ensureSyncDirs, getSyncPaths } from './paths';
import type { SyncRunResult } from './types';

const LOCK_TTL_MS = 5 * 60 * 1000;

function acquireLock(lockPath: string): void {
  if (fs.existsSync(lockPath)) {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < LOCK_TTL_MS) {
      throw new Error('sync is already running; lock file is still active');
    }
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function releaseLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    console.error('[sync] failed to remove lock:', error);
  }
}

export function runSync(dbPath = getDbPath()): SyncRunResult {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  acquireLock(paths.lockPath);
  try {
    ensureInitializedDatabase(dbPath);
    const doctor = doctorDatabase(dbPath);
    if (!doctor.ok) {
      throw new Error(`database doctor failed: ${doctor.error ?? doctor.integrity.join('; ')}`);
    }
    const importResult = fs.existsSync(paths.snapshotPath)
      ? importSnapshot(dbPath, { backupBeforeImport: true })
      : null;
    const exportResult = exportSnapshot(dbPath);
    const backupResult = backupDatabase(dbPath);
    return {
      doctor,
      importResult,
      exportResult,
      backupResult,
      warnings: [
        ...doctor.warnings,
        ...(importResult?.warnings ?? []),
        ...backupResult.warnings,
      ],
    };
  } finally {
    releaseLock(paths.lockPath);
  }
}

export function hasActiveSyncLock(dbPath = getDbPath()): boolean {
  const { lockPath } = getSyncPaths(dbPath);
  if (!fs.existsSync(lockPath)) {
    return false;
  }
  return Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_TTL_MS;
}
