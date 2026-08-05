import { describe, expect, it } from 'vitest';
import {
  HOST_SNAPSHOT_V3_CLI_LIMITS,
  parseHostSnapshotV3Arguments,
  runHostSnapshotV3Cli,
} from './hostSnapshotV3';

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

describe('Host Snapshot V3 CLI parser', () => {
  it('无参数和四种合法 help 语义成功', () => {
    expect(parseHostSnapshotV3Arguments([]).command).toBe('help');
    for (const argv of [['help'], ['--help'], ['-h'], ['verify', '--help']] as const) {
      expect(parseHostSnapshotV3Arguments(argv).command).toBe('help');
    }
  });

  it('非法命令加 --help 仍拒绝', () => {
    expectCode(
      () => parseHostSnapshotV3Arguments(['unknown-command', '--help']),
      'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID',
    );
  });

  it('未知参数只报告位置，不回显原文', () => {
    const secret = '--token-with-secret-value';
    try {
      parseHostSnapshotV3Arguments(['verify', '--snapshot', 'C:\\safe', secret, 'payload']);
      throw new Error('expected parser failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID' });
      expect(String((error as Error).message)).not.toContain(secret);
      expect(String((error as Error).message)).not.toContain('payload');
      expect(String((error as Error).message)).toContain('位置 3');
    }
  });

  it('拒绝重复参数、缺失值、多余位置参数和非法布尔值', () => {
    const invalidCases = [
      ['verify', '--snapshot', 'C:\\safe', '--snapshot', 'C:\\safe'],
      ['verify', '--snapshot'],
      ['verify', '--snapshot', 'C:\\safe', 'extra'],
      ['export', '--dry-run=maybe'],
    ] as const;
    for (const argv of invalidCases) {
      expectCode(() => parseHostSnapshotV3Arguments(argv), 'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID');
    }
  });

  it('限制 argv 数量、单参数长度和总长度', () => {
    expectCode(
      () => parseHostSnapshotV3Arguments(Array.from(
        { length: HOST_SNAPSHOT_V3_CLI_LIMITS.maxArgumentCount + 1 },
        () => 'x',
      )),
      'HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED',
    );
    expectCode(
      () => parseHostSnapshotV3Arguments(['verify', 'x'.repeat(HOST_SNAPSHOT_V3_CLI_LIMITS.maxArgumentLength + 1)]),
      'HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED',
    );
    const chunk = 'x'.repeat(Math.floor(HOST_SNAPSHOT_V3_CLI_LIMITS.maxTotalLength / 2));
    expectCode(
      () => parseHostSnapshotV3Arguments(['verify', chunk, chunk, 'x']),
      'HOST_SNAPSHOT_V3_CLI_ARGUMENT_LIMIT_EXCEEDED',
    );
  });

  it.each(['\0', '\n', '\r', '\u0001', '\u001f', '\u007f'])('拒绝控制字符 %#', (control) => {
    expectCode(
      () => parseHostSnapshotV3Arguments(['verify', '--snapshot', `C:\\safe${control}`]),
      'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID',
    );
  });

  it('值位置消费以 - 开头的路径，再由路径安全门拒绝，不将其当未知参数回显', () => {
    const parsed = parseHostSnapshotV3Arguments(['verify', '--snapshot', '-snapshot']);
    expect(parsed.values.get('--snapshot')).toBe('-snapshot');
    expectCode(() => runHostSnapshotV3Cli(['verify', '--snapshot', '-snapshot']), 'HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED');
  });

  it('四个业务命令均在业务读取前执行绝对路径安全门', () => {
    const cases = [
      ['verify', '--snapshot', 'relative'],
      [
        'export', '--database', 'relative', '--output', 'relative', '--work-dir', 'relative',
        '--workspace', 'relative', '--confirm', 'EXPORT_HOST_SNAPSHOT_V3_OFFLINE',
      ],
      [
        'restore-candidate', '--snapshot', 'relative', '--candidate', 'relative', '--work-dir', 'relative',
        '--workspace', 'relative', '--confirm', 'RESTORE_HOST_SNAPSHOT_V3_TO_NEW_CANDIDATE',
      ],
      ['bootstrap', '--database', 'relative', '--confirm', 'BOOTSTRAP_NOVAWING_SCHEMA_OFFLINE'],
    ] as const;
    for (const argv of cases) {
      expectCode(() => runHostSnapshotV3Cli(argv), 'HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED');
    }
  });
});
