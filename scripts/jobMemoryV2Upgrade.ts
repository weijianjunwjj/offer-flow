import { pathToFileURL } from 'node:url';
import {
  createUpgradeBackup,
  inspectSourceDatabase,
  runUpgradeDryRun,
  verifyUpgradeBackup,
  type UpgradePathsInput,
} from '../server/job-memory/upgrade';

type UpgradeMode = 'inspect' | 'backup' | 'verify-backup' | 'dry-run';

interface CliOptions extends UpgradePathsInput {
  mode: UpgradeMode;
  backupId?: string;
}

const ALLOWED_MODES = new Set<UpgradeMode>(['inspect', 'backup', 'verify-backup', 'dry-run']);
const VALUE_FLAGS = new Set(['--source', '--backup-dir', '--workspace', '--backup-id']);

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) throw new Error(`缺少必填参数 ${flag}`);
  return value;
}

export function parseUpgradeCliArgs(args: readonly string[]): CliOptions {
  const mode = args[0];
  if (typeof mode !== 'string' || !ALLOWED_MODES.has(mode as UpgradeMode)) {
    throw new Error('B7-A 仅支持 inspect、backup、verify-backup、dry-run');
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
  };
  if ((options.mode === 'verify-backup' || options.mode === 'dry-run') && !options.backupId) {
    throw new Error(`${options.mode} 必须显式传入 --backup-id`);
  }
  return options;
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
  const report = await runUpgradeDryRun({ ...paths, backupId });
  print({ mode: 'dry-run', ...report });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUpgradeCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
