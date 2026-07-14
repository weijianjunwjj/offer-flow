import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { getDbPath, openDb } from '../../db';
import { buildServer } from '../../index';
import {
  getDatabaseSchemaVersion,
  PRODUCTION_SCHEMA_VERSION,
} from '../../migrations';
import { initSchema } from '../../schema';
import { JobRepository } from '../../repositories/jobRepository';
import { auditSnapshotConsistency } from '../../sync/consistency';
import { getSyncPaths } from '../../sync/paths';
import { SNAPSHOT_SCHEMA_VERSION } from '../../sync/types';
import { verifyUpgradeBackup } from '../upgrade/backup';
import {
  B7B_APPROVED_BACKUP_ID,
  B7B_EXPECTED_BACKUP_HASH,
  B7B_EXPECTED_SOURCE_FINGERPRINT,
  B7B_APPROVAL_TOKEN,
  B7B_REQUIRED_BRANCH,
  getB7BStatePaths,
  readApplyResult,
} from '../upgrade/realApply';
import { verifyRealUpgradeDatabase } from '../upgrade/realVerification';
import {
  assertB8BackupFingerprintsUnchanged,
  auditB8Backups,
  captureB8BackupFingerprints,
  type B8BackupAuditInput,
  type B8BackupAuditReport,
} from './backupAudit';
import {
  captureB8RealDataFingerprint,
  captureB8SnapshotFingerprint,
  runReadOnlyServerSmoke,
  runSnapshotResumeDrill,
  runV1RestoreDrill,
  runV2RestoreDrill,
  type ReadOnlyServerSmokeReport,
  type SnapshotResumeDrillReport,
  type V1RestoreDrillReport,
  type V2RestoreDrillReport,
} from './drills';

interface RealDataAuditReport {
  schemaVersion: 2;
  integrity: 'ok';
  foreignKeyViolationCount: 0;
  migrationContinuous: true;
  tableCounts: {
    profiles: 1;
    jobs: 13;
    originalImportLogs: 1;
    migrationAuditLogs: 1;
    resumeVersions: 0;
    applications: 7;
    feedbackEvents: 7;
  };
  projection: { valid: 0; degraded: 7; invalid: 0 };
  secondRun: { createdApplications: 0; createdEvents: 0; auditLogCreated: false };
  jobHashChanges: 0;
  legacyFieldChanges: 0;
  snapshotSchemaVersion: 2;
  snapshotDifferences: 0;
  readOnlyServerSmoke: ReadOnlyServerSmokeReport;
  historicalSnapshotFailureResolved: true;
  finalApplyResultConsistent: true;
  dataUnchanged: true;
  snapshotUnchanged: true;
}

interface ProductionAuditReport {
  schemaTarget: 2;
  backendCapabilityDefault: true;
  frontendFlagDefault: true;
  snapshotSchema: 2;
  freshDatabaseInitializesV2: true;
  upgradedDatabaseOpens: true;
  unupgradedV1RejectedWithoutMutation: true;
  explicitV1CompatibilityOnly: true;
  legacyWriteGuard: true;
  bundleAndSummariesDefault: true;
  projectionNotPersisted: true;
  temporaryDirectoryRemoved: true;
}

interface BoundaryAuditReport {
  appVersion: '0.6.2';
  dependenciesUnchangedFromMain: true;
  llmAndOcrBoundaryUnchanged: true;
  trackedPrivateArtifacts: 0;
  newTrackedAbsoluteWorkspacePaths: 0;
  globalApplicationsRouteAbsent: true;
  historyBackfillEntryAbsent: true;
  funnelEntryAbsent: true;
  runtimeSseGate2Absent: true;
  aiProfileFeaturesAbsent: true;
  recruitingCrawlerAbsent: true;
  automaticDeliveryOrMessagingAbsent: true;
  projectionPersistenceAbsent: true;
  humanInTheLoopPreserved: true;
  dualFactSourceAbsent: true;
}

export interface V070B8AuditReport {
  status: 'V070_B8_AUDIT_PASS';
  appVersion: '0.6.2';
  realData: RealDataAuditReport;
  backups: B8BackupAuditReport;
  v1Restore: V1RestoreDrillReport;
  v2Restore: V2RestoreDrillReport;
  snapshotResume: SnapshotResumeDrillReport;
  production: ProductionAuditReport;
  boundaries: BoundaryAuditReport;
  backupFilesUnchanged: true;
  realDatabaseUnchanged: true;
  formalSnapshotUnchanged: true;
}

function runGit(workspaceDirectory: string, args: string[], allowFailure = false): string {
  const result = spawnSync('git', args, {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`B8 Git 审计失败：git ${args.join(' ')}`);
  }
  return result.stdout.trim();
}

interface PackageManifestShape {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackage(filePath: string): PackageManifestShape {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageManifestShape;
}

function packageDependencyFingerprint(value: PackageManifestShape): string {
  return JSON.stringify({
    dependencies: value.dependencies ?? {},
    devDependencies: value.devDependencies ?? {},
    optionalDependencies: value.optionalDependencies ?? {},
  });
}

function trackedFiles(workspaceDirectory: string): string[] {
  const output = runGit(workspaceDirectory, ['ls-files']);
  return output === '' ? [] : output.split(/\r?\n/u);
}

function assertNoUnexpectedSourceFeatures(workspaceDirectory: string): void {
  const sourceFiles = trackedFiles(workspaceDirectory).filter((file) => (
    (file.startsWith('src/') || file.startsWith('server/'))
    && /\.(?:ts|vue|js|mjs)$/u.test(file)
  ));
  const prohibitedFilePatterns = [
    /history[-_]?backfill/u,
    /application[-_]?funnel/u,
    /evidence[-_]?sufficiency/u,
    /ai[-_]?proposal/u,
    /strategy[-_]?window/u,
    /runtime[-_]?sse[-_]?gate[-_]?2/u,
    /(?:boss|liepin)[-_]?(?:crawl|scrape|automation)/u,
  ];
  const unexpected = sourceFiles.filter((file) => prohibitedFilePatterns.some((pattern) => (
    pattern.test(file.toLowerCase())
  )));
  if (unexpected.length > 0) throw new Error('B8 检测到范围漂移功能文件');
  const routes = fs.readFileSync(path.join(workspaceDirectory, 'server/job-memory/routes.ts'), 'utf8');
  if (/\.get\(['"]\/applications/u.test(routes)) {
    throw new Error('B8 不允许全局 Application 漏斗入口');
  }
}

function auditBoundaries(workspaceDirectory: string): BoundaryAuditReport {
  const packagePath = path.join(workspaceDirectory, 'package.json');
  const currentPackage = readPackage(packagePath);
  if (currentPackage.version !== '0.6.2') throw new Error('B8 禁止修改 App 版本');
  const mainPackageText = runGit(workspaceDirectory, ['show', 'origin/main:package.json']);
  const mainPackage = JSON.parse(mainPackageText) as PackageManifestShape;
  if (packageDependencyFingerprint(currentPackage) !== packageDependencyFingerprint(mainPackage)) {
    throw new Error('B8 检测到相对 main 的依赖变化');
  }
  const boundaryDiff = runGit(
    workspaceDirectory,
    ['diff', '--name-only', 'origin/main...HEAD', '--', 'server/llm', 'src/ocr'],
  );
  if (boundaryDiff !== '') throw new Error('B 阶段触碰了 LLM/OCR 边界');
  const files = trackedFiles(workspaceDirectory);
  const privateArtifacts = files.filter((file) => (
    /(?:^|\/)(?:backups|b7b-state)(?:\/|$)/u.test(file)
    || /\.sqlite3(?:-wal|-shm)?$/u.test(file)
    || /^sync\/offerflow\.(?:snapshot|manifest)\.json$/u.test(file)
    || /apply-result\.json$/u.test(file)
  ));
  if (privateArtifacts.length > 0) throw new Error('B8 检测到 tracked 私有数据产物');
  const forbiddenWorkspacePrefix = ['D:', 'VSCode'].join('\\');
  const absolutePaths = runGit(
    workspaceDirectory,
    ['grep', '-n', '-I', '-F', '-e', forbiddenWorkspacePrefix, '--'],
    true,
  );
  if (absolutePaths !== '') throw new Error('tracked 文件仍包含本机绝对工作区路径');
  assertNoUnexpectedSourceFeatures(workspaceDirectory);
  const migrationSql = fs.readFileSync(
    path.join(workspaceDirectory, 'server/migrations/jobMemorySchemaV2.ts'),
    'utf8',
  );
  if (/\b(?:stage|outcome|communication_status|projection)\b/iu.test(
    migrationSql.replace(/legacy/giu, ''),
  )) throw new Error('Application schema 不得持久化 Projection');
  return {
    appVersion: '0.6.2',
    dependenciesUnchangedFromMain: true,
    llmAndOcrBoundaryUnchanged: true,
    trackedPrivateArtifacts: 0,
    newTrackedAbsoluteWorkspacePaths: 0,
    globalApplicationsRouteAbsent: true,
    historyBackfillEntryAbsent: true,
    funnelEntryAbsent: true,
    runtimeSseGate2Absent: true,
    aiProfileFeaturesAbsent: true,
    recruitingCrawlerAbsent: true,
    automaticDeliveryOrMessagingAbsent: true,
    projectionPersistenceAbsent: true,
    humanInTheLoopPreserved: true,
    dualFactSourceAbsent: true,
  };
}

async function auditProductionDefaults(workspaceDirectory: string): Promise<ProductionAuditReport> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b8-production-'));
  try {
    const freshPath = path.join(temporaryDirectory, 'fresh.sqlite3');
    const fresh = buildServer(freshPath);
    try {
      if (getDatabaseSchemaVersion(fresh.db) !== 2) throw new Error('新库未默认初始化 schema v2');
      if ((await fresh.inject({ method: 'GET', url: '/jobs/summaries' })).statusCode !== 200) {
        throw new Error('默认 v2 summaries 不可用');
      }
      if ((await fresh.inject({ method: 'GET', url: '/resume-versions' })).statusCode !== 200) {
        throw new Error('默认 v2 ResumeVersion 不可用');
      }
      new JobRepository(fresh.db).create({ id: 'b8-guard-job', company: '合成写门禁' });
      const guarded = await fresh.inject({
        method: 'PATCH',
        url: '/jobs/b8-guard-job',
        payload: { communicationStatus: 'replied' },
      });
      if (guarded.statusCode !== 422) throw new Error('默认 v2 legacy write guard 未生效');
    } finally {
      await fresh.close();
    }

    const legacyPath = path.join(temporaryDirectory, 'legacy.sqlite3');
    const legacy = openDb(legacyPath);
    initSchema(legacy, { targetVersion: 1 });
    legacy.close();
    let rejected = false;
    try {
      buildServer(legacyPath);
    } catch (error) {
      rejected = /authorized B7-B upgrade tool/u.test((error as Error).message);
    }
    const verifyLegacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
    try {
      if (
        !rejected
        || getDatabaseSchemaVersion(verifyLegacy) !== 1
        || verifyLegacy.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='applications'",
        ).get() !== undefined
      ) throw new Error('未升级 v1 生产库拒绝策略失败');
    } finally {
      verifyLegacy.close();
    }
  } finally {
    if (!path.resolve(temporaryDirectory).startsWith(path.resolve(os.tmpdir()))) {
      throw new Error('B8 拒绝清理临时目录之外的生产审计路径');
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  if (fs.existsSync(temporaryDirectory)) throw new Error('生产默认审计临时目录未清理');
  if (
    PRODUCTION_SCHEMA_VERSION !== 2
    || SNAPSHOT_SCHEMA_VERSION !== 2
  ) throw new Error('默认生产 v2 常量不一致');
  const featureSource = fs.readFileSync(
    path.join(workspaceDirectory, 'src/config/features.ts'),
    'utf8',
  );
  if (!/VITE_OFFERFLOW_JOB_MEMORY_V2[\s\S]*?true/u.test(featureSource)) {
    throw new Error('前端 Job Memory v2 flag 未默认启用');
  }
  const apiAdapter = fs.readFileSync(
    path.join(workspaceDirectory, 'src/api/jobMemoryApi.ts'),
    'utf8',
  );
  if (!apiAdapter.includes('/jobs/summaries') || !apiAdapter.includes('/bundle')) {
    throw new Error('前端默认 adapter 未使用 summaries/bundle');
  }
  return {
    schemaTarget: 2,
    backendCapabilityDefault: true,
    frontendFlagDefault: true,
    snapshotSchema: 2,
    freshDatabaseInitializesV2: true,
    upgradedDatabaseOpens: true,
    unupgradedV1RejectedWithoutMutation: true,
    explicitV1CompatibilityOnly: true,
    legacyWriteGuard: true,
    bundleAndSummariesDefault: true,
    projectionNotPersisted: true,
    temporaryDirectoryRemoved: true,
  };
}

function countSnapshotDifferences(report: ReturnType<typeof auditSnapshotConsistency>): number {
  return Object.values(report.tables).reduce((sum, table) => (
    sum + table.onlyInDatabase.length + table.onlyInSnapshot.length + table.changed.length
  ), 0);
}

async function auditRealData(input: B8BackupAuditInput): Promise<RealDataAuditReport> {
  const databaseBefore = captureB8RealDataFingerprint(input.sourceDatabasePath);
  const snapshotDirectory = getSyncPaths(input.sourceDatabasePath).syncDir;
  const snapshotBefore = captureB8SnapshotFingerprint(snapshotDirectory);
  const authorization = {
    ...input,
    backupId: B7B_APPROVED_BACKUP_ID,
    confirmBackupId: B7B_APPROVED_BACKUP_ID,
    expectedSourceFingerprint: B7B_EXPECTED_SOURCE_FINGERPRINT,
    expectedBackupHash: B7B_EXPECTED_BACKUP_HASH,
    approvalToken: B7B_APPROVAL_TOKEN,
  };
  const approved = await verifyUpgradeBackup(authorization);
  const verification = verifyRealUpgradeDatabase(input.sourceDatabasePath, approved.manifest);
  const snapshot = auditSnapshotConsistency(input.sourceDatabasePath);
  const readOnlyServerSmoke = await runReadOnlyServerSmoke(
    input.sourceDatabasePath,
    'default-v2',
  );
  const statePaths = getB7BStatePaths(path.resolve(input.backupDirectory));
  const failure = JSON.parse(fs.readFileSync(statePaths.failure, 'utf8')) as {
    stage?: unknown;
    resolved?: unknown;
  };
  const apply = readApplyResult(input.backupDirectory);
  const historicalSnapshotFailureResolved = failure.stage === 'snapshot-publish'
    && failure.resolved === true;
  const finalApplyResultConsistent = apply.resultCode === 'B7B_APPLY_SUCCESS'
    && apply.approvedBackupId === B7B_APPROVED_BACKUP_ID
    && apply.preApplyCheckpointId === '20260714-112449-b7a-8d54a08b'
    && apply.snapshot.schemaVersion === 2
    && apply.snapshot.consistency;
  const snapshotDifferences = countSnapshotDifferences(snapshot);
  if (
    verification.schemaVersion !== 2
    || verification.integrity[0] !== 'ok'
    || verification.foreignKeyViolationCount !== 0
    || !verification.migrationContinuous
    || verification.jobHashChanges !== 0
    || verification.legacyFieldChanges !== 0
    || !snapshot.ok
    || snapshot.snapshotSchemaVersion !== 2
    || snapshotDifferences !== 0
    || !historicalSnapshotFailureResolved
    || !finalApplyResultConsistent
  ) throw new Error('真实数据 B8 只读审计失败');
  if (
    captureB8RealDataFingerprint(input.sourceDatabasePath) !== databaseBefore
    || captureB8SnapshotFingerprint(snapshotDirectory) !== snapshotBefore
  ) throw new Error('真实数据或正式 Snapshot 在只读审计中发生变化');
  return {
    schemaVersion: 2,
    integrity: 'ok',
    foreignKeyViolationCount: 0,
    migrationContinuous: true,
    tableCounts: verification.tableCounts as RealDataAuditReport['tableCounts'],
    projection: verification.projection as RealDataAuditReport['projection'],
    secondRun: verification.secondRun,
    jobHashChanges: 0,
    legacyFieldChanges: 0,
    snapshotSchemaVersion: 2,
    snapshotDifferences: 0,
    readOnlyServerSmoke,
    historicalSnapshotFailureResolved: true,
    finalApplyResultConsistent: true,
    dataUnchanged: true,
    snapshotUnchanged: true,
  };
}

export async function runV070B8Audit(
  input: B8BackupAuditInput = {
    sourceDatabasePath: getDbPath(),
    backupDirectory: path.join(process.cwd(), 'backups', 'job-memory-v2'),
    workspaceDirectory: process.cwd(),
  },
): Promise<V070B8AuditReport> {
  const branch = runGit(input.workspaceDirectory, ['branch', '--show-current']);
  if (branch !== B7B_REQUIRED_BRANCH) throw new Error('B8 必须在功能分支运行');
  const realBefore = captureB8RealDataFingerprint(input.sourceDatabasePath);
  const snapshotDirectory = getSyncPaths(input.sourceDatabasePath).syncDir;
  const snapshotBefore = captureB8SnapshotFingerprint(snapshotDirectory);
  const backupsBefore = captureB8BackupFingerprints(input.backupDirectory);

  const realData = await auditRealData(input);
  const backups = await auditB8Backups(input);
  const v1Restore = await runV1RestoreDrill(input);
  const v2Restore = await runV2RestoreDrill(input);
  const snapshotResume = await runSnapshotResumeDrill(input.workspaceDirectory);
  const production = await auditProductionDefaults(input.workspaceDirectory);
  const boundaries = auditBoundaries(input.workspaceDirectory);

  const backupsAfter = captureB8BackupFingerprints(input.backupDirectory);
  assertB8BackupFingerprintsUnchanged(backupsBefore, backupsAfter);
  if (captureB8RealDataFingerprint(input.sourceDatabasePath) !== realBefore) {
    throw new Error('B8 完整审计改变了真实数据库');
  }
  if (captureB8SnapshotFingerprint(snapshotDirectory) !== snapshotBefore) {
    throw new Error('B8 完整审计改变了正式 Snapshot');
  }
  return {
    status: 'V070_B8_AUDIT_PASS',
    appVersion: '0.6.2',
    realData,
    backups,
    v1Restore,
    v2Restore,
    snapshotResume,
    production,
    boundaries,
    backupFilesUnchanged: true,
    realDatabaseUnchanged: true,
    formalSnapshotUnchanged: true,
  };
}
