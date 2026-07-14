import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { projectApplication } from '../../../src/domain/job-memory';
import { openDb } from '../../db';
import { getDatabaseSchemaVersion } from '../../migrations';
import { initSchema } from '../../schema';
import { runSnapshotV2Roundtrip, type SnapshotV2RoundtripReport } from '../../snapshot/v2';
import { atomicWriteJson, sha256Hex } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import type { SnapshotTable, SyncTableName } from '../../sync/types';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import {
  verifyUpgradeBackup,
  type VerifyUpgradeBackupOptions,
} from './backup';
import {
  inspectSourceDatabase,
  inspectionFingerprint,
} from './inspection';
import { runLegacyBackfill, type LegacyBackfillSummary } from './legacyBackfill';
import {
  assertDistinctDatabasePaths,
  isPathInside,
  resolveBackupRunDirectory,
  resolveUpgradePaths,
} from './pathSafety';

export interface UpgradeDryRunReport {
  toolVersion: 'b7-a-v1';
  backupId: string;
  sourceSchemaVersion: 1;
  targetSchemaVersion: 2;
  sourceTableCounts: Record<string, number>;
  classifications: LegacyBackfillSummary['classifications'];
  legacyStatusCounts: LegacyBackfillSummary['byLegacyStatus'];
  wouldCreateApplications: number;
  wouldCreateLegacySeeds: number;
  skipCount: number;
  manualReviewCount: number;
  projectionHealth: { valid: number; degraded: number; invalid: number };
  secondRun: { createdApplications: number; createdEvents: number; auditLogCreated: boolean };
  jobHashChangeCount: number;
  profileRowsUnchanged: boolean;
  originalImportLogRowsUnchanged: boolean;
  integrity: string[];
  foreignKeyViolationCount: number;
  snapshotV2: SnapshotV2RoundtripReport;
  sourceUnchanged: boolean;
  backupDatabaseUnchanged: boolean;
  formalSnapshotUnchanged: boolean;
  disposableCloneRemoved: boolean;
}

function rowHashes(table: SnapshotTable): Map<string, string> {
  return new Map(table.rows.map((row) => {
    const id = JSON.stringify(table.primaryKey.map((column) => row[column] ?? null));
    return [id, sha256Hex(JSON.stringify(table.columns.map((column) => row[column] ?? null)))];
  }));
}

function changedRows(before: SnapshotTable, after: SnapshotTable): number {
  const left = rowHashes(before);
  const right = rowHashes(after);
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].filter((key) => left.get(key) !== right.get(key)).length;
}

function readTable(db: Database.Database, table: string): SnapshotTable {
  return readSnapshotTable(db, table as SyncTableName);
}

function readOriginalImportLogs(db: Database.Database): SnapshotTable {
  const full = readTable(db, 'import_logs');
  return {
    ...full,
    rows: full.rows.filter((row) => row.source !== 'job-memory-v2-backfill'),
  };
}

function databaseHealth(db: Database.Database): { integrity: string[]; foreignKeyViolationCount: number } {
  const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
    .map((row) => String(row[Object.keys(row)[0] ?? ''] ?? ''));
  return {
    integrity,
    foreignKeyViolationCount: (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length,
  };
}

function projectionHealth(db: Database.Database): UpgradeDryRunReport['projectionHealth'] {
  const applications = new ApplicationRepository(db);
  const events = new FeedbackEventRepository(db);
  const health = { valid: 0, degraded: 0, invalid: 0 };
  for (const application of applications.listApplications()) {
    health[projectApplication(
      application,
      events.listEventsByApplication(application.id),
    ).projectionStatus] += 1;
  }
  return health;
}

function snapshotFileFingerprint(report: ReturnType<typeof inspectSourceDatabase>): string {
  return sha256Hex(JSON.stringify(report.snapshotV1.files.map((file) => ({
    name: file.name,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  }))));
}

export async function runUpgradeDryRun(
  options: VerifyUpgradeBackupOptions,
): Promise<UpgradeDryRunReport> {
  const paths = resolveUpgradePaths(options);
  const sourceBefore = inspectSourceDatabase(options);
  if (!sourceBefore.upgradeEligible || sourceBefore.schemaVersion !== 1) {
    throw new Error('真实源库未通过只读审计，拒绝 dry-run');
  }
  const verified = await verifyUpgradeBackup(options);
  if (verified.manifest.sourceSchemaVersion !== 1) throw new Error('B7-A dry-run 只接受 schema v1 备份');
  const backupDirectory = resolveBackupRunDirectory(paths.backupDirectory, options.backupId);
  const backupDatabasePath = path.join(backupDirectory, 'offerflow-v1.sqlite3');
  const backupHashBefore = sha256Hex(fs.readFileSync(backupDatabasePath));
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-job-memory-v2-upgrade-'));
  const clonePath = path.join(tempDirectory, 'working-clone.sqlite3');
  assertDistinctDatabasePaths(paths.sourceDatabasePath, clonePath);
  assertDistinctDatabasePaths(backupDatabasePath, clonePath);
  let partial: Omit<UpgradeDryRunReport, 'sourceUnchanged' | 'backupDatabaseUnchanged' | 'formalSnapshotUnchanged' | 'disposableCloneRemoved'> | null = null;
  try {
    fs.copyFileSync(backupDatabasePath, clonePath, fs.constants.COPYFILE_EXCL);
    const db = openDb(clonePath);
    try {
      const jobsBefore = readTable(db, 'jobs');
      const profilesBefore = readTable(db, 'profiles');
      const importLogsBefore = readOriginalImportLogs(db);
      initSchema(db, { targetVersion: 2 });
      if (getDatabaseSchemaVersion(db) !== 2) throw new Error('working clone migration 未到 schema v2');
      const firstRun = runLegacyBackfill(db);
      const secondRun = runLegacyBackfill(db);
      const jobsAfter = readTable(db, 'jobs');
      const profilesAfter = readTable(db, 'profiles');
      const importLogsAfter = readOriginalImportLogs(db);
      const health = databaseHealth(db);
      if (health.integrity[0] !== 'ok' || health.foreignKeyViolationCount !== 0) {
        throw new Error('dry-run clone 未通过 integrity/FK');
      }
      const snapshotV2 = runSnapshotV2Roundtrip({
        databasePath: clonePath,
        snapshotDirectory: path.join(tempDirectory, 'snapshot-v2'),
        workingDirectory: tempDirectory,
        workspaceDirectory: paths.workspaceDirectory,
        schemaTarget: 2,
        capability: 'job-memory-v2',
        mode: 'temporary_clone',
      });
      if (
        !snapshotV2.exportImportOk
        || !snapshotV2.consistencyOk
        || !snapshotV2.activeResumePointerPreserved
        || !snapshotV2.eventPayloadPreserved
      ) throw new Error('snapshot v2 roundtrip 未通过');
      partial = {
        toolVersion: 'b7-a-v1',
        backupId: options.backupId,
        sourceSchemaVersion: 1,
        targetSchemaVersion: 2,
        sourceTableCounts: verified.manifest.tableCounts,
        classifications: firstRun.classifications,
        legacyStatusCounts: firstRun.byLegacyStatus,
        wouldCreateApplications: firstRun.createdApplications,
        wouldCreateLegacySeeds: firstRun.createdEvents,
        skipCount: firstRun.actions.skip,
        manualReviewCount: firstRun.actions.manualReview,
        projectionHealth: projectionHealth(db),
        secondRun: {
          createdApplications: secondRun.createdApplications,
          createdEvents: secondRun.createdEvents,
          auditLogCreated: secondRun.auditLogCreated,
        },
        jobHashChangeCount: changedRows(jobsBefore, jobsAfter),
        profileRowsUnchanged: changedRows(profilesBefore, profilesAfter) === 0,
        originalImportLogRowsUnchanged: changedRows(importLogsBefore, importLogsAfter) === 0,
        ...health,
        snapshotV2,
      };
    } finally {
      db.close();
    }
  } finally {
    if (!isPathInside(os.tmpdir(), tempDirectory)) {
      throw new Error('拒绝清理系统临时目录之外的工作副本');
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
  if (partial === null) throw new Error('dry-run 未生成报告');
  const sourceAfter = inspectSourceDatabase(options);
  const sourceUnchanged = inspectionFingerprint(sourceBefore) === inspectionFingerprint(sourceAfter)
    && sourceBefore.sourceFile.sha256 === sourceAfter.sourceFile.sha256;
  const formalSnapshotUnchanged = snapshotFileFingerprint(sourceBefore) === snapshotFileFingerprint(sourceAfter);
  const backupDatabaseUnchanged = backupHashBefore === sha256Hex(fs.readFileSync(backupDatabasePath));
  if (!sourceUnchanged || !formalSnapshotUnchanged || !backupDatabaseUnchanged) {
    throw new Error('B7-A dry-run 检测到源库、正式 snapshot 或备份发生变化');
  }
  const report: UpgradeDryRunReport = {
    ...partial,
    sourceUnchanged,
    backupDatabaseUnchanged,
    formalSnapshotUnchanged,
    disposableCloneRemoved: !fs.existsSync(tempDirectory),
  };
  atomicWriteJson(path.join(backupDirectory, 'dry-run-report.json'), report);
  return report;
}
