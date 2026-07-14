import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { projectApplication } from '../../../src/domain/job-memory';
import { getDbPath } from '../../db';
import { getDatabaseSchemaVersion, runMigrations } from '../../migrations';
import { sha256Hex } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import type { SnapshotTable, SyncTableName } from '../../sync/types';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import {
  createUpgradeBackup,
  verifyUpgradeBackup,
  type JobMemoryV2BackupManifest,
  type VerifyUpgradeBackupOptions,
} from './backup';
import { inspectSourceDatabase } from './inspection';
import { runLegacyBackfill, type LegacyBackfillSummary } from './legacyBackfill';
import {
  prepareSnapshotV2StagingFromApprovedBackup,
  publishAndVerifyOfficialSnapshotV2,
  type OfficialSnapshotVerification,
} from './officialSnapshot';
import {
  assertDistinctDatabasePaths,
  assertNoSymbolicLinks,
  resolveBackupRunDirectory,
  resolveUpgradePaths,
} from './pathSafety';
import {
  B7B_UPGRADE_META_KEY,
  verifyRealUpgradeDatabase,
  type B7BUpgradeMarker,
  type RealUpgradeVerificationReport,
} from './realVerification';

export const B7B_APPROVED_BACKUP_ID = '20260714-102807-b7a-6f0ac3d1';
export const B7B_EXPECTED_SOURCE_FINGERPRINT = '891d4ccc32c0';
export const B7B_EXPECTED_BACKUP_HASH = 'ba0d599568ad';
export const B7B_APPROVAL_TOKEN = 'B7B-APPLY-20260714-102807-B7A-6F0AC3D1';
export const B7B_REQUIRED_BRANCH = 'feat/v0.7.0-b-trusted-memory';

export interface RealApplyAuthorization extends VerifyUpgradeBackupOptions {
  confirmBackupId: string;
  expectedSourceFingerprint: string;
  expectedBackupHash: string;
  approvalToken: string;
}

export interface AtomicApplyTestHooks {
  failAfterMigration?: boolean;
  failBeforeCommit?: boolean;
  expectedApplications?: number;
  lockTimeoutMs?: number;
}

export interface AtomicApplyResult {
  marker: B7BUpgradeMarker;
  firstRun: LegacyBackfillSummary;
  secondRun: LegacyBackfillSummary;
  verification: RealUpgradeVerificationReport;
}

export interface ApprovedRealApplyResult {
  resultCode: 'B7B_APPLY_SUCCESS';
  applyGitCommit: string;
  approvedBackupId: string;
  preApplyCheckpointId: string;
  verification: RealUpgradeVerificationReport;
  snapshot: OfficialSnapshotVerification;
  approvedBackupUnchanged: true;
}

export interface GitState {
  branch: string;
  head: string;
  clean: boolean;
}

export function assertRealApplyGitState(state: GitState): void {
  if (state.branch !== B7B_REQUIRED_BRANCH) throw new Error('apply-real 分支不正确');
  if (!state.clean) throw new Error('apply-real 要求工作区完全干净');
}

function git(workspaceDirectory: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Git 状态检查失败：${args.join(' ')}`);
  return result.stdout.trim();
}

function readGitState(workspaceDirectory: string): GitState {
  return {
    branch: git(workspaceDirectory, ['branch', '--show-current']),
    head: git(workspaceDirectory, ['rev-parse', 'HEAD']),
    clean: git(workspaceDirectory, ['status', '--porcelain', '--untracked-files=all']) === '',
  };
}

function snapshotHash(table: SnapshotTable): string {
  return sha256Hex(JSON.stringify(table));
}

function readOriginalImportLogs(db: Database.Database): SnapshotTable {
  const table = readSnapshotTable(db, 'import_logs' as SyncTableName);
  return { ...table, rows: table.rows.filter((row) => row.source !== 'job-memory-v2-backfill') };
}

function assertSourceTablesMatchApproved(
  db: Database.Database,
  manifest: JobMemoryV2BackupManifest,
): void {
  for (const table of ['profiles', 'jobs'] as const) {
    if (snapshotHash(readSnapshotTable(db, table as SyncTableName))
      !== manifest.sourceDatabase.businessTableHashes[table]) {
      throw new Error(`独占锁内 ${table} 哈希与批准备份不一致`);
    }
  }
  if (snapshotHash(readOriginalImportLogs(db))
    !== manifest.sourceDatabase.businessTableHashes.import_logs) {
    throw new Error('独占锁内原始 import_logs 哈希与批准备份不一致');
  }
}

function assertAtomicAggregates(
  db: Database.Database,
  first: LegacyBackfillSummary,
  second: LegacyBackfillSummary,
  expectedApplications: number,
): void {
  const count = (table: string): number => Number((db.prepare(
    `SELECT COUNT(*) AS count FROM "${table}"`,
  ).get() as { count: number }).count);
  const projection = { valid: 0, degraded: 0, invalid: 0 };
  const applications = new ApplicationRepository(db).listApplications();
  const events = new FeedbackEventRepository(db);
  for (const application of applications) {
    projection[projectApplication(
      application,
      events.listEventsByApplication(application.id),
    ).projectionStatus] += 1;
  }
  const valid = first.createdApplications === 7
    && first.createdEvents === 7
    && first.actions.skip === 6
    && first.actions.manualReview === 0
    && second.createdApplications === 0
    && second.createdEvents === 0
    && !second.auditLogCreated
    && count('resume_versions') === 0
    && count('applications') === expectedApplications
    && count('feedback_events') === 7
    && projection.valid === 0
    && projection.degraded === 7
    && projection.invalid === 0;
  if (!valid) throw new Error('B7-B backfill 数量或 Projection 硬断言失败');
}

function markerFor(
  authorization: RealApplyAuthorization,
  applyGitCommit: string,
  first: LegacyBackfillSummary,
  second: LegacyBackfillSummary,
): B7BUpgradeMarker {
  return {
    version: 1,
    approvedBackupId: authorization.backupId,
    applyGitCommit,
    sourceFingerprintShort: authorization.expectedSourceFingerprint,
    appliedAt: new Date().toISOString(),
    createdApplications: first.createdApplications as 7,
    createdEvents: first.createdEvents as 7,
    skipCount: first.actions.skip as 6,
    manualReviewCount: first.actions.manualReview as 0,
    projection: { valid: 0, degraded: 7, invalid: 0 },
    secondRun: {
      createdApplications: second.createdApplications as 0,
      createdEvents: second.createdEvents as 0,
      auditLogCreated: second.auditLogCreated as false,
    },
    jobHashChanges: 0,
  };
}

export function applySchemaAndBackfillAtomically(
  databasePath: string,
  manifest: JobMemoryV2BackupManifest,
  authorization: RealApplyAuthorization,
  applyGitCommit: string,
  hooks: AtomicApplyTestHooks = {},
): AtomicApplyResult {
  const sourceHashBefore = sha256Hex(fs.readFileSync(databasePath));
  if (sourceHashBefore.slice(0, 12) !== authorization.expectedSourceFingerprint) {
    throw new Error('正式 apply 前源数据库短指纹不一致');
  }
  const db = new Database(databasePath, { fileMustExist: true, timeout: hooks.lockTimeoutMs ?? 2_500 });
  db.pragma('foreign_keys = ON');
  let firstRun: LegacyBackfillSummary | null = null;
  let secondRun: LegacyBackfillSummary | null = null;
  let marker: B7BUpgradeMarker | null = null;
  try {
    const execute = db.transaction(() => {
      if (getDatabaseSchemaVersion(db) !== 1) throw new Error('独占锁内 source schema 不为 1');
      if (sha256Hex(fs.readFileSync(databasePath)).slice(0, 12)
        !== authorization.expectedSourceFingerprint) {
        throw new Error('取得独占锁后源数据库短指纹发生变化');
      }
      assertSourceTablesMatchApproved(db, manifest);
      runMigrations(db, { targetVersion: 2, transactionMode: 'caller-managed' });
      if (hooks.failAfterMigration) throw new Error('B7B_TEST_FAIL_AFTER_MIGRATION');
      firstRun = runLegacyBackfill(db, { transactionMode: 'caller-managed' });
      secondRun = runLegacyBackfill(db, { transactionMode: 'caller-managed' });
      assertAtomicAggregates(db, firstRun, secondRun, hooks.expectedApplications ?? 7);
      assertSourceTablesMatchApproved(db, manifest);
      marker = markerFor(authorization, applyGitCommit, firstRun, secondRun);
      db.prepare(`
        INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(B7B_UPGRADE_META_KEY, JSON.stringify(marker), Date.now());
      const integrity = (db.prepare('PRAGMA integrity_check').pluck().all() as string[]);
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      if (integrity.length !== 1 || integrity[0] !== 'ok' || foreignKeys.length !== 0) {
        throw new Error('提交前 integrity/FK 硬断言失败');
      }
      if (hooks.failBeforeCommit) throw new Error('B7B_TEST_FAIL_BEFORE_COMMIT');
    });
    execute.exclusive();
  } finally {
    db.close();
  }
  if (firstRun === null || secondRun === null || marker === null) {
    throw new Error('B7-B 原子事务未生成结果');
  }
  const verification = verifyRealUpgradeDatabase(databasePath, manifest);
  return { marker, firstRun, secondRun, verification };
}

export function assertRealApplyAuthorization(input: RealApplyAuthorization): void {
  if (input.backupId !== B7B_APPROVED_BACKUP_ID) throw new Error('Backup ID 不在本轮授权范围');
  if (input.confirmBackupId !== input.backupId) throw new Error('confirm Backup ID 不一致');
  if (input.expectedSourceFingerprint !== B7B_EXPECTED_SOURCE_FINGERPRINT) {
    throw new Error('expected source fingerprint 与授权不一致');
  }
  if (input.expectedBackupHash !== B7B_EXPECTED_BACKUP_HASH) {
    throw new Error('expected backup hash 与授权不一致');
  }
  if (input.approvalToken !== B7B_APPROVAL_TOKEN) throw new Error('approval token 不一致');
}

export function getB7BStatePaths(backupDirectory: string): {
  directory: string;
  failure: string;
  result: string;
  smoke: string;
} {
  const directory = path.join(backupDirectory, 'b7b-state');
  return {
    directory,
    failure: path.join(directory, `${B7B_APPROVED_BACKUP_ID}-failure.json`),
    result: path.join(directory, `${B7B_APPROVED_BACKUP_ID}-apply-result.json`),
    smoke: path.join(directory, `${B7B_APPROVED_BACKUP_ID}-read-only-smoke.json`),
  };
}

export function writeB7BPrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function writeFailure(
  filePath: string,
  stage: string,
  authorization: RealApplyAuthorization,
  gitCommit: string,
): void {
  writeB7BPrivateJson(filePath, {
    version: 1,
    resolved: false,
    stage,
    approvedBackupId: authorization.backupId,
    applyGitCommit: gitCommit,
    failedAt: new Date().toISOString(),
  });
}

export async function runApprovedRealApply(
  authorization: RealApplyAuthorization,
): Promise<ApprovedRealApplyResult> {
  assertRealApplyAuthorization(authorization);
  const paths = resolveUpgradePaths(authorization);
  const defaultDatabasePath = path.resolve(getDbPath());
  if (path.resolve(paths.sourceDatabasePath) !== defaultDatabasePath) {
    throw new Error('apply-real 只允许仓库默认真实数据库路径');
  }
  assertNoSymbolicLinks(paths.sourceDatabasePath);
  const gitState = readGitState(paths.workspaceDirectory);
  assertRealApplyGitState(gitState);
  const state = getB7BStatePaths(paths.backupDirectory);
  if (fs.existsSync(state.failure)) throw new Error('存在未解决的 B7-B 失败报告');

  const approved = await verifyUpgradeBackup(authorization);
  if (approved.databaseHash.slice(0, 12) !== authorization.expectedBackupHash) {
    throw new Error('批准备份短哈希不一致');
  }
  const approvedDirectory = resolveBackupRunDirectory(paths.backupDirectory, authorization.backupId);
  const approvedDatabasePath = path.join(approvedDirectory, approved.manifest.database.fileName);
  assertDistinctDatabasePaths(paths.sourceDatabasePath, approvedDatabasePath);
  const schemaProbe = new Database(paths.sourceDatabasePath, { readonly: true, fileMustExist: true });
  let existingSchemaVersion: number;
  try {
    existingSchemaVersion = getDatabaseSchemaVersion(schemaProbe);
  } finally {
    schemaProbe.close();
  }
  if (existingSchemaVersion === 2) {
    if (!fs.existsSync(state.result)) {
      throw new Error('真实库已有 v2 schema，但缺少本轮正式 apply result');
    }
    const stored = JSON.parse(fs.readFileSync(state.result, 'utf8')) as ApprovedRealApplyResult;
    if (stored.approvedBackupId !== authorization.backupId || stored.applyGitCommit !== gitState.head) {
      throw new Error('已有 apply result 与本轮授权或 Git Commit 不一致');
    }
    verifyRealUpgradeDatabase(paths.sourceDatabasePath, approved.manifest);
    return stored;
  }
  const source = inspectSourceDatabase(authorization);
  if (
    !source.upgradeEligible
    || source.schemaVersion !== 1
    || source.sourceFile.sha256.slice(0, 12) !== authorization.expectedSourceFingerprint
    || source.sourceFile.sha256 !== approved.manifest.sourceDatabase.sha256
    || source.tableCounts.jobs !== 13
    || source.tableCounts.profiles !== 1
    || source.tableCounts.import_logs !== 1
    || source.v2TablesPresent.length !== 0
  ) throw new Error('真实源库与 B7-A 授权状态不一致');

  const checkpoint = await createUpgradeBackup(authorization);
  const staging = await prepareSnapshotV2StagingFromApprovedBackup(authorization);
  let transactionCommitted = false;
  try {
    let atomic: AtomicApplyResult;
    try {
      atomic = applySchemaAndBackfillAtomically(
        paths.sourceDatabasePath,
        approved.manifest,
        authorization,
        gitState.head,
      );
      transactionCommitted = true;
    } catch (error) {
      writeFailure(state.failure, 'database-transaction', authorization, gitState.head);
      throw error;
    }
    let snapshot: OfficialSnapshotVerification;
    try {
      snapshot = publishAndVerifyOfficialSnapshotV2(
        paths.sourceDatabasePath,
        paths.workspaceDirectory,
        staging.report,
      );
    } catch (error) {
      writeFailure(state.failure, 'snapshot-publish', authorization, gitState.head);
      throw error;
    }
    const approvedAfter = await verifyUpgradeBackup(authorization);
    if (approvedAfter.databaseHash !== approved.databaseHash) {
      writeFailure(state.failure, 'approved-backup-recheck', authorization, gitState.head);
      throw new Error('正式升级后批准备份发生变化');
    }
    const result: ApprovedRealApplyResult = {
      resultCode: 'B7B_APPLY_SUCCESS',
      applyGitCommit: gitState.head,
      approvedBackupId: authorization.backupId,
      preApplyCheckpointId: checkpoint.backupId,
      verification: atomic.verification,
      snapshot,
      approvedBackupUnchanged: true,
    };
    writeB7BPrivateJson(state.result, result);
    return result;
  } catch (error) {
    if (!transactionCommitted) {
      const rollback = inspectSourceDatabase(authorization);
      if (
        rollback.schemaVersion !== 1
        || rollback.v2TablesPresent.length !== 0
        || rollback.sourceFile.sha256.slice(0, 12) !== authorization.expectedSourceFingerprint
      ) throw new Error('B7-B 事务失败后真实库未恢复到授权前状态');
    }
    throw error;
  } finally {
    staging.cleanup();
  }
}

export function readApplyResult(backupDirectory: string): ApprovedRealApplyResult {
  const resultPath = getB7BStatePaths(path.resolve(backupDirectory)).result;
  if (!fs.existsSync(resultPath)) throw new Error('B7-B apply result 不存在');
  return JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ApprovedRealApplyResult;
}
