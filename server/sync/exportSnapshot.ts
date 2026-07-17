import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../db';
import { getDatabaseSchemaVersion } from '../migrations';
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

function openProductionDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const schemaVersion = getDatabaseSchemaVersion(db);
  if (schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `official snapshot requires database schema ${SNAPSHOT_SCHEMA_VERSION}; current version is ${schemaVersion}. `
      + `当前 Snapshot 契约仅支持 schema ${SNAPSHOT_SCHEMA_VERSION}；v0.7 使用已验证的数据库一致性备份作为恢复机制，`
      + `不发布、不伪造 schema v${schemaVersion} 的 Snapshot。`,
    );
  }
  return db;
}

export interface SnapshotPublishTestHooks {
  failAfterSnapshotReplace?: boolean;
  validatePublished?: () => void;
}

export function publishSnapshotPairAtomically(
  stagingDirectory: string,
  targetDirectory: string,
  hooks: SnapshotPublishTestHooks = {},
): void {
  const names = ['offerflow.snapshot.json', 'offerflow.manifest.json'] as const;
  const staged = names.map((name) => path.join(stagingDirectory, name));
  if (staged.some((file) => !fs.existsSync(file))) {
    throw new Error('snapshot staging 文件不完整');
  }
  fs.mkdirSync(targetDirectory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const targets = names.map((name) => path.join(targetDirectory, name));
  const rollbacks = names.map((name) => path.join(targetDirectory, `${name}.${nonce}.rollback.tmp`));
  const hadTarget = targets.map((file) => fs.existsSync(file));
  let replaced = 0;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (hadTarget[index]) fs.renameSync(targets[index]!, rollbacks[index]!);
    }
    fs.renameSync(staged[0]!, targets[0]!);
    replaced = 1;
    if (hooks.failAfterSnapshotReplace) throw new Error('B7B_TEST_SNAPSHOT_PUBLISH_FAILURE');
    fs.renameSync(staged[1]!, targets[1]!);
    replaced = 2;
    const snapshotText = fs.readFileSync(targets[0]!, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(targets[1]!, 'utf8')) as SnapshotManifest;
    if (manifest.snapshotHash !== sha256Hex(snapshotText)) {
      throw new Error('原子发布后的 snapshot/manifest hash 不一致');
    }
    hooks.validatePublished?.();
    for (const rollback of rollbacks) {
      if (fs.existsSync(rollback)) fs.rmSync(rollback);
    }
  } catch (error) {
    for (let index = 0; index < replaced; index += 1) {
      if (fs.existsSync(targets[index]!)) fs.rmSync(targets[index]!);
    }
    for (let index = 0; index < rollbacks.length; index += 1) {
      if (fs.existsSync(rollbacks[index]!)) fs.renameSync(rollbacks[index]!, targets[index]!);
    }
    throw error;
  } finally {
    for (const rollback of rollbacks) {
      if (fs.existsSync(rollback)) fs.rmSync(rollback);
    }
  }
}

export function exportSnapshotToDirectory(
  dbPath: string,
  snapshotDirectory: string,
  deviceId: string,
): ExportSnapshotResult {
  const db = openProductionDb(dbPath);
  try {
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
      databaseSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt,
      deviceId,
      appVersion,
      tables,
    };
    const snapshotJson = toStableJson(snapshot);
    const snapshotHash = sha256Hex(snapshotJson);
    const snapshotPath = path.join(snapshotDirectory, 'offerflow.snapshot.json');
    const manifestPath = path.join(snapshotDirectory, 'offerflow.manifest.json');
    atomicWriteJson(snapshotPath, snapshot);

    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      databaseSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt,
      deviceId,
      appVersion,
      snapshotHash,
      tableCounts,
    };
    atomicWriteJson(manifestPath, manifest);

    return {
      snapshotPath,
      manifestPath,
      snapshotHash,
      tableCounts,
      exportedAt,
      deviceId,
    };
  } finally {
    db.close();
  }
}

export function exportSnapshot(
  dbPath = getDbPath(),
  hooks: SnapshotPublishTestHooks = {},
): ExportSnapshotResult {
  const paths = getSyncPaths(dbPath);
  ensureSyncDirs(paths);
  const deviceId = getOrCreateDeviceId(paths.deviceIdPath);
  const stagingDirectory = fs.mkdtempSync(path.join(paths.syncDir, '.offerflow-publish-'));
  try {
    const staged = exportSnapshotToDirectory(dbPath, stagingDirectory, deviceId);
    publishSnapshotPairAtomically(stagingDirectory, paths.syncDir, hooks);
    return {
      ...staged,
      snapshotPath: paths.snapshotPath,
      manifestPath: paths.manifestPath,
    };
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
