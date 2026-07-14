import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyUpgradeBackup } from './backup';
import { verifyPostUpgradeBackup } from './postUpgradeBackup';
import {
  B7B_APPROVED_BACKUP_ID,
  B7B_EXPECTED_BACKUP_HASH,
  B7B_EXPECTED_SOURCE_FINGERPRINT,
  B7B_POST_UPGRADE_BACKUP_ID,
  B7B_PRE_APPLY_CHECKPOINT_ID,
  getB7BStatePaths,
  readApplyResult,
  type ApprovedRealApplyResult,
} from './realApply';
import {
  assertExpectedRealUpgrade,
  readB7BUpgradeMarker,
  type B7BUpgradeMarker,
} from './realVerification';
import type { UpgradePathsInput } from './pathSafety';

export interface UpgradeAttestationBindingInput {
  apply: ApprovedRealApplyResult;
  approvedBackupId: string;
  approvedBackupHash: string;
  approvedSourceFingerprint: string;
  checkpointBackupId: string;
  checkpointSourceHash: string;
  approvedSourceHash: string;
  currentMarker: B7BUpgradeMarker;
}

export interface UpgradeAttestationReport {
  status: 'B7B_UPGRADE_ATTESTED';
  approvedBackupId: string;
  preApplyCheckpointId: string;
  postUpgradeBackupId: string;
  applyResultVerified: true;
  approvedBackupVerified: true;
  checkpointBackupVerified: true;
  postUpgradeBackupVerified: true;
  historicalCounts: {
    jobs: 13;
    resumeVersions: 0;
    applications: 7;
    feedbackEvents: 7;
  };
  historicalFingerprintVerified: true;
  currentDatabaseGrowthAllowed: true;
}

export function assertUpgradeAttestationBindings(input: UpgradeAttestationBindingInput): void {
  const { apply } = input;
  assertExpectedRealUpgrade(apply.verification);
  if (
    input.approvedBackupId !== B7B_APPROVED_BACKUP_ID
    || input.checkpointBackupId !== B7B_PRE_APPLY_CHECKPOINT_ID
    || apply.resultCode !== 'B7B_APPLY_SUCCESS'
    || apply.approvedBackupId !== input.approvedBackupId
    || apply.preApplyCheckpointId !== input.checkpointBackupId
    || !apply.approvedBackupUnchanged
  ) throw new Error('B7-B apply-result 的 Backup 绑定无效');
  if (
    input.approvedBackupHash.slice(0, 12) !== B7B_EXPECTED_BACKUP_HASH
    || input.approvedSourceFingerprint.slice(0, 12) !== B7B_EXPECTED_SOURCE_FINGERPRINT
    || input.checkpointSourceHash !== input.approvedSourceHash
  ) throw new Error('B7-B 历史备份哈希或源指纹不一致');
  if (
    apply.snapshot.schemaVersion !== 2
    || !apply.snapshot.consistency
    || !apply.snapshot.roundtrip
    || !apply.snapshot.atomicPublish
    || apply.snapshot.tableCounts.jobs !== 13
    || apply.snapshot.tableCounts.resume_versions !== 0
    || apply.snapshot.tableCounts.applications !== 7
    || apply.snapshot.tableCounts.feedback_events !== 7
  ) throw new Error('B7-B 历史 Snapshot apply-result 无效');
  if (JSON.stringify(input.currentMarker) !== JSON.stringify(apply.verification.marker)) {
    throw new Error('B7-B 当前升级标记与历史 apply-result 不一致');
  }
}

export async function verifyUpgradeAttestation(
  input: UpgradePathsInput,
): Promise<UpgradeAttestationReport> {
  const approved = await verifyUpgradeBackup({
    ...input,
    backupId: B7B_APPROVED_BACKUP_ID,
  });
  const checkpoint = await verifyUpgradeBackup({
    ...input,
    backupId: B7B_PRE_APPLY_CHECKPOINT_ID,
  });
  const postUpgrade = verifyPostUpgradeBackup(
    input.backupDirectory,
    B7B_POST_UPGRADE_BACKUP_ID,
  );
  const apply = readApplyResult(input.backupDirectory);
  const db = new Database(input.sourceDatabasePath, { readonly: true, fileMustExist: true });
  let currentMarker: B7BUpgradeMarker;
  try {
    db.pragma('query_only = ON');
    currentMarker = readB7BUpgradeMarker(db);
  } finally {
    db.close();
  }
  assertUpgradeAttestationBindings({
    apply,
    approvedBackupId: approved.backupId,
    approvedBackupHash: approved.databaseHash,
    approvedSourceFingerprint: approved.manifest.sourceDatabase.sha256,
    checkpointBackupId: checkpoint.backupId,
    checkpointSourceHash: checkpoint.manifest.sourceDatabase.sha256,
    approvedSourceHash: approved.manifest.sourceDatabase.sha256,
    currentMarker,
  });
  if (!postUpgrade.applyResultVerified) throw new Error('B7-B 升级后备份未绑定 apply-result');
  const failurePath = getB7BStatePaths(path.resolve(input.backupDirectory)).failure;
  const failure = JSON.parse(fs.readFileSync(failurePath, 'utf8')) as {
    stage?: unknown;
    resolved?: unknown;
    approvedBackupId?: unknown;
  };
  if (
    failure.stage !== 'snapshot-publish'
    || failure.resolved !== true
    || failure.approvedBackupId !== B7B_APPROVED_BACKUP_ID
  ) throw new Error('B7-B 历史 Snapshot failure/resume 证明无效');
  return {
    status: 'B7B_UPGRADE_ATTESTED',
    approvedBackupId: B7B_APPROVED_BACKUP_ID,
    preApplyCheckpointId: B7B_PRE_APPLY_CHECKPOINT_ID,
    postUpgradeBackupId: B7B_POST_UPGRADE_BACKUP_ID,
    applyResultVerified: true,
    approvedBackupVerified: true,
    checkpointBackupVerified: true,
    postUpgradeBackupVerified: true,
    historicalCounts: {
      jobs: 13,
      resumeVersions: 0,
      applications: 7,
      feedbackEvents: 7,
    },
    historicalFingerprintVerified: true,
    currentDatabaseGrowthAllowed: true,
  };
}
