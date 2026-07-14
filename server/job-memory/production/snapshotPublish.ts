import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditSnapshotV2Consistency,
  importSnapshotV2,
  runSnapshotV2Roundtrip,
} from '../../snapshot/v2';
import { auditSnapshotConsistency } from '../../sync/consistency';
import {
  exportSnapshotToDirectory,
  publishSnapshotPairAtomically,
} from '../../sync/exportSnapshot';
import { getSyncPaths } from '../../sync/paths';
import type { SyncTableName } from '../../sync/types';
import { assertNoSymbolicLinks, isPathInside } from '../upgrade/pathSafety';
import {
  captureCurrentProductionState,
  verifyCurrentProductionDatabase,
  type CurrentProductionCounts,
} from './currentVerification';

export interface PublishCurrentSnapshotOptions {
  databasePath: string;
  workspaceDirectory: string;
  snapshotDirectory?: string;
  deviceId?: string;
  failAfterSnapshotReplace?: boolean;
}

export interface CurrentSnapshotPublishReport {
  schemaVersion: 2;
  tableCounts: CurrentProductionCounts;
  stagingConsistency: true;
  roundtrip: true;
  activeResumePointerPreserved: true;
  eventPayloadPreserved: true;
  projectionPersisted: false;
  atomicPublish: true;
  formalDifferenceCount: 0;
  sourceFingerprintUnchanged: true;
}

function toProductionCounts(
  counts: Partial<Record<SyncTableName, number>>,
): CurrentProductionCounts {
  return {
    profiles: counts.profiles ?? 0,
    jobs: counts.jobs ?? 0,
    resumeVersions: counts.resume_versions ?? 0,
    applications: counts.applications ?? 0,
    feedbackEvents: counts.feedback_events ?? 0,
    importLogs: counts.import_logs ?? 0,
    appMeta: counts.app_meta ?? 0,
  };
}

function differenceCount(report: ReturnType<typeof auditSnapshotConsistency>): number {
  return Object.values(report.tables).reduce((sum, table) => (
    sum + table.onlyInDatabase.length + table.onlyInSnapshot.length + table.changed.length
  ), 0);
}

function readExistingDeviceId(databasePath: string): string {
  const devicePath = getSyncPaths(databasePath).deviceIdPath;
  if (!fs.existsSync(devicePath)) throw new Error('正式 Snapshot 发布要求已有 device ID');
  const deviceId = fs.readFileSync(devicePath, 'utf8').trim();
  if (deviceId === '') throw new Error('正式 Snapshot device ID 为空');
  return deviceId;
}

export function publishCurrentProductionSnapshot(
  options: PublishCurrentSnapshotOptions,
): CurrentSnapshotPublishReport {
  const databasePath = path.resolve(options.databasePath);
  const workspaceDirectory = path.resolve(options.workspaceDirectory);
  const targetDirectory = path.resolve(
    options.snapshotDirectory ?? getSyncPaths(databasePath).syncDir,
  );
  assertNoSymbolicLinks(databasePath);
  assertNoSymbolicLinks(targetDirectory);
  const sourceBefore = captureCurrentProductionState(databasePath);
  verifyCurrentProductionDatabase(databasePath, { requireSnapshotConsistency: false });
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-r01-snapshot-'));
  try {
    const stagingDirectory = path.join(workingDirectory, 'staging');
    const staged = exportSnapshotToDirectory(
      databasePath,
      stagingDirectory,
      options.deviceId ?? readExistingDeviceId(databasePath),
    );
    if (JSON.stringify(toProductionCounts(staged.tableCounts)) !== JSON.stringify(sourceBefore.tableCounts)) {
      throw new Error('Snapshot staging 聚合与当前生产数据库不一致');
    }

    const importedDatabasePath = path.join(workingDirectory, 'staging-import.sqlite3');
    const context = {
      databasePath: importedDatabasePath,
      snapshotDirectory: stagingDirectory,
      workingDirectory,
      workspaceDirectory,
      schemaTarget: 2 as const,
      capability: 'job-memory-v2' as const,
      mode: 'temporary_clone' as const,
    };
    const imported = importSnapshotV2(context);
    if (imported.integrity[0] !== 'ok' || imported.foreignKeyViolationCount !== 0) {
      throw new Error('Snapshot staging import 未通过 integrity/FK');
    }
    const stagingConsistency = auditSnapshotV2Consistency(context);
    if (!stagingConsistency.ok) throw new Error('Snapshot staging consistency 失败');
    const restored = verifyCurrentProductionDatabase(importedDatabasePath, {
      requireSnapshotConsistency: true,
      snapshotDirectory: stagingDirectory,
    });
    if (JSON.stringify(restored.tableCounts) !== JSON.stringify(sourceBefore.tableCounts)) {
      throw new Error('Snapshot staging restore 聚合与当前生产数据库不一致');
    }
    const roundtrip = runSnapshotV2Roundtrip({
      ...context,
      snapshotDirectory: path.join(workingDirectory, 'roundtrip'),
    });
    if (
      !roundtrip.exportImportOk
      || !roundtrip.consistencyOk
      || !roundtrip.activeResumePointerPreserved
      || !roundtrip.eventPayloadPreserved
      || roundtrip.projectionPersisted
    ) throw new Error('Snapshot staging roundtrip 失败');

    const sourceBeforePublish = captureCurrentProductionState(databasePath);
    if (sourceBeforePublish.normalizedFingerprint !== sourceBefore.normalizedFingerprint) {
      throw new Error('Snapshot staging 期间生产数据库发生变化');
    }
    // Windows rename cannot cross volumes. Keep the fully validated staging in the
    // system temp directory, then copy the pair into a Git-ignored staging directory
    // on the target volume before the atomic rename/rollback sequence.
    fs.mkdirSync(targetDirectory, { recursive: true });
    const publishStagingDirectory = fs.mkdtempSync(path.join(targetDirectory, '.offerflow-publish-'));
    try {
      for (const name of ['offerflow.snapshot.json', 'offerflow.manifest.json'] as const) {
        fs.copyFileSync(
          path.join(stagingDirectory, name),
          path.join(publishStagingDirectory, name),
          fs.constants.COPYFILE_EXCL,
        );
      }
      publishSnapshotPairAtomically(publishStagingDirectory, targetDirectory, {
        failAfterSnapshotReplace: options.failAfterSnapshotReplace,
        validatePublished: () => {
          const current = captureCurrentProductionState(databasePath);
          if (current.normalizedFingerprint !== sourceBefore.normalizedFingerprint) {
            throw new Error('Snapshot 原子发布期间生产数据库发生变化');
          }
          const formal = auditSnapshotConsistency(databasePath, targetDirectory);
          if (!formal.ok || formal.snapshotSchemaVersion !== 2 || differenceCount(formal) !== 0) {
            throw new Error('正式 Snapshot 原子发布后 consistency 失败');
          }
        },
      });
    } finally {
      fs.rmSync(publishStagingDirectory, { recursive: true, force: true });
    }
    const formal = auditSnapshotConsistency(databasePath, targetDirectory);
    const formalDifferenceCount = differenceCount(formal);
    if (!formal.ok || formalDifferenceCount !== 0 || formal.snapshotSchemaVersion !== 2) {
      throw new Error('正式 Snapshot 发布后与生产数据库不一致');
    }
    const sourceAfter = captureCurrentProductionState(databasePath);
    if (sourceAfter.normalizedFingerprint !== sourceBefore.normalizedFingerprint) {
      throw new Error('Snapshot 发布过程改变了生产数据库');
    }
    return {
      schemaVersion: 2,
      tableCounts: sourceBefore.tableCounts,
      stagingConsistency: true,
      roundtrip: true,
      activeResumePointerPreserved: true,
      eventPayloadPreserved: true,
      projectionPersisted: false,
      atomicPublish: true,
      formalDifferenceCount: 0,
      sourceFingerprintUnchanged: true,
    };
  } finally {
    if (!isPathInside(os.tmpdir(), workingDirectory)) {
      throw new Error('拒绝清理系统临时目录之外的 Snapshot staging');
    }
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}
