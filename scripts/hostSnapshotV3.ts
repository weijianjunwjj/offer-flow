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

export const HOST_SNAPSHOT_V3_CLI_LIMITS = Object.freeze({
  maxArgumentCount: 32,
  maxArgumentLength: 4_096,
  maxTotalLength: 16_384,
});

const COMMAND_OPTIONS = Object.freeze({
  export: {
    values: ['--database', '--output', '--work-dir', '--workspace', '--confirm'],
    dryRun: true,
  },
  verify: { values: ['--snapshot'], dryRun: false },
  'restore-candidate': {
    values: ['--snapshot', '--candidate', '--work-dir', '--workspace', '--confirm'],
    dryRun: true,
  },
  bootstrap: { values: ['--database', '--confirm'], dryRun: true },
} as const);

export interface ParsedHostSnapshotV3Arguments {
  command: Command;
  values: ReadonlyMap<string, string>;
  dryRun: boolean;
}

function usage(): string {
  return [
    'Host Snapshot V3（仅离线、显式路径）',
    '  export --database <file> --output <new-dir> --work-dir <dir> --workspace <repo> --confirm EXPORT_HOST_SNAPSHOT_V3_OFFLINE [--dry-run]',
    '  verify --snapshot <dir>',
    '  restore-candidate --snapshot <dir> --candidate <new-file> --work-dir <dir> --workspace <repo> --confirm RESTORE_HOST_SNAPSHOT_V3_TO_NEW_CANDIDATE [--dry-run]',
    '  bootstrap --database <file> --confirm BOOTSTRAP_NOVAWING_SCHEMA_OFFLINE [--dry-run]',
    '',
    '所有路径必须是调用方提供的 Windows 本地绝对路径；不读取环境变量或 cwd 默认值。',
    '输出的直接父目录必须已存在，命令不会自动创建调用方指定的父目录。',
  ].join('\n');
}

function cliError(code: 'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID' | 'HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED', message: string): never {
  throw new HostSnapshotV3Error(code, message);
}

function assertArgumentLimits(argv: readonly string[]): void {
  if (argv.length > HOST_SNAPSHOT_V3_CLI_LIMITS.maxArgumentCount) {
    cliError('HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED', 'CLI 参数数量超过安全上限');
  }
  let totalLength = 0;
  for (const argument of argv) {
    if (argument.length > HOST_SNAPSHOT_V3_CLI_LIMITS.maxArgumentLength) {
      cliError('HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED', 'CLI 单参数长度超过安全上限');
    }
    if (/[\u0000-\u001f\u007f]/u.test(argument)) {
      cliError('HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID', 'CLI 参数包含危险控制字符');
    }
    totalLength += argument.length;
  }
  if (totalLength > HOST_SNAPSHOT_V3_CLI_LIMITS.maxTotalLength) {
    cliError('HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED', 'CLI 参数总长度超过安全上限');
  }
}

function invalidPosition(position: number): never {
  cliError('HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID', `CLI 参数格式非法（位置 ${position}）`);
}

export function parseHostSnapshotV3Arguments(argv: readonly string[]): ParsedHostSnapshotV3Arguments {
  assertArgumentLimits(argv);
  if (argv.length === 0) return { command: 'help', values: new Map(), dryRun: false };
  const command = argv[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    if (argv.length !== 1) invalidPosition(1);
    return { command: 'help', values: new Map(), dryRun: false };
  }
  if (!(command in COMMAND_OPTIONS)) invalidPosition(0);
  const knownCommand = command as keyof typeof COMMAND_OPTIONS;
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
    return { command: 'help', values: new Map(), dryRun: false };
  }
  const definition = COMMAND_OPTIONS[knownCommand];
  const allowed = new Set<string>(definition.values);
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--dry-run') {
      if (!definition.dryRun || dryRun) invalidPosition(index);
      dryRun = true;
      continue;
    }
    if (token.startsWith('--dry-run=')) invalidPosition(index);
    if (!allowed.has(token) || values.has(token)) invalidPosition(index);
    const value = argv[index + 1];
    if (value === undefined || allowed.has(value) || value === '--dry-run' || value === '--help' || value === '-h') {
      invalidPosition(index);
    }
    values.set(token, value);
    index += 1;
  }
  if (values.size !== definition.values.length) invalidPosition(argv.length);
  return { command: knownCommand, values, dryRun };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === '') {
    throw new HostSnapshotV3Error('HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID', 'CLI 缺少必需参数值');
  }
  return value;
}

export function runHostSnapshotV3Cli(argv: readonly string[]): unknown {
  const parsed = parseHostSnapshotV3Arguments(argv);
  switch (parsed.command) {
    case 'help':
      return { usage: usage() };
    case 'export': {
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
      return verifyHostSnapshotV3Directory(required(parsed.values, '--snapshot'));
    }
    case 'restore-candidate': {
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
      : { code: 'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID', message: '命令失败' };
    console.error(JSON.stringify(safe, null, 2));
    process.exitCode = 1;
  }
}
