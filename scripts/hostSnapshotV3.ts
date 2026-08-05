import { pathToFileURL } from 'node:url';
import {
  HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
  exportHostSnapshotV3,
  verifyHostSnapshotV3Directory,
} from '../server/snapshot/v3/hostSnapshot';
import {
  NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  bootstrapNovaWingOffline,
} from '../server/snapshot/v3/bootstrap';
import {
  HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
  restoreHostSnapshotV3ToCandidate,
} from '../server/snapshot/v3/restoreCandidate';
import { HostSnapshotV3Error } from '../server/snapshot/v3/errors';

type Command = 'export' | 'verify' | 'restore-candidate' | 'bootstrap' | 'help';

function usage(): string {
  return [
    'Host Snapshot V3（仅离线、显式路径）',
    '  export --database <file> --output <new-dir> --work-dir <dir> --workspace <repo> --confirm EXPORT_HOST_SNAPSHOT_V3_OFFLINE [--dry-run]',
    '  verify --snapshot <dir>',
    '  restore-candidate --snapshot <dir> --candidate <new-file> --work-dir <dir> --workspace <repo> --confirm RESTORE_HOST_SNAPSHOT_V3_TO_NEW_CANDIDATE [--dry-run]',
    '  bootstrap --database <file> --confirm BOOTSTRAP_NOVAWING_SCHEMA_OFFLINE [--dry-run]',
  ].join('\n');
}

function parseArguments(argv: readonly string[]): {
  command: Command;
  values: ReadonlyMap<string, string>;
  dryRun: boolean;
} {
  const command = argv[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    if (argv.length !== 1) throw new Error('help 不接受其它参数');
    return { command: 'help', values: new Map(), dryRun: false };
  }
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
    return { command: 'help', values: new Map(), dryRun: false };
  }
  if (command !== 'export' && command !== 'verify' && command !== 'restore-candidate' && command !== 'bootstrap') {
    throw new Error(usage());
  }
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--dry-run') {
      if (dryRun) throw new Error('参数 --dry-run 不得重复');
      dryRun = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error('只接受具名参数');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || values.has(token)) {
      throw new Error(`参数无值或重复：${token}`);
    }
    values.set(token, value);
    index += 1;
  }
  return { command: command as Command, values, dryRun };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === '') throw new Error(`缺少参数：${key}`);
  return value;
}

function assertExactKeys(values: ReadonlyMap<string, string>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(', ')}`);
  for (const key of expected) required(values, key);
}

export function runHostSnapshotV3Cli(argv: readonly string[]): unknown {
  const parsed = parseArguments(argv);
  switch (parsed.command) {
    case 'help':
      return { usage: usage() };
    case 'export': {
      const keys = ['--database', '--output', '--work-dir', '--workspace', '--confirm'] as const;
      assertExactKeys(parsed.values, keys);
      return exportHostSnapshotV3({
        databasePath: required(parsed.values, '--database'),
        outputDirectory: required(parsed.values, '--output'),
        workingDirectory: required(parsed.values, '--work-dir'),
        workspaceDirectory: required(parsed.values, '--workspace'),
        confirmation: required(parsed.values, '--confirm') as typeof HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
        dryRun: parsed.dryRun,
      });
    }
    case 'verify': {
      assertExactKeys(parsed.values, ['--snapshot']);
      if (parsed.dryRun) throw new Error('verify 不接受 --dry-run');
      return verifyHostSnapshotV3Directory(required(parsed.values, '--snapshot'));
    }
    case 'restore-candidate': {
      const keys = ['--snapshot', '--candidate', '--work-dir', '--workspace', '--confirm'] as const;
      assertExactKeys(parsed.values, keys);
      return restoreHostSnapshotV3ToCandidate({
        snapshotDirectory: required(parsed.values, '--snapshot'),
        candidateDatabasePath: required(parsed.values, '--candidate'),
        workingDirectory: required(parsed.values, '--work-dir'),
        workspaceDirectory: required(parsed.values, '--workspace'),
        confirmation: required(parsed.values, '--confirm') as typeof HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
        dryRun: parsed.dryRun,
      });
    }
    case 'bootstrap': {
      assertExactKeys(parsed.values, ['--database', '--confirm']);
      return bootstrapNovaWingOffline({
        databasePath: required(parsed.values, '--database'),
        confirmation: required(parsed.values, '--confirm') as typeof NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
        dryRun: parsed.dryRun,
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(runHostSnapshotV3Cli(process.argv.slice(2)), null, 2));
  } catch (error) {
    const safe = error instanceof HostSnapshotV3Error
      ? { code: error.code, message: error.message }
      : { code: 'HOST_SNAPSHOT_V3_CLI_INVALID', message: error instanceof Error ? error.message : '命令失败' };
    console.error(JSON.stringify(safe, null, 2));
    process.exitCode = 1;
  }
}
