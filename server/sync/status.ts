import fs from 'node:fs';
import { getDbPath } from '../db';
import { getOrCreateDeviceId } from './device';
import { doctorDatabase } from './doctor';
import { getSyncPaths } from './paths';
import { hasActiveSyncLock } from './syncRunner';
import type { SnapshotManifest } from './types';

export interface SyncStatus {
  doctor: ReturnType<typeof doctorDatabase>;
  deviceId: string;
  snapshotExists: boolean;
  manifestExists: boolean;
  lastSyncAt: string | null;
  snapshotHash: string | null;
  shortSnapshotHash: string | null;
  tableCounts: SnapshotManifest['tableCounts'] | null;
  activeLock: boolean;
  warnings: string[];
}

function readManifest(manifestPath: string): SnapshotManifest | null {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
}

export function getSyncStatus(dbPath = getDbPath()): SyncStatus {
  const paths = getSyncPaths(dbPath);
  const manifest = readManifest(paths.manifestPath);
  const snapshotHash = manifest?.snapshotHash ?? null;
  const warnings: string[] = [];
  if (fs.existsSync(paths.snapshotPath) && manifest === null) {
    warnings.push('snapshot exists but manifest is missing');
  }
  const doctor = doctorDatabase(dbPath);
  return {
    doctor,
    deviceId: getOrCreateDeviceId(paths.deviceIdPath),
    snapshotExists: fs.existsSync(paths.snapshotPath),
    manifestExists: fs.existsSync(paths.manifestPath),
    lastSyncAt: manifest?.exportedAt ?? null,
    snapshotHash,
    shortSnapshotHash: snapshotHash === null ? null : snapshotHash.slice(0, 12),
    tableCounts: manifest?.tableCounts ?? null,
    activeLock: hasActiveSyncLock(dbPath),
    warnings: [...warnings, ...doctor.warnings],
  };
}
