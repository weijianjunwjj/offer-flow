import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { getDatabaseSchemaVersion } from '../../migrations';
import { sha256Hex } from '../../sync/hash';
import {
  verifyUpgradeBackup,
  type JobMemoryV2BackupManifest,
} from '../upgrade/backup';
import {
  verifyPostUpgradeBackup,
  type PostUpgradeBackupManifest,
} from '../upgrade/postUpgradeBackup';
import {
  assertNoSymbolicLinks,
  resolveBackupRunDirectory,
} from '../upgrade/pathSafety';

export const B8_APPROVED_V1_BACKUP_ID = '20260714-102807-b7a-6f0ac3d1';
export const B8_PRE_APPLY_CHECKPOINT_ID = '20260714-112449-b7a-8d54a08b';
export const B8_POST_UPGRADE_BACKUP_ID = '20260714-112746-b7b-475bd682';

export interface B8BackupAuditInput {
  sourceDatabasePath: string;
  backupDirectory: string;
  workspaceDirectory: string;
}

export interface BackupAuditSummary {
  backupId: string;
  schemaVersion: 1 | 2;
  databaseSizeBytes: number;
  databaseShortHash: string;
  integrity: 'ok';
  foreignKeyViolationCount: 0;
  profiles: number;
  jobs: number;
  importLogs: number;
  resumeVersions: number | null;
  applications: number | null;
  feedbackEvents: number | null;
  snapshotSchemaVersion: 1 | 2;
  snapshotFilesVerified: 2;
  applyResultVerified: boolean;
  gitIgnored: true;
  symbolicLink: false;
}

export interface B8BackupAuditReport {
  approvedV1: BackupAuditSummary;
  preApplyCheckpoint: BackupAuditSummary;
  postUpgradeV2: BackupAuditSummary;
  checkpointMatchesApprovedSource: true;
  overwrittenDuringAudit: false;
}

interface DatabaseAggregate {
  schemaVersion: number;
  integrity: string;
  foreignKeys: number;
  profiles: number;
  jobs: number;
  importLogs: number;
  resumeVersions: number | null;
  applications: number | null;
  feedbackEvents: number | null;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function tableCount(db: Database.Database, table: string): number | null {
  if (!tableExists(db, table)) return null;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    count: number;
  }).count);
}

function readAggregate(databasePath: string): DatabaseAggregate {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return {
      schemaVersion: getDatabaseSchemaVersion(db),
      integrity: String(db.pragma('integrity_check', { simple: true })),
      foreignKeys: (db.pragma('foreign_key_check') as unknown[]).length,
      profiles: tableCount(db, 'profiles') ?? 0,
      jobs: tableCount(db, 'jobs') ?? 0,
      importLogs: tableCount(db, 'import_logs') ?? 0,
      resumeVersions: tableCount(db, 'resume_versions'),
      applications: tableCount(db, 'applications'),
      feedbackEvents: tableCount(db, 'feedback_events'),
    };
  } finally {
    db.close();
  }
}

function assertGitIgnored(workspaceDirectory: string, candidate: string): void {
  const relative = path.relative(path.resolve(workspaceDirectory), path.resolve(candidate));
  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--no-index', '--', relative],
    { cwd: workspaceDirectory, windowsHide: true, stdio: 'ignore' },
  );
  if (result.status !== 0) throw new Error('B8 备份目录未被 Git ignore');
}

function readSnapshotSchema(directory: string, folder: 'snapshot-v1' | 'snapshot-v2'): 1 | 2 {
  const snapshot = readJson<{ schemaVersion?: unknown }>(
    path.join(directory, folder, 'offerflow.snapshot.json'),
  );
  if (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) {
    throw new Error('备份 Snapshot schema 无效');
  }
  return snapshot.schemaVersion;
}

function assertV1Aggregate(aggregate: DatabaseAggregate): void {
  if (
    aggregate.schemaVersion !== 1
    || aggregate.integrity !== 'ok'
    || aggregate.foreignKeys !== 0
    || aggregate.profiles !== 1
    || aggregate.jobs !== 13
    || aggregate.importLogs !== 1
    || aggregate.resumeVersions !== null
    || aggregate.applications !== null
    || aggregate.feedbackEvents !== null
  ) throw new Error('schema v1 备份聚合不符合 B8 基线');
}

function assertV2Aggregate(aggregate: DatabaseAggregate): void {
  if (
    aggregate.schemaVersion !== 2
    || aggregate.integrity !== 'ok'
    || aggregate.foreignKeys !== 0
    || aggregate.profiles !== 1
    || aggregate.jobs !== 13
    || aggregate.importLogs !== 2
    || aggregate.resumeVersions !== 0
    || aggregate.applications !== 7
    || aggregate.feedbackEvents !== 7
  ) throw new Error('schema v2 备份聚合不符合 B8 基线');
}

function directoryFingerprint(directory: string): string {
  const entries: Array<{ name: string; size: number; hash: string }> = [];
  const visit = (current: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isSymbolicLink()) throw new Error('备份目录不得包含符号链接');
      if (item.isDirectory()) {
        visit(absolute);
      } else if (item.isFile()) {
        const content = fs.readFileSync(absolute);
        entries.push({
          name: path.relative(directory, absolute).replace(/\\/gu, '/'),
          size: content.byteLength,
          hash: sha256Hex(content),
        });
      }
    }
  };
  visit(directory);
  return sha256Hex(JSON.stringify(entries.sort((left, right) => left.name.localeCompare(right.name))));
}

export function captureB8BackupFingerprints(backupDirectory: string): Record<string, string> {
  return Object.fromEntries([
    B8_APPROVED_V1_BACKUP_ID,
    B8_PRE_APPLY_CHECKPOINT_ID,
    B8_POST_UPGRADE_BACKUP_ID,
  ].map((backupId) => {
    const directory = resolveBackupRunDirectory(path.resolve(backupDirectory), backupId);
    return [backupId, directoryFingerprint(directory)];
  }));
}

export function assertB8BackupFingerprintsUnchanged(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('B8 审计期间关键备份发生变化');
  }
}

async function auditV1Backup(
  input: B8BackupAuditInput,
  backupId: string,
): Promise<{ summary: BackupAuditSummary; manifest: JobMemoryV2BackupManifest }> {
  const verified = await verifyUpgradeBackup({ ...input, backupId });
  const directory = resolveBackupRunDirectory(path.resolve(input.backupDirectory), backupId);
  assertNoSymbolicLinks(directory);
  assertGitIgnored(input.workspaceDirectory, path.join(directory, 'backup-manifest.json'));
  const aggregate = readAggregate(path.join(directory, verified.manifest.database.fileName));
  assertV1Aggregate(aggregate);
  const snapshotSchemaVersion = readSnapshotSchema(directory, 'snapshot-v1');
  if (snapshotSchemaVersion !== 1 || verified.snapshotFilesVerified !== 2) {
    throw new Error('v1 备份 Snapshot 不完整');
  }
  return {
    manifest: verified.manifest,
    summary: {
      backupId,
      schemaVersion: 1,
      databaseSizeBytes: verified.databaseSizeBytes,
      databaseShortHash: verified.databaseHash.slice(0, 12),
      integrity: 'ok',
      foreignKeyViolationCount: 0,
      profiles: aggregate.profiles,
      jobs: aggregate.jobs,
      importLogs: aggregate.importLogs,
      resumeVersions: null,
      applications: null,
      feedbackEvents: null,
      snapshotSchemaVersion,
      snapshotFilesVerified: 2,
      applyResultVerified: backupId === B8_PRE_APPLY_CHECKPOINT_ID,
      gitIgnored: true,
      symbolicLink: false,
    },
  };
}

function auditPostUpgradeBackup(input: B8BackupAuditInput): BackupAuditSummary {
  const verified = verifyPostUpgradeBackup(input.backupDirectory, B8_POST_UPGRADE_BACKUP_ID);
  const directory = resolveBackupRunDirectory(
    path.resolve(input.backupDirectory),
    B8_POST_UPGRADE_BACKUP_ID,
  );
  assertNoSymbolicLinks(directory);
  assertGitIgnored(input.workspaceDirectory, path.join(directory, 'backup-manifest.json'));
  const manifest = readJson<PostUpgradeBackupManifest>(path.join(directory, 'backup-manifest.json'));
  const aggregate = readAggregate(path.join(directory, manifest.database.fileName));
  assertV2Aggregate(aggregate);
  const snapshotSchemaVersion = readSnapshotSchema(directory, 'snapshot-v2');
  if (snapshotSchemaVersion !== 2) throw new Error('post-upgrade Snapshot 不是 schema v2');
  return {
    backupId: B8_POST_UPGRADE_BACKUP_ID,
    schemaVersion: 2,
    databaseSizeBytes: verified.databaseSizeBytes,
    databaseShortHash: verified.databaseShortHash,
    integrity: 'ok',
    foreignKeyViolationCount: 0,
    profiles: aggregate.profiles,
    jobs: aggregate.jobs,
    importLogs: aggregate.importLogs,
    resumeVersions: aggregate.resumeVersions,
    applications: aggregate.applications,
    feedbackEvents: aggregate.feedbackEvents,
    snapshotSchemaVersion,
    snapshotFilesVerified: 2,
    applyResultVerified: verified.applyResultVerified,
    gitIgnored: true,
    symbolicLink: false,
  };
}

export async function auditB8Backups(input: B8BackupAuditInput): Promise<B8BackupAuditReport> {
  const before = captureB8BackupFingerprints(input.backupDirectory);
  const approved = await auditV1Backup(input, B8_APPROVED_V1_BACKUP_ID);
  const checkpoint = await auditV1Backup(input, B8_PRE_APPLY_CHECKPOINT_ID);
  const postUpgradeV2 = auditPostUpgradeBackup(input);
  const applyResult = readJson<{
    resultCode?: unknown;
    approvedBackupId?: unknown;
    preApplyCheckpointId?: unknown;
  }>(path.join(
    input.backupDirectory,
    'b7b-state',
    `${B8_APPROVED_V1_BACKUP_ID}-apply-result.json`,
  ));
  if (
    applyResult.resultCode !== 'B7B_APPLY_SUCCESS'
    || applyResult.approvedBackupId !== B8_APPROVED_V1_BACKUP_ID
    || applyResult.preApplyCheckpointId !== B8_PRE_APPLY_CHECKPOINT_ID
  ) throw new Error('v1 批准备份或 pre-apply checkpoint 未绑定最终 apply-result');
  approved.summary.applyResultVerified = true;
  checkpoint.summary.applyResultVerified = true;
  const checkpointMatchesApprovedSource =
    checkpoint.manifest.sourceDatabase.sha256 === approved.manifest.sourceDatabase.sha256
    && checkpoint.manifest.sourceDatabase.businessTableHashes.jobs
      === approved.manifest.sourceDatabase.businessTableHashes.jobs
    && checkpoint.manifest.sourceDatabase.businessTableHashes.profiles
      === approved.manifest.sourceDatabase.businessTableHashes.profiles
    && checkpoint.manifest.sourceDatabase.businessTableHashes.import_logs
      === approved.manifest.sourceDatabase.businessTableHashes.import_logs;
  if (!checkpointMatchesApprovedSource) {
    throw new Error('pre-apply checkpoint 与批准源状态不一致');
  }
  const after = captureB8BackupFingerprints(input.backupDirectory);
  assertB8BackupFingerprintsUnchanged(before, after);
  return {
    approvedV1: approved.summary,
    preApplyCheckpoint: checkpoint.summary,
    postUpgradeV2,
    checkpointMatchesApprovedSource: true,
    overwrittenDuringAudit: false,
  };
}
