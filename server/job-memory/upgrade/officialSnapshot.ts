import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db';
import { getDatabaseSchemaVersion } from '../../migrations';
import { initSchema } from '../../schema';
import {
  auditSnapshotV2Consistency,
  importSnapshotV2,
  runSnapshotV2Roundtrip,
  type SnapshotV2RoundtripReport,
} from '../../snapshot/v2';
import { auditSnapshotConsistency } from '../../sync/consistency';
import { exportSnapshot } from '../../sync/exportSnapshot';
import { getSyncPaths } from '../../sync/paths';
import { runLegacyBackfill } from './legacyBackfill';
import { verifyUpgradeBackup, type VerifyUpgradeBackupOptions } from './backup';
import {
  assertDistinctDatabasePaths,
  isPathInside,
  resolveBackupRunDirectory,
  resolveUpgradePaths,
} from './pathSafety';

export interface PreparedSnapshotV2Staging {
  workingDirectory: string;
  snapshotDirectory: string;
  report: SnapshotV2RoundtripReport;
  cleanup(): void;
}

export interface OfficialSnapshotVerification {
  schemaVersion: 2;
  consistency: true;
  roundtrip: true;
  atomicPublish: true;
  tableCounts: SnapshotV2RoundtripReport['tableCounts'];
  activeResumePointerPreserved: true;
  eventPayloadPreserved: true;
  projectionPersisted: false;
}

export function assertOfficialSnapshotCountsMatchStaging(
  expected: SnapshotV2RoundtripReport['tableCounts'],
  actual: SnapshotV2RoundtripReport['tableCounts'],
): void {
  for (const [table, count] of Object.entries(expected)) {
    // 正式库会比预演 clone 多一个 B7-B apply marker；该差异只允许出现在 app_meta。
    if (table === 'app_meta') continue;
    if (actual[table as keyof typeof actual] !== count) {
      throw new Error(`正式 Snapshot v2 表数量与 staging 不一致：${table}`);
    }
  }
}

function assertExpectedSnapshot(report: SnapshotV2RoundtripReport): void {
  if (
    !report.exportImportOk
    || !report.consistencyOk
    || !report.activeResumePointerPreserved
    || !report.eventPayloadPreserved
    || report.projectionPersisted
    || report.tableCounts.profiles !== 1
    || report.tableCounts.jobs !== 13
    || report.tableCounts.resume_versions !== 0
    || report.tableCounts.applications !== 7
    || report.tableCounts.feedback_events !== 7
  ) throw new Error('Snapshot v2 staging 未通过 B7-B 硬断言');
}

export async function prepareSnapshotV2StagingFromApprovedBackup(
  options: VerifyUpgradeBackupOptions,
): Promise<PreparedSnapshotV2Staging> {
  const paths = resolveUpgradePaths(options);
  const verified = await verifyUpgradeBackup(options);
  if (verified.manifest.sourceSchemaVersion !== 1) throw new Error('B7-B staging 只接受批准的 schema v1 备份');
  const backupDirectory = resolveBackupRunDirectory(paths.backupDirectory, options.backupId);
  const backupDatabasePath = path.join(backupDirectory, verified.manifest.database.fileName);
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b7b-snapshot-staging-'));
  const clonePath = path.join(workingDirectory, 'approved-backup-clone.sqlite3');
  const snapshotDirectory = path.join(workingDirectory, 'snapshot-v2-staging');
  assertDistinctDatabasePaths(paths.sourceDatabasePath, clonePath);
  assertDistinctDatabasePaths(backupDatabasePath, clonePath);
  const cleanup = (): void => {
    if (!isPathInside(os.tmpdir(), workingDirectory)) throw new Error('拒绝清理系统临时目录之外的 staging');
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  };
  try {
    fs.copyFileSync(backupDatabasePath, clonePath, fs.constants.COPYFILE_EXCL);
    const db = openDb(clonePath);
    try {
      initSchema(db, { targetVersion: 2 });
      if (getDatabaseSchemaVersion(db) !== 2) throw new Error('staging clone migration 未到 schema v2');
      const first = runLegacyBackfill(db);
      const second = runLegacyBackfill(db);
      if (
        first.createdApplications !== 7
        || first.createdEvents !== 7
        || first.actions.skip !== 6
        || first.actions.manualReview !== 0
        || second.createdApplications !== 0
        || second.createdEvents !== 0
      ) throw new Error('staging clone backfill 聚合与授权不一致');
    } finally {
      db.close();
    }
    const report = runSnapshotV2Roundtrip({
      databasePath: clonePath,
      snapshotDirectory,
      workingDirectory,
      workspaceDirectory: paths.workspaceDirectory,
      schemaTarget: 2,
      capability: 'job-memory-v2',
      mode: 'temporary_clone',
    });
    assertExpectedSnapshot(report);
    return { workingDirectory, snapshotDirectory, report, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function publishAndVerifyOfficialSnapshotV2(
  databasePath: string,
  workspaceDirectory: string,
  expectedStaging: SnapshotV2RoundtripReport,
): OfficialSnapshotVerification {
  assertExpectedSnapshot(expectedStaging);
  const exported = exportSnapshot(databasePath);
  if (exported.tableCounts.applications !== 7 || exported.tableCounts.feedback_events !== 7) {
    throw new Error('正式 Snapshot v2 聚合与 staging 不一致');
  }
  assertOfficialSnapshotCountsMatchStaging(
    expectedStaging.tableCounts,
    exported.tableCounts as SnapshotV2RoundtripReport['tableCounts'],
  );
  const consistency = auditSnapshotConsistency(databasePath);
  if (!consistency.ok || consistency.snapshotSchemaVersion !== 2) {
    throw new Error('正式 Snapshot v2 consistency 失败');
  }

  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b7b-official-roundtrip-'));
  try {
    const snapshotDirectory = path.join(workingDirectory, 'official-snapshot-copy');
    fs.mkdirSync(snapshotDirectory, { recursive: true });
    const formal = getSyncPaths(databasePath);
    for (const name of ['offerflow.snapshot.json', 'offerflow.manifest.json'] as const) {
      fs.copyFileSync(path.join(formal.syncDir, name), path.join(snapshotDirectory, name));
    }
    const importedDatabasePath = path.join(workingDirectory, 'official-import.sqlite3');
    const context = {
      databasePath: importedDatabasePath,
      snapshotDirectory,
      workingDirectory,
      workspaceDirectory,
      schemaTarget: 2 as const,
      capability: 'job-memory-v2' as const,
      mode: 'temporary_clone' as const,
    };
    importSnapshotV2(context);
    const importedConsistency = auditSnapshotV2Consistency(context);
    if (!importedConsistency.ok) throw new Error('正式 Snapshot v2 import consistency 失败');
    const roundtrip = runSnapshotV2Roundtrip({
      ...context,
      snapshotDirectory: path.join(workingDirectory, 'reexported-snapshot'),
    });
    assertExpectedSnapshot(roundtrip);
    return {
      schemaVersion: 2,
      consistency: true,
      roundtrip: true,
      atomicPublish: true,
      tableCounts: roundtrip.tableCounts,
      activeResumePointerPreserved: true,
      eventPayloadPreserved: true,
      projectionPersisted: false,
    };
  } finally {
    if (!isPathInside(os.tmpdir(), workingDirectory)) throw new Error('拒绝清理临时 roundtrip 目录之外的路径');
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}
