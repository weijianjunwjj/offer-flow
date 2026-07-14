import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db';
import { getDatabaseSchemaVersion } from '../../migrations';
import { JobRepository } from '../../repositories/jobRepository';
import { initSchema } from '../../schema';
import { sha256Hex } from '../../sync/hash';
import { createUpgradeBackup, type JobMemoryV2BackupManifest } from './backup';
import { inspectSourceDatabase } from './inspection';
import {
  B7B_APPROVAL_TOKEN,
  B7B_APPROVED_BACKUP_ID,
  B7B_EXPECTED_BACKUP_HASH,
  B7B_EXPECTED_SOURCE_FINGERPRINT,
  B7B_REQUIRED_BRANCH,
  applySchemaAndBackfillAtomically,
  assertRealApplyAuthorization,
  assertRealApplyGitState,
  type RealApplyAuthorization,
} from './realApply';
import { prepareSnapshotV2StagingFromApprovedBackup } from './officialSnapshot';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  tempDir: string;
  workspaceDirectory: string;
  sourceDatabasePath: string;
  backupDirectory: string;
  manifest: JobMemoryV2BackupManifest;
  authorization: RealApplyAuthorization;
}

function seedRealShape(db: Database.Database): void {
  const jobs = new JobRepository(db);
  for (let index = 0; index < 4; index += 1) jobs.create({ id: `not-${index}` });
  for (let index = 0; index < 3; index += 1) {
    jobs.create({ id: `unread-${index}`, communicationStatus: 'greeted_unread' });
  }
  jobs.create({ id: 'read', communicationStatus: 'greeted_read_no_reply' });
  jobs.create({ id: 'replied', communicationStatus: 'replied' });
  for (let index = 0; index < 2; index += 1) {
    jobs.create({ id: `interview-${index}`, communicationStatus: 'interviewing' });
    jobs.create({ id: `paused-${index}`, communicationStatus: 'paused', reviewStatus: 'deferred' });
  }
  db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)')
    .run('default', '{"targetRole":"fixture"}', 1);
  db.prepare(`INSERT INTO import_logs (
    id, source, profile_count, job_count, ignored_key_count, warning_count, created_at, data_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('existing-log', 'fixture', 1, 13, 0, 0, 1, '{}');
}

function fixture(): Fixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b7b-apply-'));
  const workspaceDirectory = path.join(tempDir, 'workspace');
  const sourceDatabasePath = path.join(tempDir, 'data', 'offerflow.sqlite3');
  const backupDirectory = path.join(tempDir, 'backups');
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  fs.writeFileSync(path.join(workspaceDirectory, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['init'], { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: workspaceDirectory, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: workspaceDirectory, windowsHide: true });
  execFileSync('git', ['add', 'README.md'], { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true });
  const db = openDb(sourceDatabasePath);
  initSchema(db, { targetVersion: 1 });
  seedRealShape(db);
  db.close();
  const inspection = inspectSourceDatabase({
    sourceDatabasePath, backupDirectory, workspaceDirectory,
  });
  const manifest: JobMemoryV2BackupManifest = {
    toolVersion: 'b7-a-v1',
    backupId: B7B_APPROVED_BACKUP_ID,
    createdAt: '2026-07-14T00:00:00.000Z',
    gitCommit: 'fixture',
    sourceSchemaVersion: 1,
    database: { fileName: 'offerflow-v1.sqlite3', sizeBytes: 1, sha256: 'fixture' },
    sourceDatabase: {
      sizeBytes: inspection.sourceFile.sizeBytes,
      sha256: inspection.sourceFile.sha256,
      businessTableHashes: inspection.businessTableHashes,
    },
    tableCounts: inspection.tableCounts,
    migrations: inspection.migrationRecords,
    integrity: ['ok'],
    foreignKeyViolationCount: 0,
    journalMode: inspection.journalMode,
    sourceSidecars: { walPresent: false, shmPresent: false },
    snapshotV1: { present: false, schemaVersion: null, consistencyOk: null, files: [] },
  };
  const authorization: RealApplyAuthorization = {
    sourceDatabasePath,
    backupDirectory,
    workspaceDirectory,
    backupId: B7B_APPROVED_BACKUP_ID,
    confirmBackupId: B7B_APPROVED_BACKUP_ID,
    expectedSourceFingerprint: inspection.sourceFile.sha256.slice(0, 12),
    expectedBackupHash: B7B_EXPECTED_BACKUP_HASH,
    approvalToken: B7B_APPROVAL_TOKEN,
  };
  cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return { tempDir, workspaceDirectory, sourceDatabasePath, backupDirectory, manifest, authorization };
}

function assertRolledBack(target: Fixture, hashBefore: string): void {
  const db = new Database(target.sourceDatabasePath, { readonly: true, fileMustExist: true });
  try {
    expect(getDatabaseSchemaVersion(db)).toBe(1);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('applications','feedback_events','resume_versions')",
    ).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 13 });
  } finally {
    db.close();
  }
  expect(sha256Hex(fs.readFileSync(target.sourceDatabasePath))).toBe(hashBefore);
}

describe('B7-B 正式授权绑定', () => {
  const valid = (): RealApplyAuthorization => ({
    sourceDatabasePath: 'data/offerflow.sqlite3',
    backupDirectory: 'backups/job-memory-v2',
    workspaceDirectory: '.',
    backupId: B7B_APPROVED_BACKUP_ID,
    confirmBackupId: B7B_APPROVED_BACKUP_ID,
    expectedSourceFingerprint: B7B_EXPECTED_SOURCE_FINGERPRINT,
    expectedBackupHash: B7B_EXPECTED_BACKUP_HASH,
    approvalToken: B7B_APPROVAL_TOKEN,
  });

  it('只接受批准 Backup ID、双确认、指纹、备份哈希和 token', () => {
    expect(() => assertRealApplyAuthorization(valid())).not.toThrow();
    expect(() => assertRealApplyAuthorization({ ...valid(), backupId: '20260714-000000-b7a-deadbeef' }))
      .toThrow('授权范围');
    expect(() => assertRealApplyAuthorization({ ...valid(), confirmBackupId: 'mismatch' }))
      .toThrow('confirm');
    expect(() => assertRealApplyAuthorization({ ...valid(), expectedSourceFingerprint: 'bad' }))
      .toThrow('fingerprint');
    expect(() => assertRealApplyAuthorization({ ...valid(), expectedBackupHash: 'bad' }))
      .toThrow('backup hash');
    expect(() => assertRealApplyAuthorization({ ...valid(), approvalToken: 'bad' }))
      .toThrow('token');
  });

  it('拒绝错误分支和 dirty working tree', () => {
    expect(() => assertRealApplyGitState({ branch: B7B_REQUIRED_BRANCH, head: 'head', clean: true }))
      .not.toThrow();
    expect(() => assertRealApplyGitState({ branch: 'main', head: 'head', clean: true }))
      .toThrow('分支');
    expect(() => assertRealApplyGitState({ branch: B7B_REQUIRED_BRANCH, head: 'head', clean: false }))
      .toThrow('干净');
  });
});

describe('B7-B schema + backfill 单一独占事务', () => {
  it('批准 SQLite 备份可预生成 7/7 Snapshot v2 staging 并清理', async () => {
    const target = fixture();
    await createUpgradeBackup({
      sourceDatabasePath: target.sourceDatabasePath,
      backupDirectory: target.backupDirectory,
      workspaceDirectory: target.workspaceDirectory,
      backupId: B7B_APPROVED_BACKUP_ID,
    });
    const staging = await prepareSnapshotV2StagingFromApprovedBackup(target.authorization);
    const workingDirectory = staging.workingDirectory;
    expect(staging.report).toMatchObject({
      exportImportOk: true,
      consistencyOk: true,
      tableCounts: { jobs: 13, profiles: 1, applications: 7, feedback_events: 7, resume_versions: 0 },
      activeResumePointerPreserved: true,
      projectionPersisted: false,
      eventPayloadPreserved: true,
    });
    staging.cleanup();
    expect(fs.existsSync(workingDirectory)).toBe(false);
  });

  it('一次提交 7/7、跳过 6、二次新增 0，并保留全部 legacy 数据', () => {
    const target = fixture();
    const result = applySchemaAndBackfillAtomically(
      target.sourceDatabasePath,
      target.manifest,
      target.authorization,
      'fixture-git-commit',
    );
    expect(result.verification).toMatchObject({
      schemaVersion: 2,
      integrity: ['ok'],
      foreignKeyViolationCount: 0,
      tableCounts: {
        jobs: 13, profiles: 1, originalImportLogs: 1, migrationAuditLogs: 1,
        resumeVersions: 0, applications: 7, feedbackEvents: 7,
      },
      projection: { valid: 0, degraded: 7, invalid: 0 },
      skipCount: 6,
      manualReviewCount: 0,
      secondRun: { createdApplications: 0, createdEvents: 0, auditLogCreated: false },
      jobHashChanges: 0,
      legacyFieldChanges: 0,
      notContactedApplicationCount: 0,
      pausedWithoutInteractionApplicationCount: 0,
      weakLegacySeedCount: 7,
    });
  });

  it.each([
    ['migration 后失败', { failAfterMigration: true }],
    ['提交前失败', { failBeforeCommit: true }],
    ['数量偏差', { expectedApplications: 8 }],
  ] as const)('%s 时完整回滚到 v1', (_name, hooks) => {
    const target = fixture();
    const hashBefore = sha256Hex(fs.readFileSync(target.sourceDatabasePath));
    expect(() => applySchemaAndBackfillAtomically(
      target.sourceDatabasePath,
      target.manifest,
      target.authorization,
      'fixture-git-commit',
      hooks,
    )).toThrow();
    assertRolledBack(target, hashBefore);
  });

  it('无法取得独占锁时拒绝部分 migration', () => {
    const target = fixture();
    const hashBefore = sha256Hex(fs.readFileSync(target.sourceDatabasePath));
    const blocker = new Database(target.sourceDatabasePath, { fileMustExist: true });
    blocker.exec('BEGIN EXCLUSIVE');
    try {
      expect(() => applySchemaAndBackfillAtomically(
        target.sourceDatabasePath,
        target.manifest,
        target.authorization,
        'fixture-git-commit',
        { lockTimeoutMs: 10 },
      )).toThrow(/locked/);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    assertRolledBack(target, hashBefore);
  });
});
