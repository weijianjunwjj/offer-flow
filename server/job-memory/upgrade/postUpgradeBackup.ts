import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../../db';
import { getDatabaseSchemaVersion } from '../../migrations';
import { auditSnapshotConsistency } from '../../sync/consistency';
import { sha256Hex } from '../../sync/hash';
import { getSyncPaths } from '../../sync/paths';
import { verifyUpgradeBackup } from './backup';
import {
  assertRealApplyAuthorization,
  getB7BStatePaths,
  readApplyResult,
  writeB7BPrivateJson,
  type RealApplyAuthorization,
} from './realApply';
import {
  assertDistinctDatabasePaths,
  assertNoSymbolicLinks,
  resolveBackupRunDirectory,
  resolveUpgradePaths,
} from './pathSafety';
import { verifyRealUpgradeDatabase } from './realVerification';

export interface PostUpgradeBackupManifest {
  toolVersion: 'b7-b-v1';
  backupId: string;
  approvedBackupId: string;
  preApplyCheckpointId: string;
  createdAt: string;
  gitCommit: string;
  sourceSchemaVersion: 2;
  database: { fileName: 'offerflow-v2.sqlite3'; sizeBytes: number; sha256: string };
  snapshotV2: {
    schemaVersion: 2;
    files: Array<{ name: string; sizeBytes: number; sha256: string }>;
  };
  tableCounts: {
    jobs: 13;
    profiles: 1;
    originalImportLogs: 1;
    migrationAuditLogs: 1;
    resumeVersions: 0;
    applications: 7;
    feedbackEvents: 7;
  };
  integrity: ['ok'];
  foreignKeyViolationCount: 0;
  backfill: {
    skip: 6;
    manualReview: 0;
    projectionDegraded: 7;
    projectionInvalid: 0;
    jobHashChanges: 0;
    secondRunApplications: 0;
    secondRunEvents: 0;
  };
  readOnlySmokePassed: true;
}

export interface PostUpgradeBackupResult {
  backupId: string;
  relativeLocation: string;
  databaseSizeBytes: number;
  databaseShortHash: string;
  snapshotFilesVerified: number;
  manifest: PostUpgradeBackupManifest;
}

function createBackupId(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${timestamp}-b7b-${crypto.randomBytes(4).toString('hex')}`;
}

function databaseHealth(databasePath: string): { integrity: string[]; foreignKeys: number; schema: number } {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return {
      integrity: db.prepare('PRAGMA integrity_check').pluck().all() as string[],
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length,
      schema: getDatabaseSchemaVersion(db),
    };
  } finally {
    db.close();
  }
}

export async function createPostUpgradeBackup(
  authorization: RealApplyAuthorization,
  backupId = createBackupId(),
): Promise<PostUpgradeBackupResult> {
  assertRealApplyAuthorization(authorization);
  const paths = resolveUpgradePaths(authorization);
  if (path.resolve(paths.sourceDatabasePath) !== path.resolve(getDbPath())) {
    throw new Error('post-upgrade backup 只允许默认真实数据库');
  }
  const approved = await verifyUpgradeBackup(authorization);
  const apply = readApplyResult(paths.backupDirectory);
  const states = getB7BStatePaths(paths.backupDirectory);
  if (!fs.existsSync(states.smoke)) throw new Error('真实只读 smoke 尚未完成');
  const smoke = JSON.parse(fs.readFileSync(states.smoke, 'utf8')) as { ok?: boolean; gitCommit?: string };
  if (smoke.ok !== true || smoke.gitCommit !== apply.applyGitCommit) {
    throw new Error('真实只读 smoke 结果与 apply Commit 不一致');
  }
  const verification = verifyRealUpgradeDatabase(paths.sourceDatabasePath, approved.manifest);
  const snapshotAudit = auditSnapshotConsistency(paths.sourceDatabasePath);
  if (!snapshotAudit.ok || snapshotAudit.snapshotSchemaVersion !== 2) {
    throw new Error('创建升级后备份前正式 Snapshot v2 不一致');
  }

  const targetDirectory = resolveBackupRunDirectory(paths.backupDirectory, backupId);
  if (fs.existsSync(targetDirectory)) throw new Error('升级后备份 ID 已存在，禁止覆盖');
  fs.mkdirSync(targetDirectory, { recursive: false });
  const databasePath = path.join(targetDirectory, 'offerflow-v2.sqlite3');
  assertDistinctDatabasePaths(paths.sourceDatabasePath, databasePath);
  try {
    const source = new Database(paths.sourceDatabasePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('query_only = ON');
      await source.backup(databasePath);
    } finally {
      source.close();
    }
    const health = databaseHealth(databasePath);
    if (health.schema !== 2 || health.integrity[0] !== 'ok' || health.foreignKeys !== 0) {
      throw new Error('升级后 SQLite 备份未通过 schema/integrity/FK');
    }
    const databaseBytes = fs.readFileSync(databasePath);
    const snapshotSource = getSyncPaths(paths.sourceDatabasePath).syncDir;
    assertNoSymbolicLinks(snapshotSource);
    const snapshotTarget = path.join(targetDirectory, 'snapshot-v2');
    fs.mkdirSync(snapshotTarget);
    const snapshotFiles: PostUpgradeBackupManifest['snapshotV2']['files'] = [];
    for (const name of ['offerflow.snapshot.json', 'offerflow.manifest.json'] as const) {
      const sourcePath = path.join(snapshotSource, name);
      const targetPath = path.join(snapshotTarget, name);
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      const content = fs.readFileSync(targetPath);
      snapshotFiles.push({ name, sizeBytes: content.byteLength, sha256: sha256Hex(content) });
    }
    const manifest: PostUpgradeBackupManifest = {
      toolVersion: 'b7-b-v1',
      backupId,
      approvedBackupId: authorization.backupId,
      preApplyCheckpointId: apply.preApplyCheckpointId,
      createdAt: new Date().toISOString(),
      gitCommit: apply.applyGitCommit,
      sourceSchemaVersion: 2,
      database: {
        fileName: 'offerflow-v2.sqlite3',
        sizeBytes: databaseBytes.byteLength,
        sha256: sha256Hex(databaseBytes),
      },
      snapshotV2: { schemaVersion: 2, files: snapshotFiles },
      tableCounts: verification.tableCounts as PostUpgradeBackupManifest['tableCounts'],
      integrity: ['ok'],
      foreignKeyViolationCount: 0,
      backfill: {
        skip: 6,
        manualReview: 0,
        projectionDegraded: 7,
        projectionInvalid: 0,
        jobHashChanges: 0,
        secondRunApplications: 0,
        secondRunEvents: 0,
      },
      readOnlySmokePassed: true,
    };
    writeB7BPrivateJson(path.join(targetDirectory, 'backup-manifest.json'), manifest);
    writeB7BPrivateJson(path.join(targetDirectory, 'apply-result.json'), {
      ...apply,
      postUpgradeBackupId: backupId,
      readOnlySmokePassed: true,
    });
    const approvedAfter = await verifyUpgradeBackup(authorization);
    if (approvedAfter.databaseHash !== approved.databaseHash) {
      throw new Error('创建升级后备份期间批准备份发生变化');
    }
    return {
      backupId,
      relativeLocation: `backups/job-memory-v2/${backupId}`,
      databaseSizeBytes: databaseBytes.byteLength,
      databaseShortHash: manifest.database.sha256.slice(0, 12),
      snapshotFilesVerified: snapshotFiles.length,
      manifest,
    };
  } catch (error) {
    fs.rmSync(targetDirectory, { recursive: true, force: true });
    throw error;
  }
}
