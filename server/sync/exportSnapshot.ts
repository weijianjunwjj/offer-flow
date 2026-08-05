import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../db';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
} from '../migrations';
import { readAppVersion } from './appVersion';
import { assertCoreBusinessV2Structure } from './coreBusinessStructure';
import { getOrCreateDeviceId } from './device';
import { atomicWriteJson, sha256Hex, toStableJson } from './hash';
import { ensureSyncDirs, getSyncPaths } from './paths';
import { listExistingSyncTables, readSnapshotTable } from './tables';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_V2_COVERAGE,
  type ExportSnapshotResult,
  type OfferFlowSnapshot,
  type SnapshotManifest,
  type SyncTableName,
} from './types';

// Snapshot pair 只捕获 v2 核心业务表（SYNC_TABLES）——这 7 张表自 v2 起结构恒定，
// 因此快照文件格式恒为 SNAPSHOT_SCHEMA_VERSION（databaseSchemaVersion 描述被捕获的核心数据模型，仍为 v2）。
// 允许来源数据库为 v2~LATEST 的纯增量升级库：v3~v8 只新增 Radar/能力等表，不改核心业务表。
// 完整 SQLite 一致性备份（baselineBackup）覆盖 Radar 等全部表；Snapshot pair 仅是核心业务逻辑快照。
function openProductionDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    // 先做只读结构守卫：核心表/字段缺失时给出明确报错，避免后续读取抛出裸 SQLite 错误。
    assertCoreBusinessV2Structure(db, '导出源数据库');
    // getDatabaseSchemaVersion 复用生产库增量 schema 安全校验：
    // 拒绝 migration 缺号/乱序、名称篡改、未知未来版本；禁止仅判断 version >= 2。
    const schemaVersion = getDatabaseSchemaVersion(db);
    if (schemaVersion < PRODUCTION_SCHEMA_VERSION || schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `official snapshot requires database schema ${PRODUCTION_SCHEMA_VERSION}~${LATEST_SCHEMA_VERSION}; `
        + `current version is ${schemaVersion}. `
        + `Snapshot 仅从 v2 生产底座及其纯增量升级库（v${PRODUCTION_SCHEMA_VERSION}~v${LATEST_SCHEMA_VERSION}）`
        + `导出核心业务表，不伪造 schema v${schemaVersion} 的 Snapshot。`,
      );
    }
    const appMetaSchema = db.prepare(
      "SELECT value FROM app_meta WHERE key = 'schema_version'",
    ).get() as { value: string } | undefined;
    if (appMetaSchema?.value !== String(schemaVersion)) {
      throw new Error('导出源数据库 app_meta schema_version 与 migration 不一致');
    }
  } catch (error) {
    db.close();
    throw error;
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
      coverage: SNAPSHOT_V2_COVERAGE,
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
      coverage: SNAPSHOT_V2_COVERAGE,
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
