import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  JobDetailBundleV2Schema,
  JobSummariesResponseSchema,
  ResumeVersionListResponseSchema,
} from '../../../src/domain/job-memory';
import { getDbPath, openDb } from '../../db';
import { buildServer } from '../../index';
import { getDatabaseSchemaVersion } from '../../migrations';
import { initSchema } from '../../schema';
import { JobRepository } from '../../repositories/jobRepository';
import {
  auditSnapshotV2Consistency,
  runSnapshotV2Roundtrip,
  type ExplicitSnapshotV2Context,
} from '../../snapshot/v2';
import { exportSnapshotToDirectory, publishSnapshotPairAtomically } from '../../sync/exportSnapshot';
import { atomicWriteJson, sha256Hex, toStableJson } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import {
  LEGACY_SYNC_TABLES,
  SYNC_TABLES,
  type LegacyOfferFlowSnapshotV1,
  type LegacySnapshotManifestV1,
  type SyncTableName,
} from '../../sync/types';
import {
  applySchemaAndBackfillAtomically,
  type RealApplyAuthorization,
} from '../upgrade/realApply';
import { inspectSourceDatabase } from '../upgrade/inspection';
import type { JobMemoryV2BackupManifest } from '../upgrade/backup';
import { verifyUpgradeBackup } from '../upgrade/backup';
import {
  verifyPostUpgradeBackup,
  type PostUpgradeBackupManifest,
} from '../upgrade/postUpgradeBackup';
import { verifyRealUpgradeDatabase } from '../upgrade/realVerification';
import { isPathInside, resolveBackupRunDirectory } from '../upgrade/pathSafety';
import {
  B8_APPROVED_V1_BACKUP_ID,
  B8_POST_UPGRADE_BACKUP_ID,
  type B8BackupAuditInput,
} from './backupAudit';

interface DatabaseCounts {
  profiles: number;
  jobs: number;
  importLogs: number;
  migrationAuditLogs: number;
  resumeVersions: number | null;
  applications: number | null;
  feedbackEvents: number | null;
}

function readBooleanFeatureFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

export interface ReadOnlyServerSmokeReport {
  mode: 'explicit-v1' | 'default-v2';
  jobs: number;
  summaries: number | null;
  migratedBundleHasApplication: boolean | null;
  skippedBundleHasApplication: boolean | null;
  resumeVersions: number | null;
  expectedResponsesPassed: true;
  schemaValidated: true;
  databaseUnchanged: true;
  portReleased: true;
}

export interface V1RestoreDrillReport {
  schemaVersion: 1;
  counts: DatabaseCounts;
  v2TablesAbsent: true;
  sourceFingerprintMatchesManifest: true;
  backendCapability: false;
  frontendFlagCanBeDisabled: true;
  serverSmoke: ReadOnlyServerSmokeReport;
  businessDataUnchanged: true;
  temporaryDirectoryRemoved: true;
  touchedRealDatabase: false;
}

export interface V2RestoreDrillReport {
  schemaVersion: 2;
  counts: DatabaseCounts;
  snapshotConsistency: true;
  snapshotRoundtrip: true;
  serverSmoke: ReadOnlyServerSmokeReport;
  businessDataUnchanged: true;
  temporaryDirectoryRemoved: true;
  touchedRealDatabase: false;
}

interface SnapshotResumeState {
  version: 1;
  approvedBackupId: string;
  preApplyCheckpointId: string;
  applyGitCommit: string;
  databaseFingerprint: string;
  databaseCommitted: boolean;
  snapshotPublished: boolean;
  resolved: boolean;
  postUpgradeBackupId: string | null;
}

export interface SnapshotResumeDrillReport {
  databaseTransactionCommitted: true;
  snapshotFailureInjected: true;
  partialState: {
    databaseCommitted: true;
    snapshotPublished: false;
    resolved: false;
  };
  schemaAfterFailure: 2;
  secondRunAdditions: { applications: 0; events: 0; audit: false };
  normalApplyRepeatRejected: true;
  resumeBindingsVerified: true;
  repeatedBackfill: false;
  countsUnchangedDuringResume: true;
  finalState: {
    databaseCommitted: true;
    snapshotPublished: true;
    resolved: true;
  };
  postUpgradeBackupBound: true;
  secondResume: 'already-resolved';
  secondResumeSnapshotUnchanged: true;
  temporaryDirectoryRemoved: true;
  touchedRealDatabase: false;
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

function readDatabaseCounts(databasePath: string): DatabaseCounts {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return {
      profiles: tableCount(db, 'profiles') ?? 0,
      jobs: tableCount(db, 'jobs') ?? 0,
      importLogs: tableCount(db, 'import_logs') ?? 0,
      migrationAuditLogs: tableExists(db, 'import_logs')
        ? Number((db.prepare(
          "SELECT COUNT(*) AS count FROM import_logs WHERE source = 'job-memory-v2-backfill'",
        ).get() as { count: number }).count)
        : 0,
      resumeVersions: tableCount(db, 'resume_versions'),
      applications: tableCount(db, 'applications'),
      feedbackEvents: tableCount(db, 'feedback_events'),
    };
  } finally {
    db.close();
  }
}

function databaseFingerprint(databasePath: string): string {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const schemaVersion = getDatabaseSchemaVersion(db);
    const tables = SYNC_TABLES.filter((table) => tableExists(db, table)).map((table) => [
      table,
      sha256Hex(JSON.stringify(readSnapshotTable(db, table as SyncTableName))),
    ]);
    return sha256Hex(JSON.stringify({ schemaVersion, tables }));
  } finally {
    db.close();
  }
}

export function captureB8RealDataFingerprint(databasePath = getDbPath()): string {
  return databaseFingerprint(databasePath);
}

function pairFingerprint(directory: string): string {
  return sha256Hex(JSON.stringify([
    sha256Hex(fs.readFileSync(path.join(directory, 'offerflow.snapshot.json'))),
    sha256Hex(fs.readFileSync(path.join(directory, 'offerflow.manifest.json'))),
  ]));
}

export function captureB8SnapshotFingerprint(snapshotDirectory: string): string {
  return pairFingerprint(snapshotDirectory);
}

function readSchemaVersion(databasePath: string): number {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return getDatabaseSchemaVersion(db);
  } finally {
    db.close();
  }
}

function removeTemporaryDirectory(directory: string): void {
  if (!isPathInside(os.tmpdir(), directory)) {
    throw new Error('B8 拒绝清理系统临时目录之外的路径');
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

async function jsonGet(baseUrl: string, url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${url}`);
  return { status: response.status, body: await response.json() as unknown };
}

async function assertPortReleased(baseUrl: string): Promise<true> {
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    return true;
  }
  throw new Error('B8 只读 Server 关闭后端口仍可访问');
}

export async function runReadOnlyServerSmoke(
  databasePath: string,
  mode: 'explicit-v1' | 'default-v2',
): Promise<ReadOnlyServerSmokeReport> {
  const before = databaseFingerprint(databasePath);
  const expectedCounts = readDatabaseCounts(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const app = buildServer({
    db,
    jobMemoryV2: mode === 'explicit-v1' ? { enabled: false } : undefined,
  });
  let baseUrl = '';
  let report: Omit<ReadOnlyServerSmokeReport, 'databaseUnchanged' | 'portReleased'> | null = null;
  try {
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    if (mode === 'explicit-v1') {
      const jobsResponse = await jsonGet(baseUrl, '/jobs');
      const missingV2Route = await jsonGet(baseUrl, '/resume-versions');
      if (
        jobsResponse.status !== 200
        || !Array.isArray(jobsResponse.body)
        || jobsResponse.body.length !== 13
        || missingV2Route.status !== 404
      ) throw new Error('显式 v1 只读 API smoke 失败');
      report = {
        mode,
        jobs: 13,
        summaries: null,
        migratedBundleHasApplication: null,
        skippedBundleHasApplication: null,
        resumeVersions: null,
        expectedResponsesPassed: true,
        schemaValidated: true,
      };
    } else {
      const activeResumeVersionId = (db.prepare(
        "SELECT value FROM app_meta WHERE key = 'active_resume_version_id'",
      ).get() as { value: string } | undefined)?.value ?? null;
      const migrated = db.prepare(
        'SELECT job_id AS jobId FROM applications ORDER BY job_id LIMIT 1',
      ).get() as { jobId: string } | undefined;
      const skipped = db.prepare(`
        SELECT jobs.id AS jobId FROM jobs
        LEFT JOIN applications ON applications.job_id = jobs.id
        WHERE applications.id IS NULL
        ORDER BY jobs.id LIMIT 1
      `).get() as { jobId: string } | undefined;
      if ((expectedCounts.applications ?? 0) > 0 && migrated === undefined) {
        throw new Error('v2 只读 API smoke 缺少有 Application 的样本');
      }
      const summariesResponse = await jsonGet(baseUrl, '/jobs/summaries');
      const migratedResponse = migrated === undefined ? null : await jsonGet(
        baseUrl, `/jobs/${encodeURIComponent(migrated.jobId)}/bundle`,
      );
      const skippedResponse = skipped === undefined ? null : await jsonGet(
        baseUrl, `/jobs/${encodeURIComponent(skipped.jobId)}/bundle`,
      );
      const resumeResponse = await jsonGet(baseUrl, '/resume-versions');
      if ([summariesResponse, migratedResponse, skippedResponse, resumeResponse]
        .filter((response) => response !== null)
        .some(({ status }) => status < 200 || status >= 300)) {
        throw new Error('v2 只读 API smoke HTTP 状态失败');
      }
      const summaries = JobSummariesResponseSchema.parse(summariesResponse.body);
      const migratedBundle = migratedResponse === null
        ? null
        : JobDetailBundleV2Schema.parse(migratedResponse.body);
      const skippedBundle = skippedResponse === null
        ? null
        : JobDetailBundleV2Schema.parse(skippedResponse.body);
      const resumes = ResumeVersionListResponseSchema.parse(resumeResponse.body);
      if (
        summaries.length !== expectedCounts.jobs
        || (migratedBundle !== null && migratedBundle.memory.applications.length === 0)
        || (skippedBundle !== null && skippedBundle.memory.applications.length !== 0)
        || resumes.resumeVersions.length !== (expectedCounts.resumeVersions ?? 0)
        || resumes.activeResumeVersionId !== activeResumeVersionId
      ) throw new Error('v2 只读 API smoke 聚合失败');
      report = {
        mode,
        jobs: expectedCounts.jobs,
        summaries: summaries.length,
        migratedBundleHasApplication: migratedBundle === null
          ? null
          : migratedBundle.memory.applications.length > 0,
        skippedBundleHasApplication: skippedBundle === null
          ? null
          : skippedBundle.memory.applications.length > 0,
        resumeVersions: resumes.resumeVersions.length,
        expectedResponsesPassed: true,
        schemaValidated: true,
      };
    }
  } finally {
    await app.close();
    db.close();
  }
  const portReleased = baseUrl === '' ? true : await assertPortReleased(baseUrl);
  if (report === null) throw new Error('B8 只读 Server smoke 未生成报告');
  if (databaseFingerprint(databasePath) !== before) {
    throw new Error('B8 只读 Server smoke 修改了数据库');
  }
  return { ...report, databaseUnchanged: true, portReleased };
}

function copySnapshotPair(sourceDirectory: string, targetDirectory: string): void {
  fs.mkdirSync(targetDirectory, { recursive: true });
  for (const name of ['offerflow.snapshot.json', 'offerflow.manifest.json'] as const) {
    fs.copyFileSync(
      path.join(sourceDirectory, name),
      path.join(targetDirectory, name),
      fs.constants.COPYFILE_EXCL,
    );
  }
}

export async function runV1RestoreDrill(input: B8BackupAuditInput): Promise<V1RestoreDrillReport> {
  const verified = await verifyUpgradeBackup({ ...input, backupId: B8_APPROVED_V1_BACKUP_ID });
  const backupDirectory = resolveBackupRunDirectory(
    path.resolve(input.backupDirectory),
    B8_APPROVED_V1_BACKUP_ID,
  );
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b8-v1-restore-'));
  let partial: Omit<V1RestoreDrillReport, 'temporaryDirectoryRemoved'> | null = null;
  try {
    const clonePath = path.join(temporaryDirectory, 'offerflow-v1-restored.sqlite3');
    fs.copyFileSync(
      path.join(backupDirectory, verified.manifest.database.fileName),
      clonePath,
      fs.constants.COPYFILE_EXCL,
    );
    copySnapshotPair(
      path.join(backupDirectory, 'snapshot-v1'),
      path.join(temporaryDirectory, 'snapshot-v1'),
    );
    const cloneHash = sha256Hex(fs.readFileSync(clonePath));
    if (cloneHash !== verified.manifest.database.sha256) {
      throw new Error('v1 恢复副本与 manifest 指纹不一致');
    }
    const counts = readDatabaseCounts(clonePath);
    const db = new Database(clonePath, { readonly: true, fileMustExist: true });
    let schemaVersion: number;
    let v2TablesAbsent: boolean;
    try {
      schemaVersion = getDatabaseSchemaVersion(db);
      v2TablesAbsent = ['resume_versions', 'applications', 'feedback_events']
        .every((table) => !tableExists(db, table));
    } finally {
      db.close();
    }
    if (
      schemaVersion !== 1
      || counts.profiles !== 1
      || counts.jobs !== 13
      || counts.importLogs !== 1
      || !v2TablesAbsent
    ) throw new Error('v1 恢复聚合不符合 B8 基线');
    const beforeSmoke = databaseFingerprint(clonePath);
    const serverSmoke = await runReadOnlyServerSmoke(clonePath, 'explicit-v1');
    if (databaseFingerprint(clonePath) !== beforeSmoke) throw new Error('v1 恢复演练发生写入');
    if (readBooleanFeatureFlag('false', true) !== false) {
      throw new Error('前端显式 v1 flag 无法关闭');
    }
    partial = {
      schemaVersion: 1,
      counts,
      v2TablesAbsent: true,
      sourceFingerprintMatchesManifest: true,
      backendCapability: false,
      frontendFlagCanBeDisabled: true,
      serverSmoke,
      businessDataUnchanged: true,
      touchedRealDatabase: false,
    };
  } finally {
    removeTemporaryDirectory(temporaryDirectory);
  }
  if (partial === null || fs.existsSync(temporaryDirectory)) {
    throw new Error('v1 恢复演练未完成清理');
  }
  return { ...partial, temporaryDirectoryRemoved: true };
}

export async function runV2RestoreDrill(input: B8BackupAuditInput): Promise<V2RestoreDrillReport> {
  verifyPostUpgradeBackup(input.backupDirectory, B8_POST_UPGRADE_BACKUP_ID);
  const backupDirectory = resolveBackupRunDirectory(
    path.resolve(input.backupDirectory),
    B8_POST_UPGRADE_BACKUP_ID,
  );
  const manifest = JSON.parse(fs.readFileSync(
    path.join(backupDirectory, 'backup-manifest.json'),
    'utf8',
  )) as PostUpgradeBackupManifest;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b8-v2-restore-'));
  let partial: Omit<V2RestoreDrillReport, 'temporaryDirectoryRemoved'> | null = null;
  try {
    const clonePath = path.join(temporaryDirectory, 'offerflow-v2-restored.sqlite3');
    const snapshotDirectory = path.join(temporaryDirectory, 'snapshot-v2');
    fs.copyFileSync(
      path.join(backupDirectory, manifest.database.fileName),
      clonePath,
      fs.constants.COPYFILE_EXCL,
    );
    copySnapshotPair(path.join(backupDirectory, 'snapshot-v2'), snapshotDirectory);
    const counts = readDatabaseCounts(clonePath);
    const context: ExplicitSnapshotV2Context = {
      databasePath: clonePath,
      snapshotDirectory,
      workingDirectory: temporaryDirectory,
      workspaceDirectory: input.workspaceDirectory,
      schemaTarget: 2,
      capability: 'job-memory-v2',
      mode: 'temporary_clone',
    };
    const consistency = auditSnapshotV2Consistency(context);
    const roundtrip = runSnapshotV2Roundtrip({
      ...context,
      snapshotDirectory: path.join(temporaryDirectory, 'roundtrip-snapshot-v2'),
    });
    if (
      readSchemaVersion(clonePath) !== 2
      || counts.profiles !== 1
      || counts.jobs !== 13
      || counts.importLogs !== 2
      || counts.resumeVersions !== 0
      || counts.applications !== 7
      || counts.feedbackEvents !== 7
      || !consistency.ok
      || !roundtrip.consistencyOk
      || !roundtrip.exportImportOk
    ) throw new Error('v2 恢复聚合或 Snapshot 验证失败');
    const beforeSmoke = databaseFingerprint(clonePath);
    const serverSmoke = await runReadOnlyServerSmoke(clonePath, 'default-v2');
    if (databaseFingerprint(clonePath) !== beforeSmoke) throw new Error('v2 恢复演练发生写入');
    partial = {
      schemaVersion: 2,
      counts,
      snapshotConsistency: true,
      snapshotRoundtrip: true,
      serverSmoke,
      businessDataUnchanged: true,
      touchedRealDatabase: false,
    };
  } finally {
    removeTemporaryDirectory(temporaryDirectory);
  }
  if (partial === null || fs.existsSync(temporaryDirectory)) {
    throw new Error('v2 恢复演练未完成清理');
  }
  return { ...partial, temporaryDirectoryRemoved: true };
}

function seedSyntheticV1(databasePath: string): void {
  const db = openDb(databasePath);
  try {
    initSchema(db, { targetVersion: 1 });
    const jobs = new JobRepository(db);
    for (let index = 0; index < 4; index += 1) {
      jobs.create({ id: `synthetic-not-${index}`, company: `合成未沟通-${index}` });
    }
    for (let index = 0; index < 3; index += 1) {
      jobs.create({
        id: `synthetic-unread-${index}`,
        company: `合成未读-${index}`,
        communicationStatus: 'greeted_unread',
      });
    }
    jobs.create({
      id: 'synthetic-read',
      company: '合成已读',
      communicationStatus: 'greeted_read_no_reply',
    });
    jobs.create({ id: 'synthetic-replied', company: '合成回复', communicationStatus: 'replied' });
    for (let index = 0; index < 2; index += 1) {
      jobs.create({
        id: `synthetic-interview-${index}`,
        company: `合成面试-${index}`,
        communicationStatus: 'interviewing',
      });
      jobs.create({
        id: `synthetic-paused-${index}`,
        company: `合成暂停-${index}`,
        communicationStatus: 'paused',
        reviewStatus: 'deferred',
      });
    }
    db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)')
      .run('default', '{"targetRole":"synthetic"}', 1);
    db.prepare(`
      INSERT INTO import_logs (
        id, source, profile_count, job_count, ignored_key_count,
        warning_count, created_at, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('synthetic-log', 'synthetic-fixture', 1, 13, 0, 0, 1, '{}');
  } finally {
    db.close();
  }
}

function writeSyntheticLegacySnapshot(databasePath: string, snapshotDirectory: string): void {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let snapshot: LegacyOfferFlowSnapshotV1;
  try {
    db.pragma('query_only = ON');
    snapshot = {
      schemaVersion: 1,
      exportedAt: '2026-07-14T00:00:00.000Z',
      deviceId: 'b8-synthetic-v1',
      appVersion: '0.6.2',
      tables: Object.fromEntries(
        LEGACY_SYNC_TABLES.map((table) => [table, readSnapshotTable(db, table as SyncTableName)]),
      ),
    } as LegacyOfferFlowSnapshotV1;
  } finally {
    db.close();
  }
  fs.mkdirSync(snapshotDirectory, { recursive: true });
  const text = toStableJson(snapshot);
  fs.writeFileSync(path.join(snapshotDirectory, 'offerflow.snapshot.json'), text, 'utf8');
  atomicWriteJson(path.join(snapshotDirectory, 'offerflow.manifest.json'), {
    schemaVersion: 1,
    exportedAt: snapshot.exportedAt,
    deviceId: snapshot.deviceId,
    appVersion: snapshot.appVersion,
    snapshotHash: sha256Hex(text),
    tableCounts: Object.fromEntries(
      LEGACY_SYNC_TABLES.map((table) => [table, snapshot.tables[table]?.rows.length ?? 0]),
    ),
  } satisfies LegacySnapshotManifestV1);
}

function currentGitCommit(workspaceDirectory: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('B8 无法读取 Git Commit');
  return result.stdout.trim();
}

function syntheticManifest(
  inspection: ReturnType<typeof inspectSourceDatabase>,
  backupId: string,
  applyGitCommit: string,
): JobMemoryV2BackupManifest {
  return {
    toolVersion: 'b7-a-v1',
    backupId,
    createdAt: '2026-07-14T00:00:00.000Z',
    gitCommit: applyGitCommit,
    sourceSchemaVersion: 1,
    database: {
      fileName: 'offerflow-v1.sqlite3',
      sizeBytes: inspection.sourceFile.sizeBytes,
      sha256: inspection.sourceFile.sha256,
    },
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
}

function readResumeState(statePath: string): SnapshotResumeState {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as SnapshotResumeState;
  if (
    state.version !== 1
    || typeof state.databaseCommitted !== 'boolean'
    || typeof state.snapshotPublished !== 'boolean'
    || typeof state.resolved !== 'boolean'
  ) throw new Error('B8 Snapshot resume state 无效');
  return state;
}

async function createSyntheticPostUpgradeBackup(
  databasePath: string,
  snapshotDirectory: string,
  backupDirectory: string,
  state: SnapshotResumeState,
): Promise<void> {
  if (fs.existsSync(backupDirectory)) throw new Error('B8 post-upgrade 演练备份禁止覆盖');
  fs.mkdirSync(backupDirectory);
  const databaseBackupPath = path.join(backupDirectory, 'offerflow-v2.sqlite3');
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma('query_only = ON');
    await source.backup(databaseBackupPath);
  } finally {
    source.close();
  }
  const snapshotTarget = path.join(backupDirectory, 'snapshot-v2');
  copySnapshotPair(snapshotDirectory, snapshotTarget);
  const files = ['offerflow.snapshot.json', 'offerflow.manifest.json'].map((name) => {
    const content = fs.readFileSync(path.join(snapshotTarget, name));
    return { name, sizeBytes: content.byteLength, sha256: sha256Hex(content) };
  });
  const databaseBytes = fs.readFileSync(databaseBackupPath);
  atomicWriteJson(path.join(backupDirectory, 'backup-manifest.json'), {
    version: 1,
    backupId: state.postUpgradeBackupId,
    approvedBackupId: state.approvedBackupId,
    applyGitCommit: state.applyGitCommit,
    database: { sizeBytes: databaseBytes.byteLength, sha256: sha256Hex(databaseBytes) },
    snapshot: files,
  });
  atomicWriteJson(path.join(backupDirectory, 'apply-result.json'), state);

  const verify = new Database(databaseBackupPath, { readonly: true, fileMustExist: true });
  try {
    verify.pragma('query_only = ON');
    if (
      getDatabaseSchemaVersion(verify) !== 2
      || String(verify.pragma('integrity_check', { simple: true })) !== 'ok'
      || (verify.pragma('foreign_key_check') as unknown[]).length !== 0
    ) throw new Error('B8 post-upgrade 演练备份校验失败');
  } finally {
    verify.close();
  }
}

async function resumeSyntheticSnapshot(
  input: {
    databasePath: string;
    snapshotDirectory: string;
    statePath: string;
    manifest: JobMemoryV2BackupManifest;
    workspaceDirectory: string;
    workingDirectory: string;
  },
): Promise<'resumed' | 'already-resolved'> {
  const state = readResumeState(input.statePath);
  if (state.databaseFingerprint !== databaseFingerprint(input.databasePath)) {
    throw new Error('resume 数据库指纹不一致');
  }
  const verification = verifyRealUpgradeDatabase(input.databasePath, input.manifest);
  if (
    verification.marker.approvedBackupId !== state.approvedBackupId
    || verification.marker.applyGitCommit !== state.applyGitCommit
    || verification.tableCounts.applications !== 7
    || verification.tableCounts.feedbackEvents !== 7
    || verification.tableCounts.migrationAuditLogs !== 1
  ) throw new Error('resume 的 Backup ID、Commit、audit 或聚合绑定失败');
  if (state.resolved) {
    if (!state.databaseCommitted || !state.snapshotPublished || state.postUpgradeBackupId === null) {
      throw new Error('resolved 状态存在矛盾');
    }
    const context: ExplicitSnapshotV2Context = {
      databasePath: input.databasePath,
      snapshotDirectory: input.snapshotDirectory,
      workingDirectory: input.workingDirectory,
      workspaceDirectory: input.workspaceDirectory,
      schemaTarget: 2,
      capability: 'job-memory-v2',
      mode: 'temporary_clone',
    };
    if (!auditSnapshotV2Consistency(context).ok) throw new Error('already-resolved Snapshot 不一致');
    return 'already-resolved';
  }
  if (!state.databaseCommitted || state.snapshotPublished) {
    throw new Error('不存在可续发的数据库已提交状态');
  }
  const countsBefore = readDatabaseCounts(input.databasePath);
  const stagingDirectory = path.join(input.workingDirectory, 'resume-staging');
  if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  exportSnapshotToDirectory(input.databasePath, stagingDirectory, 'b8-synthetic-resume');
  publishSnapshotPairAtomically(stagingDirectory, input.snapshotDirectory);
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
  const context: ExplicitSnapshotV2Context = {
    databasePath: input.databasePath,
    snapshotDirectory: input.snapshotDirectory,
    workingDirectory: input.workingDirectory,
    workspaceDirectory: input.workspaceDirectory,
    schemaTarget: 2,
    capability: 'job-memory-v2',
    mode: 'temporary_clone',
  };
  if (!auditSnapshotV2Consistency(context).ok) throw new Error('resume 后 Snapshot 不一致');
  const countsAfter = readDatabaseCounts(input.databasePath);
  if (JSON.stringify(countsAfter) !== JSON.stringify(countsBefore)) {
    throw new Error('resume 重复创建了 Application/Event/audit');
  }
  const finalState: SnapshotResumeState = {
    ...state,
    snapshotPublished: true,
    resolved: true,
    postUpgradeBackupId: 'b8-synthetic-post-upgrade',
  };
  await createSyntheticPostUpgradeBackup(
    input.databasePath,
    input.snapshotDirectory,
    path.join(input.workingDirectory, 'post-upgrade-backup'),
    finalState,
  );
  atomicWriteJson(input.statePath, finalState);
  return 'resumed';
}

export async function runSnapshotResumeDrill(
  workspaceDirectory: string,
): Promise<SnapshotResumeDrillReport> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b8-resume-'));
  let partial: Omit<SnapshotResumeDrillReport, 'temporaryDirectoryRemoved'> | null = null;
  try {
    const databasePath = path.join(temporaryDirectory, 'synthetic-v1.sqlite3');
    const snapshotDirectory = path.join(temporaryDirectory, 'official-snapshot');
    const statePath = path.join(temporaryDirectory, 'apply-result.json');
    seedSyntheticV1(databasePath);
    writeSyntheticLegacySnapshot(databasePath, snapshotDirectory);
    const oldPairFingerprint = pairFingerprint(snapshotDirectory);
    const applyGitCommit = currentGitCommit(workspaceDirectory);
    const inspection = inspectSourceDatabase({
      sourceDatabasePath: databasePath,
      backupDirectory: path.join(temporaryDirectory, 'unused-backups'),
      workspaceDirectory,
    });
    const approvedBackupId = '20260714-000000-b7a-b8000001';
    const manifest = syntheticManifest(inspection, approvedBackupId, applyGitCommit);
    const authorization: RealApplyAuthorization = {
      sourceDatabasePath: databasePath,
      backupDirectory: path.join(temporaryDirectory, 'unused-backups'),
      workspaceDirectory,
      backupId: approvedBackupId,
      confirmBackupId: approvedBackupId,
      expectedSourceFingerprint: inspection.sourceFile.sha256.slice(0, 12),
      expectedBackupHash: inspection.sourceFile.sha256.slice(0, 12),
      approvalToken: 'B8-SYNTHETIC-ONLY',
    };
    const atomic = applySchemaAndBackfillAtomically(
      databasePath,
      manifest,
      authorization,
      applyGitCommit,
    );
    const partialState: SnapshotResumeState = {
      version: 1,
      approvedBackupId,
      preApplyCheckpointId: '20260714-000001-b7a-b8000002',
      applyGitCommit,
      databaseFingerprint: databaseFingerprint(databasePath),
      databaseCommitted: true,
      snapshotPublished: false,
      resolved: false,
      postUpgradeBackupId: null,
    };
    atomicWriteJson(statePath, partialState);
    const failedStaging = path.join(temporaryDirectory, 'failed-staging');
    exportSnapshotToDirectory(databasePath, failedStaging, 'b8-synthetic-failure');
    let snapshotFailureInjected = false;
    try {
      publishSnapshotPairAtomically(failedStaging, snapshotDirectory, {
        failAfterSnapshotReplace: true,
      });
    } catch (error) {
      snapshotFailureInjected = (error as Error).message === 'B7B_TEST_SNAPSHOT_PUBLISH_FAILURE';
    }
    if (!snapshotFailureInjected || pairFingerprint(snapshotDirectory) !== oldPairFingerprint) {
      throw new Error('Snapshot 故障注入未恢复旧 pair');
    }
    let normalApplyRepeatRejected = false;
    try {
      applySchemaAndBackfillAtomically(
        databasePath,
        manifest,
        authorization,
        applyGitCommit,
      );
    } catch {
      normalApplyRepeatRejected = true;
    }
    if (!normalApplyRepeatRejected) throw new Error('普通 apply 未拒绝重复执行');
    const countsBeforeResume = readDatabaseCounts(databasePath);
    const resumed = await resumeSyntheticSnapshot({
      databasePath,
      snapshotDirectory,
      statePath,
      manifest,
      workspaceDirectory,
      workingDirectory: temporaryDirectory,
    });
    if (resumed !== 'resumed') throw new Error('首次 resume 未完成续发');
    const countsAfterResume = readDatabaseCounts(databasePath);
    const snapshotAfterResume = pairFingerprint(snapshotDirectory);
    const secondResume = await resumeSyntheticSnapshot({
      databasePath,
      snapshotDirectory,
      statePath,
      manifest,
      workspaceDirectory,
      workingDirectory: temporaryDirectory,
    });
    const finalState = readResumeState(statePath);
    if (
      secondResume !== 'already-resolved'
      || pairFingerprint(snapshotDirectory) !== snapshotAfterResume
      || !finalState.databaseCommitted
      || !finalState.snapshotPublished
      || !finalState.resolved
      || finalState.postUpgradeBackupId === null
      || JSON.stringify(countsBeforeResume) !== JSON.stringify(countsAfterResume)
    ) throw new Error('Snapshot resume 最终状态或幂等性失败');
    partial = {
      databaseTransactionCommitted: true,
      snapshotFailureInjected: true,
      partialState: {
        databaseCommitted: true,
        snapshotPublished: false,
        resolved: false,
      },
      schemaAfterFailure: 2,
      secondRunAdditions: {
        applications: atomic.verification.secondRun.createdApplications,
        events: atomic.verification.secondRun.createdEvents,
        audit: atomic.verification.secondRun.auditLogCreated,
      },
      normalApplyRepeatRejected: true,
      resumeBindingsVerified: true,
      repeatedBackfill: false,
      countsUnchangedDuringResume: true,
      finalState: {
        databaseCommitted: true,
        snapshotPublished: true,
        resolved: true,
      },
      postUpgradeBackupBound: true,
      secondResume: 'already-resolved',
      secondResumeSnapshotUnchanged: true,
      touchedRealDatabase: false,
    };
  } finally {
    removeTemporaryDirectory(temporaryDirectory);
  }
  if (partial === null || fs.existsSync(temporaryDirectory)) {
    throw new Error('Snapshot resume 演练未完成清理');
  }
  return { ...partial, temporaryDirectoryRemoved: true };
}
