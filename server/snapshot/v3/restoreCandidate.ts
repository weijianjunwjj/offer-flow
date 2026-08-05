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
  };
}

interface ResolvedRestorePaths {
  snapshotDirectory: string;
  candidateDatabasePath: string;
  reportPath: string;
  workingDirectory: string;
  workspaceDirectory: string;
}

function resolveRestorePaths(options: RestoreHostSnapshotV3CandidateOptions): ResolvedRestorePaths {
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

function assertOfferFlowTargetTable(
  db: Database.Database,
  table: SnapshotComponentData['tables'][number],
): void {
  const info = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const columns = info.map((column) => column.name);
  const primaryKey = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (
    JSON.stringify(columns) !== JSON.stringify(table.columns)
    || JSON.stringify(primaryKey) !== JSON.stringify(table.primaryKey)
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'OfferFlow 候选库表结构不匹配');
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
        const statement = db.prepare(
          `INSERT INTO ${quoteIdent(table.name)} (${table.columns.map(quoteIdent).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`,
        );
        for (const row of table.rows) {
          statement.run(...table.columns.map((column) => sqliteValue(row[column] ?? null)));
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
    verifyRegisteredComponentsAfterRestore({
      manifest,
      registry: hostSnapshotRegistry(),
      contexts: new Map<string, unknown>([
        [OFFERFLOW_COMPONENT_NAME, offerFlow],
        ['novawing', novaWing],
      ]),
    });
  } finally {
    try { novaWing.close(); } finally { offerFlow.close(); }
  }

  const runtime = createNovaWingRuntime({ databasePath });
  try {
    const context = runtime.adapter.readLatestMainline({ scopes: NOVA_WING_ANALYSIS_SCOPES });
    return {
      integrity: 'ok',
      foreignKeyViolationCount: 0,
      novaWingCoreRevision: context.coreRevision,
    };
  } finally {
    runtime.close();
  }
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
  const artifacts = new RestoreArtifactController({
    candidatePath: paths.candidateDatabasePath,
    reportPath: paths.reportPath,
    runId: options.hooks?.runId ?? crypto.randomBytes(16).toString('hex'),
    io: options.hooks?.artifactIo,
  });
  artifacts.preflight();
  const verified = readAndVerifyHostSnapshotV3(paths.snapshotDirectory);
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
    try {
      bootstrapNovaWingOffline({
        databasePath: paths.candidateDatabasePath,
        confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
      });
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('novawing-schema-bootstrap');
    }
    if (options.hooks?.failAfterSchemaBootstrap) throw new Error('TEST_FAIL_AFTER_SCHEMA_BOOTSTRAP');

    try {
      restoreOfferFlowData(
        paths.candidateDatabasePath,
        componentDataByName(verified.data.components, OFFERFLOW_COMPONENT_NAME),
      );
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('offerflow-data-restore');
    }
    if (options.hooks?.failAfterOfferFlowRestore) throw new Error('TEST_FAIL_AFTER_OFFERFLOW_RESTORE');
    try {
      restoreNovaWingData(
        paths.candidateDatabasePath,
        componentDataByName(verified.data.components, 'novawing'),
      );
    } finally {
      artifacts.recordSidecarsCreatedDuringOwnedCandidateOperation('novawing-data-restore');
    }
    if (options.hooks?.failAfterNovaWingRestore) throw new Error('TEST_FAIL_AFTER_NOVAWING_RESTORE');
    options.hooks?.mutateCandidateBeforeVerification?.(paths.candidateDatabasePath);
    if (options.hooks?.failBeforeVerification) throw new Error('TEST_FAIL_BEFORE_VERIFICATION');

    let checks: ReturnType<typeof verifyCandidate>;
    try {
      checks = verifyCandidate(paths.candidateDatabasePath, verified.manifest);
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
    artifacts.retainCandidate();
    const successCleanup = artifacts.cleanupOwnedArtifacts();
    if (successCleanup.failures.length > 0) {
      throw cleanupFailure(
        hostSnapshotError('HOST_SNAPSHOT_V3_CLEANUP_FAILED', '恢复成功后的临时产物清理失败'),
        successCleanup.failures.length,
        'candidate-and-report-retained',
      );
    }
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
