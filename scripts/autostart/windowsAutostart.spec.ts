/**
 * OfferFlow v0.9 — Windows Autostart Registry 测试（T031 / PART 13）。
 *
 * 覆盖：enable command / registry path / value name / 引用 / 空格 / 中文 / 幂等 /
 * disable 只删自身 / disable 不存在稳定 / status disabled / status enabled /
 * status stale / 非 Windows 拒绝 / secret 不进 command。
 *
 * 全部通过 fake regExecutor 测 runAutostartCommand 纯逻辑，绝不触碰真实 HKCU Run。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  REGISTRY_PATH,
  VALUE_NAME,
  buildDisableRegArgs,
  buildEnableRegArgs,
  buildQueryRegArgs,
  buildRegistryCommand,
  detectStale,
  isWindowsPlatform,
  parseQueryOutput,
  parseRegistryCommand,
  runAutostartCommand,
  splitWindowsCommand,
} from './autostartCore.mjs';
import type { RegExecutor } from './autostartCore.mjs';

const NODE = 'D:\\nodejs\\node.exe';
const LAUNCHER = 'D:\\VSCode\\offer-flow\\scripts\\autostart\\offerflowAutostartLauncher.mjs';

function winDeps(regExecutor: RegExecutor) {
  return { platform: 'win32', nodeExecutable: NODE, launcherPath: LAUNCHER, regExecutor };
}

function captureRegExecutor() {
  const calls: string[][] = [];
  const executor = vi.fn((args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  return { executor, calls };
}

describe('Registry 常量', () => {
  it('权威路径为 HKCU\\...\\CurrentVersion\\Run', () => {
    expect(REGISTRY_PATH).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  });

  it('value name 冻结为 OfferFlowDailyJobHunter', () => {
    expect(VALUE_NAME).toBe('OfferFlowDailyJobHunter');
  });
});

describe('buildRegistryCommand — node + launcher 引用', () => {
  it('正确引用 node 与 launcher 两个 token', () => {
    const cmd = buildRegistryCommand({ nodeExecutable: NODE, launcherPath: LAUNCHER });
    expect(cmd).toBe(`"${NODE}" "${LAUNCHER}"`);
  });

  it('路径含空格仍被完整包裹（不拆散）', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const launcher = 'D:\\My Projects\\offer flow\\launcher.mjs';
    const cmd = buildRegistryCommand({ nodeExecutable: node, launcherPath: launcher });
    expect(cmd).toBe(`"${node}" "${launcher}"`);
    expect(parseRegistryCommand(cmd)).toEqual({ nodeExecutable: node, launcherPath: launcher });
  });

  it('路径含中文仍被完整包裹', () => {
    const node = 'D:\\开发工具\\nodejs\\node.exe';
    const launcher = 'D:\\求职\\offer-flow\\脚本\\launcher.mjs';
    const cmd = buildRegistryCommand({ nodeExecutable: node, launcherPath: launcher });
    expect(cmd).toBe(`"${node}" "${launcher}"`);
    expect(parseRegistryCommand(cmd)).toEqual({ nodeExecutable: node, launcherPath: launcher });
  });

  it('secret 绝不进入 command（只有 node + launcher）', () => {
    const cmd = buildRegistryCommand({ nodeExecutable: NODE, launcherPath: LAUNCHER });
    expect(cmd).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD/i);
    expect(cmd).not.toMatch(/tvly-|Bearer/i);
  });
});

describe('splitWindowsCommand / parseRegistryCommand', () => {
  it('解析带空格与中文的双引号 command', () => {
    expect(splitWindowsCommand('"a b" "c d"')).toEqual(['a b', 'c d']);
    expect(splitWindowsCommand('"a" "b"')).toEqual(['a', 'b']);
  });

  it('结构不符（token 数非 2）返回 null', () => {
    expect(parseRegistryCommand('"only-one"')).toBeNull();
    expect(parseRegistryCommand('"a" "b" "c"')).toBeNull();
    expect(parseRegistryCommand('')).toBeNull();
    expect(parseRegistryCommand('   ')).toBeNull();
  });
});

describe('runAutostartCommand — enable', () => {
  it('Windows 平台 enable 返回 ok 并携带正确 command', () => {
    const { executor, calls } = captureRegExecutor();
    const result = runAutostartCommand(['enable'], winDeps(executor));
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.command).toBe(`"${NODE}" "${LAUNCHER}"`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(buildEnableRegArgs({ command: result.command! }));
  });

  it('reg add 使用 /f 幂等覆盖 + REG_SZ + 正确 value name', () => {
    const args = buildEnableRegArgs({ command: `"${NODE}" "${LAUNCHER}"` });
    expect(args[0]).toBe('add');
    expect(args[1]).toBe(REGISTRY_PATH);
    expect(args).toContain('/v');
    expect(args).toContain(VALUE_NAME);
    expect(args).toContain('/t');
    expect(args).toContain('REG_SZ');
    expect(args).toContain('/f');
  });

  it('enable 幂等：两次构造相同 command 与 regArgs', () => {
    const { executor, calls } = captureRegExecutor();
    runAutostartCommand(['enable'], winDeps(executor));
    runAutostartCommand(['enable'], winDeps(executor));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  });

  it('reg.exe 返回非零时 enable 返回 REG_ERROR', () => {
    const executor = vi.fn(() => ({ status: 1, stdout: '', stderr: 'access denied' }));
    const result = runAutostartCommand(['enable'], winDeps(executor));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('REG_ERROR');
    expect(result.stderr).toBe('access denied');
  });
});

describe('runAutostartCommand — disable', () => {
  it('只删自身 value，绝不删整个 Run key', () => {
    const args = buildDisableRegArgs();
    expect(args[0]).toBe('delete');
    expect(args[1]).toBe(REGISTRY_PATH);
    expect(args).toContain('/v');
    expect(args).toContain(VALUE_NAME);
    // 不出现「只给 key 不给 /v」的整 key 删除形态
    expect(args).toHaveLength(5);
  });

  it('value 不存在（reg 返回非零）也得到稳定 ok 结果', () => {
    const executor = vi.fn(() => ({ status: 1, stdout: '', stderr: '找不到指定的注册表项或值' }));
    const result = runAutostartCommand(['disable'], winDeps(executor));
    expect(result.ok).toBe(true);
    expect(result.existed).toBe(false);
  });

  it('value 存在时 disable 返回 existed=true', () => {
    const executor = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const result = runAutostartCommand(['disable'], winDeps(executor));
    expect(result.ok).toBe(true);
    expect(result.existed).toBe(true);
  });
});

describe('runAutostartCommand — status', () => {
  it('reg query 非零 → disabled', () => {
    const executor = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = runAutostartCommand(['status'], winDeps(executor));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('disabled');
    expect(executor).toHaveBeenCalledWith(buildQueryRegArgs());
  });

  it('reg query 有值 → enabled 且 current command 正确', () => {
    const command = `"${NODE}" "${LAUNCHER}"`;
    const stdout = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      `    ${VALUE_NAME}    REG_SZ    ${command}`,
    ].join('\r\n');
    const executor = vi.fn(() => ({ status: 0, stdout, stderr: '' }));
    const result = runAutostartCommand(['status'], winDeps(executor));
    expect(result.status).toBe('enabled');
    expect(result.command).toBe(command);
    expect(result.stale).toBe(false);
  });

  it('repo 移动后（旧 launcher path）→ stale=true，且不偷偷修改', () => {
    const oldLauncher = 'D:\\old-location\\launcher.mjs';
    const command = `"${NODE}" "${oldLauncher}"`;
    const stdout = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      `    ${VALUE_NAME}    REG_SZ    ${command}`,
    ].join('\r\n');
    const executor = vi.fn(() => ({ status: 0, stdout, stderr: '' }));
    const result = runAutostartCommand(['status'], winDeps(executor));
    expect(result.status).toBe('enabled');
    expect(result.stale).toBe(true);
    // status 只读：不触发任何 add/delete 写入
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(buildQueryRegArgs());
  });
});

describe('parseQueryOutput', () => {
  it('提取 REG_SZ data', () => {
    const command = `"${NODE}" "${LAUNCHER}"`;
    const stdout = `    ${VALUE_NAME}    REG_SZ    ${command}`;
    expect(parseQueryOutput(stdout)).toBe(command);
  });

  it('无数据返回 null', () => {
    expect(parseQueryOutput('')).toBeNull();
    expect(parseQueryOutput(null)).toBeNull();
    expect(parseQueryOutput('no such value')).toBeNull();
  });
});

describe('detectStale', () => {
  it('当前 command 与期望一致 → 不 stale', () => {
    expect(detectStale({ currentCommand: `"${NODE}" "${LAUNCHER}"`, nodeExecutable: NODE, launcherPath: LAUNCHER })).toBe(false);
  });

  it('launcher path 不一致 → stale', () => {
    expect(detectStale({ currentCommand: `"${NODE}" "D:\\other\\launcher.mjs"`, nodeExecutable: NODE, launcherPath: LAUNCHER })).toBe(true);
  });

  it('无法解析 → stale', () => {
    expect(detectStale({ currentCommand: 'garbage', nodeExecutable: NODE, launcherPath: LAUNCHER })).toBe(true);
  });
});

describe('平台门禁', () => {
  it('isWindowsPlatform 仅 win32 为 true', () => {
    expect(isWindowsPlatform('win32')).toBe(true);
    expect(isWindowsPlatform('linux')).toBe(false);
    expect(isWindowsPlatform('darwin')).toBe(false);
  });

  it('非 Windows 平台明确拒绝，不调用 regExecutor', () => {
    const executor = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const result = runAutostartCommand(['enable'], {
      platform: 'linux',
      nodeExecutable: NODE,
      launcherPath: LAUNCHER,
      regExecutor: executor,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NON_WINDOWS');
    expect(executor).not.toHaveBeenCalled();
  });

  it('未知子命令返回 UNKNOWN_COMMAND', () => {
    const executor = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const result = runAutostartCommand(['frobnicate'], winDeps(executor));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNKNOWN_COMMAND');
    expect(result.code).toBe(2);
  });
});
