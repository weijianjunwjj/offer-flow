import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
} from '../../migrations';
import { atomicWriteJson, sha256Hex } from '../../sync/hash';
import { getSyncPaths } from '../../sync/paths';
import {
  assertNoSymbolicLinks,
  isPathInside,
  resolveUpgradePaths,
  type UpgradePathsInput,
} from '../upgrade/pathSafety';
import {
  captureCurrentProductionState,
  verifyCurrentProductionDatabase,
  type CurrentProductionCounts,
} from './currentVerification';

export interface CurrentBaselineBackupManifest {
  version: 1;
  purpose: 'r0.1-pre-snapshot-sync';
  backupId: string;
  createdAt: string;
  gitCommit: string;
  /** 生产底座恒为 v2，但允许纯增量升级后的实际版本（v2~LATEST）。 */
  sourceSchemaVersion: number;
  database: {
    fileName: 'offerflow-v2.sqlite3';
    sizeBytes: number;
    sha256: string;
    normalizedFingerprint: string;
    tableCounts: CurrentProductionCounts;
  };
  previousSnapshot: {
    directory: 'snapshot-v2-before-sync';
    files: Array<{ name: string; sizeBytes: number; sha256: string }>;
  };
  integrity: ['ok'];
  foreignKeyViolationCount: 0;
}

export interface CreateCurrentBaselineBackupOptions extends UpgradePathsInput {
  backupId?: string;
  now?: Date;
  snapshotDirectory?: string;
}

export interface CurrentBaselineBackupResult {
  backupId: string;
  relativeLocation: string;
  databaseSizeBytes: number;
  databaseShortHash: string;
  snapshotFilesVerified: 2;
  sourceFingerprintUnchanged: true;
}

function makeBackupId(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${timestamp}-r01-${crypto.randomBytes(4).toString('hex')}`;
}

function resolveRunDirectory(root: string, backupId: string): string {
  if (!/^\d{8}-\d{6}-r01-[a-f0-9]{8}$/u.test(backupId)) {
    throw new Error('R0.1 backup ID 格式无效');
  }
  const target = path.resolve(root, backupId);
  if (!isPathInside(root, target) || target === path.resolve(root)) {
    throw new Error('R0.1 backup ID 逃逸备份目录');
  }
  return target;
}

function currentGitCommit(workspaceDirectory: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('无法读取当前 Git Commit');
  return result.stdout.trim();
}

function readDatabaseHealth(databasePath: string): {
  schema: number;
  integrity: string[];
  foreignKeys: number;
} {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return {
      schema: getDatabaseSchemaVersion(db),
      integrity: db.prepare('PRAGMA integrity_check').pluck().all() as string[],
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length,
    };
  } finally {
    db.close();
  }
}

function isSupportedProductionSchema(schema: number): boolean {
  return Number.isInteger(schema)
    && schema >= PRODUCTION_SCHEMA_VERSION
    && schema <= LATEST_SCHEMA_VERSION;
}

function readManifest(filePath: string): CurrentBaselineBackupManifest {
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CurrentBaselineBackupManifest;
  if (
    manifest.version !== 1
    || manifest.purpose !== 'r0.1-pre-snapshot-sync'
    || !isSupportedProductionSchema(manifest.sourceSchemaVersion)
    || manifest.database?.fileName !== 'offerflow-v2.sqlite3'
    || manifest.previousSnapshot?.directory !== 'snapshot-v2-before-sync'
  ) throw new Error('R0.1 backup manifest 结构无效');
  return manifest;
}

export function verifyCurrentBaselineBackup(
  backupDirectory: string,
  backupId: string,
): CurrentBaselineBackupResult {
  const targetDirectory = resolveRunDirectory(path.resolve(backupDirectory), backupId);
  assertNoSymbolicLinks(targetDirectory);
  const manifest = readManifest(path.join(targetDirectory, 'backup-manifest.json'));
  if (manifest.backupId !== backupId) throw new Error('R0.1 backup ID 与 manifest 不一致');
  const databasePath = path.join(targetDirectory, manifest.database.fileName);
  const bytes = fs.readFileSync(databasePath);
  if (bytes.byteLength !== manifest.database.sizeBytes || sha256Hex(bytes) !== manifest.database.sha256) {
    throw new Error('R0.1 数据库备份 hash/size 不一致');
  }
  const health = readDatabaseHealth(databasePath);
  if (
    health.schema !== manifest.sourceSchemaVersion
    || !isSupportedProductionSchema(health.schema)
    || health.integrity.length !== 1
    || health.integrity[0] !== 'ok'
    || health.foreignKeys !== 0
  ) {
    throw new Error('R0.1 数据库备份未通过 schema/integrity/FK');
  }
  const backupState = captureCurrentProductionState(databasePath);
  if (
    backupState.normalizedFingerprint !== manifest.database.normalizedFingerprint
    || JSON.stringify(backupState.tableCounts) !== JSON.stringify(manifest.database.tableCounts)
  ) throw new Error('R0.1 数据库备份规范化指纹或聚合不一致');
  for (const file of manifest.previousSnapshot.files) {
    const content = fs.readFileSync(path.join(
      targetDirectory,
      manifest.previousSnapshot.directory,
      file.name,
    ));
    if (content.byteLength !== file.sizeBytes || sha256Hex(content) !== file.sha256) {
      throw new Error('R0.1 旧正式 Snapshot 备份 hash/size 不一致');
    }
  }
  if (manifest.previousSnapshot.files.length !== 2) {
    throw new Error('R0.1 旧正式 Snapshot 备份必须包含完整 pair');
  }
  return {
    backupId,
    relativeLocation: `backups/job-memory-v2/${backupId}`,
    databaseSizeBytes: bytes.byteLength,
    databaseShortHash: manifest.database.sha256.slice(0, 12),
    snapshotFilesVerified: 2,
    sourceFingerprintUnchanged: true,
  };
}

export function verifyCurrentBaselineBackupMatchesSource(
  backupDirectory: string,
  backupId: string,
  sourceDatabasePath: string,
): CurrentBaselineBackupResult {
  const result = verifyCurrentBaselineBackup(backupDirectory, backupId);
  const targetDirectory = resolveRunDirectory(path.resolve(backupDirectory), backupId);
  const manifest = readManifest(path.join(targetDirectory, 'backup-manifest.json'));
  const current = captureCurrentProductionState(sourceDatabasePath);
  if (
    current.normalizedFingerprint !== manifest.database.normalizedFingerprint
    || JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.database.tableCounts)
  ) throw new Error('R0.1 pre-sync 备份与当前生产数据库不一致，拒绝发布 Snapshot');
  return result;
}

export async function createCurrentBaselineBackup(
  options: CreateCurrentBaselineBackupOptions,
): Promise<CurrentBaselineBackupResult> {
  const paths = resolveUpgradePaths(options);
  // 先跑只读 verify（含 v2 核心结构守卫），使结构损坏产出确定性报错，
  // 而非让随后的 captureCurrentProductionState 抛出裸 SQLite 错误。
  verifyCurrentProductionDatabase(paths.sourceDatabasePath, { requireSnapshotConsistency: false });
  const sourceBefore = captureCurrentProductionState(paths.sourceDatabasePath);
  const snapshotDirectory = path.resolve(
    options.snapshotDirectory ?? getSyncPaths(paths.sourceDatabasePath).syncDir,
  );
  assertNoSymbolicLinks(snapshotDirectory);
  const id = options.backupId ?? makeBackupId(options.now);
  fs.mkdirSync(paths.backupDirectory, { recursive: true });
  const targetDirectory = resolveRunDirectory(paths.backupDirectory, id);
  if (fs.existsSync(targetDirectory)) throw new Error('R0.1 backup ID 已存在，禁止覆盖');
  fs.mkdirSync(targetDirectory);
  try {
    const databasePath = path.join(targetDirectory, 'offerflow-v2.sqlite3');
    const source = new Database(paths.sourceDatabasePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('query_only = ON');
      await source.backup(databasePath);
    } finally {
      source.close();
    }
    const databaseBytes = fs.readFileSync(databasePath);
    const databaseHealth = readDatabaseHealth(databasePath);
    if (
      !isSupportedProductionSchema(databaseHealth.schema)
      || databaseHealth.integrity.length !== 1
      || databaseHealth.integrity[0] !== 'ok'
      || databaseHealth.foreignKeys !== 0
    ) throw new Error('R0.1 online backup 未通过 schema/integrity/FK');
    const backupState = captureCurrentProductionState(databasePath);
    if (backupState.normalizedFingerprint !== sourceBefore.normalizedFingerprint) {
      throw new Error('R0.1 online backup 与源数据库规范化指纹不一致');
    }

    const snapshotTarget = path.join(targetDirectory, 'snapshot-v2-before-sync');
    fs.mkdirSync(snapshotTarget);
    const snapshotFiles = ['offerflow.snapshot.json', 'offerflow.manifest.json'].map((name) => {
      const sourcePath = path.join(snapshotDirectory, name);
      if (!fs.existsSync(sourcePath)) throw new Error('正式 Snapshot pair 不完整，拒绝创建 pre-sync 备份');
      const targetPath = path.join(snapshotTarget, name);
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      const content = fs.readFileSync(targetPath);
      return { name, sizeBytes: content.byteLength, sha256: sha256Hex(content) };
    });
    const manifest: CurrentBaselineBackupManifest = {
      version: 1,
      purpose: 'r0.1-pre-snapshot-sync',
      backupId: id,
      createdAt: (options.now ?? new Date()).toISOString(),
      gitCommit: currentGitCommit(paths.workspaceDirectory),
      sourceSchemaVersion: databaseHealth.schema,
      database: {
        fileName: 'offerflow-v2.sqlite3',
        sizeBytes: databaseBytes.byteLength,
        sha256: sha256Hex(databaseBytes),
        normalizedFingerprint: sourceBefore.normalizedFingerprint,
        tableCounts: sourceBefore.tableCounts,
      },
      previousSnapshot: {
        directory: 'snapshot-v2-before-sync',
        files: snapshotFiles,
      },
      integrity: ['ok'],
      foreignKeyViolationCount: 0,
    };
    atomicWriteJson(path.join(targetDirectory, 'backup-manifest.json'), manifest);
    const sourceAfter = captureCurrentProductionState(paths.sourceDatabasePath);
    if (sourceAfter.normalizedFingerprint !== sourceBefore.normalizedFingerprint) {
      throw new Error('R0.1 备份期间源数据库发生变化');
    }
    return verifyCurrentBaselineBackup(paths.backupDirectory, id);
  } catch (error) {
    if (!isPathInside(paths.backupDirectory, targetDirectory)) {
      throw new Error('拒绝清理 R0.1 备份根目录之外的路径');
    }
    fs.rmSync(targetDirectory, { recursive: true, force: true });
    throw error;
  }
}
