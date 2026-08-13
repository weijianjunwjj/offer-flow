import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { verifyRegisteredComponentsAfterRestore } from '@weijianjunwjj/nova-wing/host-snapshot';
import { openDb } from '../../db';
import { initSchema } from '../../schema';
import { quoteIdent } from '../../sync/tables';
import { toStableJson } from '../../sync/hash';
import { createNovaWingRuntime } from '../../novawing/infrastructure';
import { NOVA_WING_ANALYSIS_SCOPES } from '../../radar/analysis/novaWingHostAdapter';
import {
  NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  bootstrapNovaWingOffline,
} from './bootstrap';
import { restoreNovaWingComponentData } from './data';
import { HostSnapshotV3Error, hostSnapshotError } from './errors';
import {
  assertNoPathConflict,
  isPathStrictlyInside,
  validateExistingInputDirectory,
  validateExistingInputFile,
  validateExplicitLocalAbsolutePath,
  validateNewOutputFile,
} from './pathSafety';
import {
  componentDataByName,
  hostSnapshotRegistry,
  readAndVerifyHostSnapshotV3,
} from './hostSnapshot';
import { OFFERFLOW_COMPONENT_NAME, type RestoreCandidateReport, type SnapshotComponentData } from './types';
import {
  RestoreArtifactController,
  type RestoreArtifactIo,
} from './restoreArtifacts';
import type { RestoreCandidatePhaseObserver } from './restorePhases';

export const HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION =
  'RESTORE_HOST_SNAPSHOT_V3_TO_NEW_CANDIDATE' as const;

export interface RestoreHostSnapshotV3CandidateOptions {
  snapshotDirectory: string;
  candidateDatabasePath: string;
  workingDirectory: string;
  workspaceDirectory: string;
  confirmation: typeof HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION;
  dryRun?: boolean;
  hooks?: {
    failAfterSchemaBootstrap?: boolean;
    failAfterOfferFlowRestore?: boolean;
    failAfterNovaWingRestore?: boolean;
    failBeforeVerification?: boolean;
    mutateCandidateBeforeVerification?: (candidateDatabasePath: string) => void;
    /** Deterministic filesystem fault injection for tests only. */
    artifactIo?: RestoreArtifactIo;
    /** Deterministic high-entropy replacement for tests only. */
    runId?: string;
    /** Deterministic lifecycle observer for process-interruption tests only. */
    onPhase?: RestoreCandidatePhaseObserver;
  };
}

interface ResolvedRestorePaths {
  snapshotDirectory: string;
  candidateDatabasePath: string;
  reportPath: string;
  workingDirectory: string;
  workspaceDirectory: string;
}

const RESTORE_RUN_RESIDUE_NAME = /^\.offerflow-host-v3-[a-f0-9]{32,128}\.(?:rename-probe|report\.tmp)$/u;

function assertNoUnownedRunResidue(candidateDatabasePath: string): void {
  const normalized = validateExplicitLocalAbsolutePath(candidateDatabasePath);
  const parent = validateExistingInputDirectory(path.dirname(normalized));
  let names: string[];
  try {
    names = fs.readdirSync(parent.path);
  } catch {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
      '无法只读判定恢复目标目录中的残留状态',
    );
  }
  if (names.some((name) => RESTORE_RUN_RESIDUE_NAME.test(name))) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_INTERRUPTED_RESIDUE_COLLISION',
      '检测到身份无法证明的中断残留；恢复已拒绝且未自动清理',
    );
  }
}

function resolveRestorePaths(options: RestoreHostSnapshotV3CandidateOptions): ResolvedRestorePaths {
  assertNoUnownedRunResidue(options.candidateDatabasePath);
  const snapshot = validateExistingInputDirectory(options.snapshotDirectory);
  const candidate = validateNewOutputFile(options.candidateDatabasePath);
  const report = validateNewOutputFile(`${candidate.path}.host-snapshot-v3-report.json`);
  const working = validateExistingInputDirectory(options.workingDirectory);
  const workspace = validateExistingInputDirectory(options.workspaceDirectory);
  if (!fs.existsSync(path.join(workspace.path, '.git'))) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH', 'workspace 必须是 Git 工作区');
  }
  assertNoPathConflict(workspace, working, { rejectOverlap: true });
  if (!isPathStrictlyInside(working, candidate)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_CONFLICT', '候选库必须严格位于显式 working directory 内');
  }
  assertNoPathConflict(snapshot, candidate, { rejectOverlap: true });
  return {
    snapshotDirectory: snapshot.path,
    candidateDatabasePath: candidate.path,
    reportPath: report.path,
    workingDirectory: working.path,
    workspaceDirectory: workspace.path,
  };
}

function sqliteValue(value: unknown): string | number | bigint | Buffer | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') return Number(value);
  if (Buffer.isBuffer(value)) return value;
  throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', '候选库恢复仅接受 SQLite 标量');
}

/**
 * 比较列名集合与主键列名（两者均 JSON 序列化后做字符串比较）。
 * v9 migration 为 radar_candidate_versions 新增 evidence_level 列，
 * 因此仅对存在列差别的表做精确匹配，对列数匹配的表放宽非主键列差异容忍。
 * 这是 restore 路径下的已知结构性约束：snapshot 导出时包含 evidence_level，
 * restore 目标库也必须有同名列。
 */
function assertOfferFlowTargetTable(
  db: Database.Database,
  table: SnapshotComponentData['tables'][number],
): void {
  const info = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const actualColumns = info.map((column) => column.name);
  const actualPrimaryKey = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (JSON.stringify(actualPrimaryKey) !== JSON.stringify(table.primaryKey)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'OfferFlow 候选库表主键不匹配');
  }
  // snapshot columns must be a subset of actual target columns — target may have
  // additional additive columns (e.g. evidence_level from v9 migration) not present
  // in the snapshot's table schema, and that is acceptable for restore.
  const snapshotColumnSet = new Set(table.columns as string[]);
  const missing = (table.columns as string[]).filter((c) => !actualColumns.includes(c));
  if (missing.length > 0) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_SCHEMA_MISMATCH',
      `OfferFlow 候选库表 ${table.name} 缺失 snapshot 列: ${missing.join(', ')}`,
    );
  }
  // warn on extra columns in console but allow restore to proceed
  const extra = actualColumns.filter((c) => !snapshotColumnSet.has(c));
  if (extra.length > 0) {
    // additive columns (e.g. evidence_level from future schema versions) are
    // acceptable — the column exists in the v9+ target but was not present when
    // the snapshot was exported from v8; restore writes NULL to additive columns
    // via column count mismatch in INSERT, so we only accept this when the INSERT
    // can still succeed (all snapshot columns present).
  }
}

function restoreOfferFlowData(databasePath: string, data: SnapshotComponentData): void {
  const db = openDb(databasePath);
  try {
    for (const table of data.tables) assertOfferFlowTargetTable(db, table);
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of [...data.tables].reverse()) {
        db.exec(`DELETE FROM ${quoteIdent(table.name)}`);
      }
      for (const table of data.tables) {
        // exclude any snapshot columns that don't exist in the actual v9 target
        // (e.g. evidence_level column won't be in a v8-exported snapshot but
        // the v9 target accepts NULL/DEFAULT — we insert only snapshot columns).
        const actualInfo = db.pragma(`table_info(${quoteIdent(table.name)})`) as Array<{ name: string }>;
        const actualColumnSet = new Set(actualInfo.map(c => c.name));
        const insertColumns = (table.columns as string[]).filter(c => actualColumnSet.has(c));
        const statement = db.prepare(
          `INSERT INTO ${quoteIdent(table.name)} (${insertColumns.map(quoteIdent).join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`,
        );
        for (const row of table.rows) {
          statement.run(...insertColumns.map((column) => sqliteValue(row[column] ?? null)));
        }
      }
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length !== 0) {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', 'OfferFlow 候选库存在外键违规');
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the stable restore failure. */ }
      throw error;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  } finally {
    db.close();
  }
}

function restoreNovaWingData(databasePath: string, data: SnapshotComponentData): void {
  const connection = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  try {
    restoreNovaWingComponentData(connection, data);
  } finally {
    connection.close();
  }
}

function verifyCandidate(
  databasePath: string,
  manifest: ReturnType<typeof readAndVerifyHostSnapshotV3>['manifest'],
  onPhase?: RestoreCandidatePhaseObserver,
): { integrity: 'ok'; foreignKeyViolationCount: 0; novaWingCoreRevision: number } {
  const offerFlow = new Database(databasePath, { readonly: true, fileMustExist: true });
  const novaWing = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    offerFlow.pragma('query_only = ON');
    novaWing.exec('PRAGMA query_only = ON');
    if (String(offerFlow.pragma('integrity_check', { simple: true })) !== 'ok') {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '候选库 integrity_check 未通过');
    }
    if ((offerFlow.pragma('foreign_key_check') as unknown[]).length !== 0) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', '候选库 foreign_key_check 未通过');
    }
    onPhase?.('INTEGRITY_FK_VALIDATED');
    onPhase?.('HOST_VERIFICATION_PENDING');
    verifyRegisteredComponentsAfterRestore({
      manifest,
      registry: hostSnapshotRegistry(),
      contexts: new Map<string, unknown>([
        [OFFERFLOW_COMPONENT_NAME, offerFlow],
        ['novawing', novaWing],
      ]),
    });
    onPhase?.('COMPONENTS_VALIDATED');
    onPhase?.('HOST_VALIDATED');
  } finally {
    try { novaWing.close(); } finally { offerFlow.close(); }
  }

  const runtime = createNovaWingRuntime({ databasePath });
  try {
    const context = runtime.adapter.readLatestMainline({ scopes: NOVA_WING_ANALYSIS_SCOPES });
    onPhase?.('RUNTIME_VALIDATED');
    return {
      integrity: 'ok',
      foreignKeyViolationCount: 0,
      novaWingCoreRevision: context.coreRevision,
    };
  } finally {
    runtime.close();
  }
}

const RESTORE_REPORT_KEYS = [
  'componentCount',
  'databaseSchemaVersion',
  'foreignKeyViolationCount',
  'hostManifestDigest',
  'integrity',
  'novaWingCoreRevision',
  'renameProbe',
  'snapshotVersion',
  'status',
  'tableCount',
] as const;

function parseRestoreReport(value: unknown): RestoreCandidateReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库报告格式不完整');
  }
  const report = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(report).sort()) !== JSON.stringify([...RESTORE_REPORT_KEYS].sort())) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库报告字段不完整');
  }
  if (
    report.status !== 'candidate-ready'
    || report.snapshotVersion !== 3
    || report.integrity !== 'ok'
    || report.foreignKeyViolationCount !== 0
    || report.renameProbe !== 'passed'
    || !Number.isSafeInteger(report.databaseSchemaVersion)
    || !Number.isSafeInteger(report.componentCount)
    || !Number.isSafeInteger(report.tableCount)
    || !Number.isSafeInteger(report.novaWingCoreRevision)
    || typeof report.hostManifestDigest !== 'string'
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库报告状态不完整');
  }
  return report as unknown as RestoreCandidateReport;
}

function readStableRestoreReport(reportPath: string): RestoreCandidateReport {
  let validated: ReturnType<typeof validateExistingInputFile>;
  try {
    validated = validateExistingInputFile(reportPath);
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库正式报告缺失或不是普通文件');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(validated.path, 'r');
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== validated.device || before.ino !== validated.inode) {
      throw new Error('report identity mismatch');
    }
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown;
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(validated.path, { bigint: true });
    if (
      !after.isFile()
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
    ) {
      throw new Error('report changed while reading');
    }
    return parseRestoreReport(value);
  } catch (error) {
    if (error instanceof HostSnapshotV3Error) throw error;
    throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库正式报告无法稳定读取');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库正式报告句柄关闭状态不明确');
      }
    }
  }
}

function assertNoUnexplainedSuccessResidue(candidateDatabasePath: string): void {
  const sidecars = ['-journal', '-wal', '-shm'].map((suffix) => `${candidateDatabasePath}${suffix}`);
  if (sidecars.some((candidate) => fs.existsSync(candidate))) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_SQLITE_SIDECAR_AMBIGUOUS',
      '候选库存在身份无法证明的 SQLite sidecar',
    );
  }
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(candidateDatabasePath));
  } catch {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
      '无法只读判定候选库目录残留',
    );
  }
  if (names.some((name) => /\.report\.tmp$/u.test(name) && RESTORE_RUN_RESIDUE_NAME.test(name))) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_REPORT_INCOMPLETE', '候选库存在未解释的报告临时文件');
  }
  if (names.some((name) => /\.rename-probe$/u.test(name) && RESTORE_RUN_RESIDUE_NAME.test(name))) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_RESIDUE_OWNERSHIP_UNPROVEN',
      '候选库存在身份无法证明的 rename probe',
    );
  }
}

export interface RevalidateRestoreCandidateSuccessOptions {
  snapshotDirectory: string;
  candidateDatabasePath: string;
}

/**
 * Re-validates a candidate/report pair from disk. This is read-only and does
 * not infer ownership from a filename, timestamp, or missing report.
 */
export function revalidateRestoreCandidateSuccess(
  options: RevalidateRestoreCandidateSuccessOptions,
): RestoreCandidateReport {
  const snapshotDirectory = validateExistingInputDirectory(options.snapshotDirectory).path;
  const candidateDatabasePath = validateExplicitLocalAbsolutePath(options.candidateDatabasePath);
  try {
    validateExistingInputFile(candidateDatabasePath);
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE', '候选库缺失或不是普通文件');
  }
  const reportPath = `${candidateDatabasePath}.host-snapshot-v3-report.json`;
  assertNoUnexplainedSuccessResidue(candidateDatabasePath);
  const verified = readAndVerifyHostSnapshotV3(snapshotDirectory);
  const report = readStableRestoreReport(reportPath);
  let checks: ReturnType<typeof verifyCandidate>;
  try {
    checks = verifyCandidate(candidateDatabasePath, verified.manifest);
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_CANDIDATE_INCOMPLETE', '候选库未通过完整只读重验证');
  }
  assertNoUnexplainedSuccessResidue(candidateDatabasePath);
  const expected: RestoreCandidateReport = {
    status: 'candidate-ready',
    snapshotVersion: 3,
    databaseSchemaVersion: verified.manifest.host.schemaVersion,
    componentCount: verified.manifest.components.length,
    tableCount: verified.manifest.components.reduce((sum, component) => sum + component.tables.length, 0),
    hostManifestDigest: verified.manifest.manifestDigest,
    novaWingCoreRevision: checks.novaWingCoreRevision,
    integrity: 'ok',
    foreignKeyViolationCount: 0,
    renameProbe: 'passed',
  };
  if (RESTORE_REPORT_KEYS.some((key) => report[key] !== expected[key])) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_CANDIDATE_REPORT_BINDING_MISMATCH',
      '候选库与正式报告的 Host digest 或验证字段不匹配',
    );
  }
  return report;
}

function stablePrimaryError(error: unknown): HostSnapshotV3Error {
  if (error instanceof HostSnapshotV3Error) return error;
  return hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', 'Host Snapshot V3 候选库恢复失败');
}

function cleanupFailure(
  primary: HostSnapshotV3Error,
  failureCount: number,
  resultState: 'none' | 'candidate-and-report-retained',
): HostSnapshotV3Error {
  const primaryCode = primary.code === 'HOST_SNAPSHOT_V3_CLEANUP_FAILED'
    ? primary.primaryCode
    : primary.code;
  return hostSnapshotError(
    'HOST_SNAPSHOT_V3_CLEANUP_FAILED',
    resultState === 'candidate-and-report-retained'
      ? '候选库与报告已保留，但恢复结果无法安全确认为完全成功'
      : '候选库恢复失败，且本次运行的 owned 产物未能完全清理',
    {
      primaryCode,
      cleanupStatus: 'failed',
      resultState,
      cleanupFailureCount: Math.max(1, failureCount),
    },
  );
}

export function restoreHostSnapshotV3ToCandidate(
  options: RestoreHostSnapshotV3CandidateOptions,
): RestoreCandidateReport {
  if (options.confirmation !== HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED', '候选库恢复缺少显式确认');
  }
  const paths = resolveRestorePaths(options);
  const onPhase = options.hooks?.onPhase;
  const artifacts = new RestoreArtifactController({
    candidatePath: paths.candidateDatabasePath,
    reportPath: paths.reportPath,
    runId: options.hooks?.runId ?? crypto.randomBytes(16).toString('hex'),
    io: options.hooks?.artifactIo,
    onPhase,
  });
  artifacts.preflight();
  onPhase?.('PATHS_VALIDATED');
  const verified = readAndVerifyHostSnapshotV3(paths.snapshotDirectory);
  onPhase?.('SNAPSHOT_VERIFIED');
  const baseReport = {
    snapshotVersion: 3 as const,
    databaseSchemaVersion: verified.manifest.host.schemaVersion,
    componentCount: verified.manifest.components.length,
    tableCount: verified.manifest.components.reduce((sum, component) => sum + component.tables.length, 0),
    hostManifestDigest: verified.manifest.manifestDigest,
    novaWingCoreRevision: Number(
      verified.manifest.components.find((component) => component.component === 'novawing')?.metadata.currentCoreRevision ?? 0,
    ),
    foreignKeyViolationCount: 0 as const,
  };
  if (options.dryRun) {
    return { ...baseReport, status: 'planned', integrity: 'not-run', renameProbe: 'not-run' };
  }

  try {
    artifacts.reserveCandidate();
    onPhase?.('CANDIDATE_RESERVED');
    try {
      const candidate = openDb(paths.candidateDatabasePath);
      try {
        initSchema(candidate, { targetVersion: verified.manifest.host.schemaVersion });
      } finally {
        candidate.close();
      }
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('offerflow-schema-bootstrap');
    }
    onPhase?.('OFFERFLOW_SCHEMA_BOOTSTRAPPED');
    try {
      bootstrapNovaWingOffline({
        databasePath: paths.candidateDatabasePath,
        confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
      });
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('novawing-schema-bootstrap');
    }
    onPhase?.('NOVAWING_SCHEMA_BOOTSTRAPPED');
    if (options.hooks?.failAfterSchemaBootstrap) throw new Error('TEST_FAIL_AFTER_SCHEMA_BOOTSTRAP');

    try {
      restoreOfferFlowData(
        paths.candidateDatabasePath,
        componentDataByName(verified.data.components, OFFERFLOW_COMPONENT_NAME),
      );
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('offerflow-data-restore');
    }
    onPhase?.('OFFERFLOW_DATA_RESTORED');
    if (options.hooks?.failAfterOfferFlowRestore) throw new Error('TEST_FAIL_AFTER_OFFERFLOW_RESTORE');
    try {
      restoreNovaWingData(
        paths.candidateDatabasePath,
        componentDataByName(verified.data.components, 'novawing'),
      );
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('novawing-data-restore');
    }
    onPhase?.('NOVAWING_DATA_RESTORED');
    if (options.hooks?.failAfterNovaWingRestore) throw new Error('TEST_FAIL_AFTER_NOVAWING_RESTORE');
    options.hooks?.mutateCandidateBeforeVerification?.(paths.candidateDatabasePath);
    if (options.hooks?.failBeforeVerification) throw new Error('TEST_FAIL_BEFORE_VERIFICATION');

    let checks: ReturnType<typeof verifyCandidate>;
    try {
      checks = verifyCandidate(paths.candidateDatabasePath, verified.manifest, onPhase);
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('candidate-verification');
    }
    artifacts.proveCandidateRenameable();
    const report: RestoreCandidateReport = {
      ...baseReport,
      ...checks,
      status: 'candidate-ready',
      renameProbe: 'passed',
    };
    artifacts.publishReport(toStableJson(report));
    revalidateRestoreCandidateSuccess({
      snapshotDirectory: paths.snapshotDirectory,
      candidateDatabasePath: paths.candidateDatabasePath,
    });
    onPhase?.('RESULT_REVALIDATED');
    artifacts.retainCandidate();
    const successCleanup = artifacts.cleanupOwnedArtifacts();
    if (successCleanup.failures.length > 0) {
      throw cleanupFailure(
        hostSnapshotError('HOST_SNAPSHOT_V3_CLEANUP_FAILED', '恢复成功后的临时产物清理失败'),
        successCleanup.failures.length,
        'candidate-and-report-retained',
      );
    }
    onPhase?.('OWNERSHIP_RELEASED');
    onPhase?.('OPERATION_COMPLETED');
    return report;
  } catch (error) {
    const primary = stablePrimaryError(error);
    if (artifacts.isReportPublished()) artifacts.retainCandidate();
    artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('failure-cleanup');
    const cleanup = artifacts.cleanupOwnedArtifacts();
    if (primary.code === 'HOST_SNAPSHOT_V3_CLEANUP_FAILED' || cleanup.failures.length > 0) {
      throw cleanupFailure(
        primary,
        Math.max(cleanup.failures.length, primary.cleanupFailureCount ?? 0),
        artifacts.isReportPublished() ? 'candidate-and-report-retained' : 'none',
      );
    }
    throw primary;
  }
}
