import { pathToFileURL } from 'node:url';
import {
  createCurrentBaselineBackup,
  publishCurrentProductionSnapshot,
  verifyCurrentBaselineBackupMatchesSource,
  verifyCurrentProductionDatabase,
} from '../server/job-memory/production';
import { verifyUpgradeAttestation } from '../server/job-memory/upgrade';

type Mode = 'verify-real' | 'verify-upgrade-attestation' | 'backup-current' | 'publish-snapshot';

interface CliOptions {
  mode: Mode;
  sourceDatabasePath: string;
  backupDirectory: string;
  workspaceDirectory: string;
  backupId?: string;
  confirmBackupId?: string;
}

const MODES = new Set<Mode>([
  'verify-real',
  'verify-upgrade-attestation',
  'backup-current',
  'publish-snapshot',
]);
const FLAGS = new Set([
  '--source', '--backup-dir', '--workspace', '--backup-id', '--confirm-backup-id',
]);

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) throw new Error(`缺少必填参数 ${flag}`);
  return value;
}

export function parseProductionCliArgs(args: readonly string[]): CliOptions {
  const mode = args[0];
  if (typeof mode !== 'string' || !MODES.has(mode as Mode)) {
    throw new Error('仅支持 verify-real、verify-upgrade-attestation、backup-current、publish-snapshot');
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !FLAGS.has(flag) || value.startsWith('--')) {
      throw new Error(`不支持或缺少参数值：${flag ?? '<empty>'}`);
    }
    if (values.has(flag)) throw new Error(`参数不得重复：${flag}`);
    values.set(flag, value);
  }
  const options: CliOptions = {
    mode: mode as Mode,
    sourceDatabasePath: required(values, '--source'),
    backupDirectory: required(values, '--backup-dir'),
    workspaceDirectory: required(values, '--workspace'),
    backupId: values.get('--backup-id'),
    confirmBackupId: values.get('--confirm-backup-id'),
  };
  if (options.mode === 'publish-snapshot') {
    if (!options.backupId || !options.confirmBackupId) {
      throw new Error('publish-snapshot 必须显式传入 --backup-id 与 --confirm-backup-id');
    }
    if (options.backupId !== options.confirmBackupId) {
      throw new Error('publish-snapshot 的两次 Backup ID 确认不一致');
    }
  }
  return options;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runProductionCli(args: readonly string[]): Promise<void> {
  const options = parseProductionCliArgs(args);
  const paths = {
    sourceDatabasePath: options.sourceDatabasePath,
    backupDirectory: options.backupDirectory,
    workspaceDirectory: options.workspaceDirectory,
  };
  if (options.mode === 'verify-real') {
    const report = verifyCurrentProductionDatabase(options.sourceDatabasePath);
    print({
      mode: options.mode,
      schemaVersion: report.schemaVersion,
      migrationContinuous: report.migrationContinuous,
      integrity: report.integrity,
      foreignKeyViolationCount: report.foreignKeyViolationCount,
      tableCounts: report.tableCounts,
      projection: report.projection,
      activeResumePointer: report.activeResumePointer,
      invariantViolations: {
        orphanReferences: report.orphanReferenceCount,
        invalidEventTargets: report.invalidEventTargetCount,
        invalidApplicationReplacements: report.invalidApplicationReplacementCount,
        invalidRowVersions: report.invalidRowVersionCount,
        idempotencyConflicts: report.idempotencyConflictCount,
        duplicateLegacySeeds: report.duplicateLegacySeedCount,
        unexpectedMigrationEvents: report.unexpectedMigrationEventCount,
        invalidApplicationAudits: report.invalidApplicationAuditCount,
      },
      snapshotSchemaVersion: report.snapshotSchemaVersion,
      snapshotDifferenceCount: report.snapshotDifferenceCount,
      snapshotConsistent: report.snapshotConsistent,
      normalizedFingerprintShort: report.normalizedFingerprintShort,
      normalizedFingerprintUnchanged: report.normalizedFingerprintUnchanged,
      verifierBusinessWrites: report.verifierBusinessWrites,
    });
    return;
  }
  if (options.mode === 'verify-upgrade-attestation') {
    const report = await verifyUpgradeAttestation(paths);
    print({ mode: options.mode, ...report });
    return;
  }
  if (options.mode === 'backup-current') {
    const report = await createCurrentBaselineBackup({
      ...paths,
      backupId: options.backupId,
    });
    print({ mode: options.mode, ...report });
    return;
  }
  const backupId = options.backupId as string;
  verifyCurrentBaselineBackupMatchesSource(
    options.backupDirectory,
    backupId,
    options.sourceDatabasePath,
  );
  const report = publishCurrentProductionSnapshot({
    databasePath: options.sourceDatabasePath,
    workspaceDirectory: options.workspaceDirectory,
  });
  print({ mode: options.mode, approvedBackupId: backupId, ...report });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
