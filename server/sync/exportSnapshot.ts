import Database from 'better-sqlite3';
import { initSchema } from '../schema';
import { getDbPath, openDb } from '../db';
import { readAppVersion } from './appVersion';
import { getOrCreateDeviceId } from './device';
import { atomicWriteJson, sha256Hex, toStableJson } from './hash';
import { ensureSyncDirs, getSyncPaths } from './paths';
import { listExistingSyncTables, readSnapshotTable } from './tables';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ExportSnapshotResult,
  type OfferFlowSnapshot,
  type SnapshotManifest,
  type SyncTableName,
} from './types';

function openInitializedDb(dbPath: string): Database.Database {
  const db = openDb(dbPath);
  initSchema(db);
  return db;
}

export function exportSnapshot(dbPath = getDbPath()): ExportSnapshotResult {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  const db = openInitializedDb(dbPath);
  try {
    const deviceId = getOrCreateDeviceId(paths.deviceIdPath);
    const exportedAt = new Date().toISOString();
    const appVersion = readAppVersion();
    const tables: OfferFlowSnapshot['tables'] = {};
    const tableCounts: Partial<Record<SyncTableName, number>> = {};
    for (const table of listExistingSyncTables(db)) {
      const snapshotTable = readSnapshotTable(db, table);
      tables[table] = snapshotTable;
      tableCounts[table] = snapshotTable.rows.length;
    }

    const snapshot: OfferFlowSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt,
      deviceId,
      appVersion,
      tables,
    };
    const snapshotJson = toStableJson(snapshot);
    const snapshotHash = sha256Hex(snapshotJson);
    atomicWriteJson(paths.snapshotPath, snapshot);

    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt,
      deviceId,
      appVersion,
      snapshotHash,
      tableCounts,
    };
    atomicWriteJson(paths.manifestPath, manifest);

    return {
      snapshotPath: paths.snapshotPath,
      manifestPath: paths.manifestPath,
      snapshotHash,
      tableCounts,
      exportedAt,
      deviceId,
    };
  } finally {
    db.close();
  }
}
