import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { atomicWriteJson, sha256Hex } from '../../sync/hash';
import {
  inspectSourceDatabase,
  inspectionFingerprint,
  type DatabaseInspectionReport,
} from './inspection';
import {
  assertDistinctDatabasePaths,
  assertNoSymbolicLinks,
  isPathInside,
  resolveBackupRunDirectory,
  resolveUpgradePaths,
  type UpgradePathsInput,
} from './pathSafety';

export interface JobMemoryV2BackupManifest {
  toolVersion: 'b7-a-v1';
  backupId: string;
  createdAt: string;
  gitCommit: string;
  sourceSchemaVersion: number;
  database: {
    fileName: 'offerflow-v1.sqlite3';
    sizeBytes: number;
    sha256: string;
  };
  sourceDatabase: {
    sizeBytes: number;
    sha256: string;
    businessTableHashes: Record<string, string>;
  };
  tableCounts: Record<string, number>;
  migrations: Array<{ version: number; name: string; appliedAt: number }>;
  integrity: string[];
  foreignKeyViolationCount: number;
  journalMode: string;
  sourceSidecars: { walPresent: boolean; shmPresent: boolean };
  snapshotV1: {
    present: boolean;
    schemaVersion: number | null;
    consistencyOk: boolean | null;
    files: Array<{ name: string; sizeBytes: number; sha256: string }>;
  };
}

export interface CreateUpgradeBackupOptions extends UpgradePathsInput {
  backupId?: string;
  now?: Date;
}

export interface CreateUpgradeBackupResult {
  backupId: string;
  backupDirectory: string;
  manifest: JobMemoryV2BackupManifest;
}

export interface VerifyUpgradeBackupOptions extends UpgradePathsInput {
  backupId: string;
}

export interface VerifyUpgradeBackupResult {
  ok: true;
  backupId: string;
  databaseHash: string;
  databaseSizeBytes: number;
  integrity: string[];
  foreignKeyViolationCount: number;
  snapshotFilesVerified: number;
  manifest: JobMemoryV2BackupManifest;
}

function backupId(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = [
    date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), '-',
    pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds()),
  ].join('');
  return `${stamp}-b7a-${crypto.randomBytes(4).toString('hex')}`;
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

function readIntegrity(databasePath: string): { integrity: string[]; foreignKeyViolationCount: number } {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
      .map((row) => String(row[Object.keys(row)[0] ?? ''] ?? ''));
    const foreignKeyViolationCount = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    return { integrity, foreignKeyViolationCount };
  } finally {
    db.close();
  }
}

function assertHealthyInspection(inspection: DatabaseInspectionReport): void {
  if (!inspection.upgradeEligible) {
    throw new Error('源数据库未通过 B7-A 只读健康门禁，拒绝创建可升级备份');
  }
}

function cleanupCurrentRun(targetDirectory: string, backupRoot: string): void {
  if (!isPathInside(backupRoot, targetDirectory) || targetDirectory === path.resolve(backupRoot)) {
    throw new Error('拒绝清理备份根目录之外的路径');
  }
  fs.rmSync(targetDirectory, { recursive: true, force: true });
}

export async function createUpgradeBackup(
  options: CreateUpgradeBackupOptions,
): Promise<CreateUpgradeBackupResult> {
  const paths = resolveUpgradePaths(options);
  const inspectionBefore = inspectSourceDatabase(options);
  assertHealthyInspection(inspectionBefore);
  fs.mkdirSync(paths.backupDirectory, { recursive: true });
  assertNoSymbolicLinks(paths.backupDirectory);
  const id = options.backupId ?? backupId(options.now);
  const targetDirectory = resolveBackupRunDirectory(paths.backupDirectory, id);
  if (fs.existsSync(targetDirectory)) throw new Error('备份 ID 已存在，禁止覆盖');
  fs.mkdirSync(targetDirectory, { recursive: false });
  const databasePath = path.join(targetDirectory, 'offerflow-v1.sqlite3');
  assertDistinctDatabasePaths(paths.sourceDatabasePath, databasePath);
  try {
    const source = new Database(paths.sourceDatabasePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('query_only = ON');
      await source.backup(databasePath);
    } finally {
      source.close();
    }
    const databaseBytes = fs.readFileSync(databasePath);
    const databaseHealth = readIntegrity(databasePath);
    if (
      databaseHealth.integrity.length !== 1
      || databaseHealth.integrity[0] !== 'ok'
      || databaseHealth.foreignKeyViolationCount !== 0
    ) throw new Error('在线备份未通过 integrity/FK 校验');

    const copiedSnapshotFiles: JobMemoryV2BackupManifest['snapshotV1']['files'] = [];
    const snapshotDirectory = path.join(targetDirectory, 'snapshot-v1');
    for (const file of inspectionBefore.snapshotV1.files) {
      const sourcePath = path.join(paths.workspaceDirectory, 'sync', file.name);
      if (!fs.existsSync(sourcePath)) continue;
      fs.mkdirSync(snapshotDirectory, { recursive: true });
      const targetPath = path.join(snapshotDirectory, file.name);
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      const copied = fs.readFileSync(targetPath);
      const copiedHash = sha256Hex(copied);
      if (copiedHash !== file.sha256) throw new Error('snapshot v1 复制校验失败');
      copiedSnapshotFiles.push({ name: file.name, sizeBytes: copied.byteLength, sha256: copiedHash });
    }

    const inspectionAfter = inspectSourceDatabase(options);
    if (
      inspectionFingerprint(inspectionBefore) !== inspectionFingerprint(inspectionAfter)
      || inspectionBefore.sourceFile.sha256 !== inspectionAfter.sourceFile.sha256
      || JSON.stringify(inspectionBefore.snapshotV1.files) !== JSON.stringify(inspectionAfter.snapshotV1.files)
    ) throw new Error('备份期间源数据库发生变化，拒绝保留本次备份');

    const manifest: JobMemoryV2BackupManifest = {
      toolVersion: 'b7-a-v1',
      backupId: id,
      createdAt: (options.now ?? new Date()).toISOString(),
      gitCommit: currentGitCommit(paths.workspaceDirectory),
      sourceSchemaVersion: inspectionBefore.schemaVersion,
      database: {
        fileName: 'offerflow-v1.sqlite3',
        sizeBytes: databaseBytes.byteLength,
        sha256: sha256Hex(databaseBytes),
      },
      sourceDatabase: {
        sizeBytes: inspectionBefore.sourceFile.sizeBytes,
        sha256: inspectionBefore.sourceFile.sha256,
        businessTableHashes: inspectionBefore.businessTableHashes,
      },
      tableCounts: inspectionBefore.tableCounts,
      migrations: inspectionBefore.migrationRecords,
      integrity: databaseHealth.integrity,
      foreignKeyViolationCount: databaseHealth.foreignKeyViolationCount,
      journalMode: inspectionBefore.journalMode,
      sourceSidecars: {
        walPresent: inspectionBefore.walPresent,
        shmPresent: inspectionBefore.shmPresent,
      },
      snapshotV1: {
        present: copiedSnapshotFiles.length > 0,
        schemaVersion: inspectionBefore.snapshotV1.schemaVersion,
        consistencyOk: inspectionBefore.snapshotV1.consistencyOk,
        files: copiedSnapshotFiles,
      },
    };
    atomicWriteJson(path.join(targetDirectory, 'backup-manifest.json'), manifest);
    await verifyUpgradeBackup({ ...options, backupId: id });
    return { backupId: id, backupDirectory: targetDirectory, manifest };
  } catch (error) {
    cleanupCurrentRun(targetDirectory, paths.backupDirectory);
    throw error;
  }
}

function readManifest(filePath: string): JobMemoryV2BackupManifest {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as JobMemoryV2BackupManifest;
  if (
    parsed.toolVersion !== 'b7-a-v1'
    || typeof parsed.backupId !== 'string'
    || parsed.database?.fileName !== 'offerflow-v1.sqlite3'
    || typeof parsed.database.sha256 !== 'string'
  ) throw new Error('backup manifest 结构无效');
  return parsed;
}

export async function verifyUpgradeBackup(
  options: VerifyUpgradeBackupOptions,
): Promise<VerifyUpgradeBackupResult> {
  const paths = resolveUpgradePaths(options);
  const targetDirectory = resolveBackupRunDirectory(paths.backupDirectory, options.backupId);
  assertNoSymbolicLinks(targetDirectory);
  const manifestPath = path.join(targetDirectory, 'backup-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('backup manifest 不存在');
  const manifest = readManifest(manifestPath);
  if (manifest.backupId !== options.backupId) throw new Error('backup ID 与 manifest 不一致');
  const databasePath = path.join(targetDirectory, manifest.database.fileName);
  if (!fs.existsSync(databasePath)) throw new Error('备份数据库不存在');
  const databaseBytes = fs.readFileSync(databasePath);
  const databaseHash = sha256Hex(databaseBytes);
  if (
    databaseHash !== manifest.database.sha256
    || databaseBytes.byteLength !== manifest.database.sizeBytes
  ) throw new Error('备份数据库 hash/size 与 manifest 不一致');
  const health = readIntegrity(databasePath);
  if (
    health.integrity.length !== 1
    || health.integrity[0] !== 'ok'
    || health.foreignKeyViolationCount !== 0
  ) throw new Error('备份数据库未通过 integrity/FK 校验');
  for (const file of manifest.snapshotV1.files) {
    const filePath = path.join(targetDirectory, 'snapshot-v1', file.name);
    if (!fs.existsSync(filePath)) throw new Error('manifest 中的 snapshot v1 文件不存在');
    const content = fs.readFileSync(filePath);
    if (content.byteLength !== file.sizeBytes || sha256Hex(content) !== file.sha256) {
      throw new Error('snapshot v1 文件未通过 hash/size 校验');
    }
  }
  return {
    ok: true,
    backupId: options.backupId,
    databaseHash,
    databaseSizeBytes: databaseBytes.byteLength,
    integrity: health.integrity,
    foreignKeyViolationCount: health.foreignKeyViolationCount,
    snapshotFilesVerified: manifest.snapshotV1.files.length,
    manifest,
  };
}
