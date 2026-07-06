import fs from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../db';
import type { SyncPaths } from './types';

export function getSyncPaths(dbPath = getDbPath()): SyncPaths {
  const dataDir = path.dirname(dbPath);
  const syncDir = process.env.OFFERFLOW_SYNC_DIR ?? path.join(process.cwd(), 'sync');
  const backupsDir = process.env.OFFERFLOW_BACKUP_DIR ?? path.join(process.cwd(), 'backups');
  const corruptedDir =
    process.env.OFFERFLOW_CORRUPTED_DIR ?? path.join(dataDir, 'corrupted');
  return {
    dbPath,
    dataDir,
    syncDir,
    backupsDir,
    corruptedDir,
    snapshotPath: path.join(syncDir, 'offerflow.snapshot.json'),
    manifestPath: path.join(syncDir, 'offerflow.manifest.json'),
    lockPath: path.join(syncDir, 'offerflow.sync.lock'),
    deviceIdPath: process.env.OFFERFLOW_DEVICE_ID_PATH ?? path.join(dataDir, 'device-id.txt'),
  };
}

export function ensureSyncDirs(paths = getSyncPaths()): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.syncDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  fs.mkdirSync(paths.corruptedDir, { recursive: true });
}

export function timestampForFile(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}
