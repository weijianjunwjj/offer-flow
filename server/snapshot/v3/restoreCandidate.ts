import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { verifyRegisteredComponentsAfterRestore } from '@weijianjunwjj/nova-wing/host-snapshot';
import { assertNoSymbolicLinks, isPathInside } from '../../job-memory/upgrade/pathSafety';
import { openDb } from '../../db';
import { initSchema } from '../../schema';
import { quoteIdent } from '../../sync/tables';
import { atomicWriteJson } from '../../sync/hash';
import { createNovaWingRuntime } from '../../novawing/infrastructure';
import { NOVA_WING_ANALYSIS_SCOPES } from '../../radar/analysis/novaWingHostAdapter';
import {
  NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  bootstrapNovaWingOffline,
} from './bootstrap';
import { restoreNovaWingComponentData } from './data';
import { HostSnapshotV3Error, hostSnapshotError } from './errors';
import {
  componentDataByName,
  hostSnapshotRegistry,
  readAndVerifyHostSnapshotV3,
} from './hostSnapshot';
import { OFFERFLOW_COMPONENT_NAME, type RestoreCandidateReport, type SnapshotComponentData } from './types';

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
  for (const value of [
    options.snapshotDirectory,
    options.candidateDatabasePath,
    options.workingDirectory,
    options.workspaceDirectory,
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_INVALID', '候选库恢复需要全部显式路径参数');
    }
  }
  const resolved = {
    snapshotDirectory: path.resolve(options.snapshotDirectory),
    candidateDatabasePath: path.resolve(options.candidateDatabasePath),
    reportPath: `${path.resolve(options.candidateDatabasePath)}.host-snapshot-v3-report.json`,
    workingDirectory: path.resolve(options.workingDirectory),
    workspaceDirectory: path.resolve(options.workspaceDirectory),
  };
  if (!fs.existsSync(resolved.workingDirectory) || !fs.statSync(resolved.workingDirectory).isDirectory()) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_INVALID', '候选库 working directory 必须已经存在');
  }
  if (!fs.existsSync(path.join(resolved.workspaceDirectory, '.git'))) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_INVALID', 'workspaceDirectory 必须是 OfferFlow Git 工作区');
  }
  if (
    isPathInside(resolved.workspaceDirectory, resolved.workingDirectory)
    || resolved.workspaceDirectory === resolved.workingDirectory
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_INVALID', '候选库 working directory 必须位于源码工作区之外');
  }
  if (
    !isPathInside(resolved.workingDirectory, resolved.candidateDatabasePath)
    || resolved.workingDirectory === resolved.candidateDatabasePath
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_INVALID', '候选库必须位于显式 working directory 内');
  }
  if (fs.existsSync(resolved.candidateDatabasePath) || fs.existsSync(resolved.reportPath)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_INVALID', '候选库恢复不覆盖已有文件或报告');
  }
  assertNoSymbolicLinks(resolved.snapshotDirectory);
  assertNoSymbolicLinks(resolved.workingDirectory);
  assertNoSymbolicLinks(resolved.candidateDatabasePath);
  return resolved;
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

function removeCandidateArtifacts(paths: ResolvedRestorePaths): void {
  for (const candidate of [
    paths.reportPath,
    `${paths.candidateDatabasePath}-journal`,
    `${paths.candidateDatabasePath}-shm`,
    `${paths.candidateDatabasePath}-wal`,
    paths.candidateDatabasePath,
  ]) {
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
  }
}

function proveClosedAndRenameable(candidateDatabasePath: string): void {
  const probePath = `${candidateDatabasePath}.rename-probe`;
  if (fs.existsSync(probePath)) fs.rmSync(probePath, { force: true });
  fs.renameSync(candidateDatabasePath, probePath);
  try {
    fs.renameSync(probePath, candidateDatabasePath);
  } catch (error) {
    try { if (fs.existsSync(probePath)) fs.renameSync(probePath, candidateDatabasePath); } catch { /* cleanup below */ }
    throw error;
  }
}

export function restoreHostSnapshotV3ToCandidate(
  options: RestoreHostSnapshotV3CandidateOptions,
): RestoreCandidateReport {
  if (options.confirmation !== HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED', '候选库恢复缺少显式确认');
  }
  const paths = resolveRestorePaths(options);
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
    fs.mkdirSync(path.dirname(paths.candidateDatabasePath), { recursive: true });
    const candidate = openDb(paths.candidateDatabasePath);
    try {
      initSchema(candidate, { targetVersion: verified.manifest.host.schemaVersion });
    } finally {
      candidate.close();
    }
    bootstrapNovaWingOffline({
      databasePath: paths.candidateDatabasePath,
      confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
    });
    if (options.hooks?.failAfterSchemaBootstrap) throw new Error('TEST_FAIL_AFTER_SCHEMA_BOOTSTRAP');

    restoreOfferFlowData(
      paths.candidateDatabasePath,
      componentDataByName(verified.data.components, OFFERFLOW_COMPONENT_NAME),
    );
    if (options.hooks?.failAfterOfferFlowRestore) throw new Error('TEST_FAIL_AFTER_OFFERFLOW_RESTORE');
    restoreNovaWingData(
      paths.candidateDatabasePath,
      componentDataByName(verified.data.components, 'novawing'),
    );
    if (options.hooks?.failAfterNovaWingRestore) throw new Error('TEST_FAIL_AFTER_NOVAWING_RESTORE');
    options.hooks?.mutateCandidateBeforeVerification?.(paths.candidateDatabasePath);
    if (options.hooks?.failBeforeVerification) throw new Error('TEST_FAIL_BEFORE_VERIFICATION');

    const checks = verifyCandidate(paths.candidateDatabasePath, verified.manifest);
    proveClosedAndRenameable(paths.candidateDatabasePath);
    const report: RestoreCandidateReport = {
      ...baseReport,
      ...checks,
      status: 'candidate-ready',
      renameProbe: 'passed',
    };
    atomicWriteJson(paths.reportPath, report);
    return report;
  } catch (error) {
    removeCandidateArtifacts(paths);
    if (error instanceof HostSnapshotV3Error) throw error;
    throw hostSnapshotError('HOST_SNAPSHOT_V3_RESTORE_FAILED', 'Host Snapshot V3 候选库恢复失败');
  }
}
