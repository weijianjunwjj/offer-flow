import { pathToFileURL } from 'node:url';
import {
  createUpgradeBackup,
  createPostUpgradeBackup,
  inspectSourceDatabase,
  runApprovedRealApply,
  runUpgradeDryRun,
  verifyRealUpgradeDatabase,
  verifyUpgradeBackup,
  assertRealApplyAuthorization,
  readApplyResult,
  type RealApplyAuthorization,
  type UpgradePathsInput,
} from '../server/job-memory/upgrade';
import { auditSnapshotConsistency } from '../server/sync/consistency';

type UpgradeMode =
  | 'inspect'
  | 'backup'
  | 'verify-backup'
  | 'dry-run'
  | 'apply-real'
  | 'verify-real'
  | 'backup-post-real';

interface CliOptions extends UpgradePathsInput {
  mode: UpgradeMode;
  backupId?: string;
  confirmBackupId?: string;
  expectedSourceFingerprint?: string;
  expectedBackupHash?: string;
  approvalToken?: string;
}

const ALLOWED_MODES = new Set<UpgradeMode>([
  'inspect', 'backup', 'verify-backup', 'dry-run', 'apply-real', 'verify-real', 'backup-post-real',
]);
const VALUE_FLAGS = new Set([
  '--source', '--backup-dir', '--workspace', '--backup-id', '--confirm-backup-id',
  '--expected-source-fingerprint', '--expected-backup-hash', '--approval-token',
]);

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) throw new Error(`缺少必填参数 ${flag}`);
  return value;
}

export function parseUpgradeCliArgs(args: readonly string[]): CliOptions {
  const mode = args[0];
  if (typeof mode !== 'string' || !ALLOWED_MODES.has(mode as UpgradeMode)) {
    throw new Error('仅支持受控的 inspect、backup、verify-backup、dry-run、apply-real、verify-real、backup-post-real');
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !VALUE_FLAGS.has(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(`不支持或缺少参数值：${flag ?? '<empty>'}`);
    }
    if (values.has(flag)) throw new Error(`参数不得重复：${flag}`);
    values.set(flag, value);
  }
  const options: CliOptions = {
    mode: mode as UpgradeMode,
    sourceDatabasePath: required(values, '--source'),
    backupDirectory: required(values, '--backup-dir'),
    workspaceDirectory: required(values, '--workspace'),
    backupId: values.get('--backup-id'),
    confirmBackupId: values.get('--confirm-backup-id'),
    expectedSourceFingerprint: values.get('--expected-source-fingerprint'),
    expectedBackupHash: values.get('--expected-backup-hash'),
    approvalToken: values.get('--approval-token'),
  };
  if ((options.mode === 'verify-backup' || options.mode === 'dry-run') && !options.backupId) {
    throw new Error(`${options.mode} 必须显式传入 --backup-id`);
  }
  if (['apply-real', 'verify-real', 'backup-post-real'].includes(options.mode)) {
    for (const flag of [
      '--backup-id', '--confirm-backup-id', '--expected-source-fingerprint',
      '--expected-backup-hash', '--approval-token',
    ]) required(values, flag);
  }
  return options;
}

function realAuthorization(options: CliOptions): RealApplyAuthorization {
  const authorization: RealApplyAuthorization = {
    sourceDatabasePath: options.sourceDatabasePath,
    backupDirectory: options.backupDirectory,
    workspaceDirectory: options.workspaceDirectory,
    backupId: options.backupId as string,
    confirmBackupId: options.confirmBackupId as string,
    expectedSourceFingerprint: options.expectedSourceFingerprint as string,
    expectedBackupHash: options.expectedBackupHash as string,
    approvalToken: options.approvalToken as string,
  };
  assertRealApplyAuthorization(authorization);
  return authorization;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runUpgradeCli(args: readonly string[]): Promise<void> {
  const options = parseUpgradeCliArgs(args);
  const paths = {
    sourceDatabasePath: options.sourceDatabasePath,
    backupDirectory: options.backupDirectory,
    workspaceDirectory: options.workspaceDirectory,
  };
  if (options.mode === 'inspect') {
    const report = inspectSourceDatabase(paths);
    print({
      mode: 'inspect',
      schemaVersion: report.schemaVersion,
      appMetaSchemaVersion: report.appMetaSchemaVersion,
      migrationConsistent: report.migrationConsistent,
      integrity: report.integrity,
      foreignKeyViolationCount: report.foreignKeyViolationCount,
      journalMode: report.journalMode,
      walPresent: report.walPresent,
      shmPresent: report.shmPresent,
      tableCounts: report.tableCounts,
      jobValidation: {
        parseErrorCount: report.jobValidation.parseErrorCount,
        schemaErrorCount: report.jobValidation.schemaErrorCount,
        unknownFieldCount: report.jobValidation.unknownFieldCount,
      },
      legacyStatusCounts: report.legacyStatusCounts,
      v2TablesPresent: report.v2TablesPresent,
      snapshotV1: {
        snapshotPresent: report.snapshotV1.snapshotPresent,
        manifestPresent: report.snapshotV1.manifestPresent,
        schemaVersion: report.snapshotV1.schemaVersion,
        hashValid: report.snapshotV1.hashValid,
        consistencyOk: report.snapshotV1.consistencyOk,
        differenceCounts: report.snapshotV1.differenceCounts,
      },
      sourceFile: {
        sizeBytes: report.sourceFile.sizeBytes,
        shortHash: report.sourceFile.sha256.slice(0, 12),
      },
      upgradeEligible: report.upgradeEligible,
    });
    if (!report.upgradeEligible) process.exitCode = 2;
    return;
  }
  if (options.mode === 'backup') {
    const result = await createUpgradeBackup(paths);
    print({
      mode: 'backup',
      backupId: result.backupId,
      relativeLocation: `backups/job-memory-v2/${result.backupId}`,
      databaseSizeBytes: result.manifest.database.sizeBytes,
      databaseShortHash: result.manifest.database.sha256.slice(0, 12),
      manifest: true,
      snapshotV1Files: result.manifest.snapshotV1.files.length,
      overwrittenExistingBackup: false,
    });
    return;
  }
  const backupId = options.backupId as string;
  if (options.mode === 'verify-backup') {
    const result = await verifyUpgradeBackup({ ...paths, backupId });
    print({
      mode: 'verify-backup',
      backupId,
      ok: result.ok,
      databaseSizeBytes: result.databaseSizeBytes,
      databaseShortHash: result.databaseHash.slice(0, 12),
      integrity: result.integrity,
      foreignKeyViolationCount: result.foreignKeyViolationCount,
      snapshotFilesVerified: result.snapshotFilesVerified,
    });
    return;
  }
  if (options.mode === 'apply-real') {
    const result = await runApprovedRealApply(realAuthorization(options));
    print({
      resultCode: result.resultCode,
      approvedBackupId: result.approvedBackupId,
      preApplyCheckpointId: result.preApplyCheckpointId,
      applyGitCommit: result.applyGitCommit,
      schema: result.verification.schemaVersion,
      applications: result.verification.tableCounts.applications,
      feedbackEvents: result.verification.tableCounts.feedbackEvents,
      resumeVersions: result.verification.tableCounts.resumeVersions,
      skip: result.verification.skipCount,
      manualReview: result.verification.manualReviewCount,
      projection: result.verification.projection,
      secondRun: result.verification.secondRun,
      jobHashChanges: result.verification.jobHashChanges,
      snapshotSchema: result.snapshot.schemaVersion,
      snapshotConsistency: result.snapshot.consistency,
      snapshotRoundtrip: result.snapshot.roundtrip,
      approvedBackupUnchanged: result.approvedBackupUnchanged,
    });
    return;
  }
  if (options.mode === 'verify-real') {
    const authorization = realAuthorization(options);
    const approved = await verifyUpgradeBackup(authorization);
    const apply = readApplyResult(authorization.backupDirectory);
    const report = verifyRealUpgradeDatabase(authorization.sourceDatabasePath, approved.manifest);
    const snapshot = auditSnapshotConsistency(authorization.sourceDatabasePath);
    print({
      mode: 'verify-real',
      resultCode: apply.resultCode,
      schemaVersion: report.schemaVersion,
      migrationContinuous: report.migrationContinuous,
      integrity: report.integrity,
      foreignKeyViolationCount: report.foreignKeyViolationCount,
      tableCounts: report.tableCounts,
      projection: report.projection,
      skip: report.skipCount,
      manualReview: report.manualReviewCount,
      secondRun: report.secondRun,
      jobHashChanges: report.jobHashChanges,
      legacyFieldChanges: report.legacyFieldChanges,
      snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
      snapshotConsistency: snapshot.ok,
    });
    return;
  }
  if (options.mode === 'backup-post-real') {
    const result = await createPostUpgradeBackup(realAuthorization(options));
    print({
      mode: 'backup-post-real',
      backupId: result.backupId,
      relativeLocation: result.relativeLocation,
      databaseSizeBytes: result.databaseSizeBytes,
      databaseShortHash: result.databaseShortHash,
      snapshotFilesVerified: result.snapshotFilesVerified,
      overwrittenExistingBackup: false,
    });
    return;
  }
  const report = await runUpgradeDryRun({ ...paths, backupId });
  print({ mode: 'dry-run', ...report });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUpgradeCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
