import { describe, expect, it } from 'vitest';
import type { ApprovedRealApplyResult } from './realApply';
import type { B7BUpgradeMarker, RealUpgradeVerificationReport } from './realVerification';
import { assertUpgradeAttestationBindings } from './upgradeAttestation';

function marker(): B7BUpgradeMarker {
  return {
    version: 1,
    approvedBackupId: '20260714-102807-b7a-6f0ac3d1',
    applyGitCommit: 'fixture-commit',
    sourceFingerprintShort: '891d4ccc32c0',
    appliedAt: '2026-07-14T03:24:49.000Z',
    createdApplications: 7,
    createdEvents: 7,
    skipCount: 6,
    manualReviewCount: 0,
    projection: { valid: 0, degraded: 7, invalid: 0 },
    secondRun: { createdApplications: 0, createdEvents: 0, auditLogCreated: false },
    jobHashChanges: 0,
  };
}

function verification(upgradeMarker: B7BUpgradeMarker): RealUpgradeVerificationReport {
  return {
    schemaVersion: 2,
    migrationContinuous: true,
    integrity: ['ok'],
    foreignKeyViolationCount: 0,
    tableCounts: {
      profiles: 1,
      jobs: 13,
      originalImportLogs: 1,
      migrationAuditLogs: 1,
      resumeVersions: 0,
      applications: 7,
      feedbackEvents: 7,
    },
    projection: { valid: 0, degraded: 7, invalid: 0 },
    skipCount: 6,
    manualReviewCount: 0,
    secondRun: { createdApplications: 0, createdEvents: 0, auditLogCreated: false },
    jobHashChanges: 0,
    profileHashChanges: 0,
    originalImportLogHashChanges: 0,
    legacyFieldChanges: 0,
    weakLegacySeedCount: 7,
    notContactedApplicationCount: 0,
    pausedWithoutInteractionApplicationCount: 0,
    applicationsWithResumeVersion: 0,
    applicationsWithFabricatedContext: 0,
    nonLegacySeedEventCount: 0,
    activeResumeVersionId: null,
    marker: upgradeMarker,
  };
}

function applyResult(): ApprovedRealApplyResult {
  const upgradeMarker = marker();
  return {
    resultCode: 'B7B_APPLY_SUCCESS',
    applyGitCommit: upgradeMarker.applyGitCommit,
    approvedBackupId: upgradeMarker.approvedBackupId,
    preApplyCheckpointId: '20260714-112449-b7a-8d54a08b',
    verification: verification(upgradeMarker),
    snapshot: {
      schemaVersion: 2,
      consistency: true,
      roundtrip: true,
      atomicPublish: true,
      tableCounts: {
        profiles: 1,
        jobs: 13,
        resume_versions: 0,
        applications: 7,
        feedback_events: 7,
        import_logs: 2,
        app_meta: 2,
      },
      activeResumePointerPreserved: true,
      eventPayloadPreserved: true,
      projectionPersisted: false,
    },
    approvedBackupUnchanged: true,
  };
}

function input() {
  const apply = applyResult();
  return {
    apply,
    approvedBackupId: apply.approvedBackupId,
    approvedBackupHash: 'ba0d599568ad0000000000000000000000000000000000000000000000000000',
    approvedSourceFingerprint: '891d4ccc32c00000000000000000000000000000000000000000000000000000',
    checkpointBackupId: apply.preApplyCheckpointId,
    checkpointSourceHash: 'same-source-hash',
    approvedSourceHash: 'same-source-hash',
    currentMarker: apply.verification.marker,
  };
}

describe('B7-B 历史升级证明', () => {
  it('历史 apply-result、Backup 绑定和固定升级聚合正确时通过', () => {
    expect(() => assertUpgradeAttestationBindings(input())).not.toThrow();
  });

  it('当前生产数据增长不参与历史证明，不要求回退至旧表数量', () => {
    const bindings = input();
    expect(bindings).not.toHaveProperty('currentTableCounts');
    expect(() => assertUpgradeAttestationBindings(bindings)).not.toThrow();
  });

  it('apply-result 被篡改时失败', () => {
    const bindings = input();
    bindings.apply.approvedBackupId = '20260714-000000-b7a-deadbeef';
    expect(() => assertUpgradeAttestationBindings(bindings)).toThrow('apply-result');
  });

  it('历史批准备份哈希或 checkpoint 源哈希错误时失败', () => {
    expect(() => assertUpgradeAttestationBindings({
      ...input(),
      approvedBackupHash: 'bad-history-hash',
    })).toThrow('历史备份哈希');
    expect(() => assertUpgradeAttestationBindings({
      ...input(),
      checkpointSourceHash: 'tampered-checkpoint-source',
    })).toThrow('历史备份哈希');
  });
});
