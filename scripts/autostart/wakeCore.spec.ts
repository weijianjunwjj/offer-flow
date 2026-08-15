/**
 * OfferFlow v0.9 — Windows Wake Layer 核心逻辑测试。
 *
 * 覆盖 PHASE 11 全部 18 个点位：
 *   action 只位于 System32、无 node.exe / repo script / cmd.exe / powershell.exe、WakeToRun=true、
 *   有界 hold、wake schedule 08:58、metadata 保留、StartWhenAvailable 缺失按 false、
 *   Builtin Administrator readback 缺失 RunLevel 不误判、真实 current、schedule/command drift → stale + reason、
 *   pause/no-active 不要求 OS mutation、Wake Task 不调用 Run Now / 不启动 backend / 不执行 user-writable code。
 *
 * 全部通过 fake 注入测纯逻辑，绝不触碰真实 schtasks.exe / Task Scheduler / 文件系统 / 后端 HTTP。
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ELEVATION_CHECK_FAILED,
  ELEVATION_ELEVATED,
  ELEVATION_NOT_ELEVATED,
  INTEGRITY_SID_HIGH,
  INTEGRITY_SID_MEDIUM,
  INTEGRITY_SID_SYSTEM,
  TASK_ACTION_TRUST_BOUNDARY,
  TASK_EXECUTION_MAY_BE_ELEVATED,
  TRUSTED_HOLD_ARGUMENTS,
  TRUSTED_HOLD_EXECUTABLE,
  USER_WRITABLE_CODE_EXECUTED,
  WAKE_HOLD_DURATION_MS,
  WAKE_HOLD_PING_COUNT,
  WAKE_LEAD_TIME_MINUTES,
  WAKE_TASK_NAME,
  WAKE_TASK_MUTATION_FROM_SERVER,
  buildCreateArgs,
  buildDeleteArgs,
  buildQueryArgs,
  buildWakeTaskDescription,
  buildWakeTaskXml,
  computeNextWakeStartBoundary,
  computeWakeTaskMismatches,
  computeWakeTime,
  detectElevation,
  detectScheduleDrift,
  encodeTaskXmlForWindows,
  isTrustedHoldArguments,
  isTrustedSystem32Ping,
  parseConfiguredScheduleFromDescription,
  parseElevationOutput,
  parseWakeSchedule,
  parseWakeTaskQueryXml,
  resolveTrustedHoldExecutable,
  resolveWakeScheduleFromBackend,
  resolveWindowsWhoamiPath,
  runWakeTaskCommand,
} from './wakeCore.mjs';
import type { FetchJson, SchtasksExecutor, WakeTaskRunDeps } from './wakeCore.mjs';

const SYSTEM_ROOT = 'C:\\Windows';
const PING = 'C:\\Windows\\System32\\ping.exe';
const HOLD_ARGS = TRUSTED_HOLD_ARGUMENTS;

function captureSchtasks() {
  const calls: string[][] = [];
  const executor = vi.fn((args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  return { executor, calls };
}

function baseDeps(overrides: Partial<WakeTaskRunDeps> = {}): WakeTaskRunDeps {
  return {
    platform: 'win32',
    systemRoot: SYSTEM_ROOT,
    schtasksExecutor: captureSchtasks().executor,
    writeXmlFile: vi.fn(() => 'C:\\temp\\wake.xml'),
    removeXmlFile: vi.fn(),
    fetchJson: vi.fn(async () => ({})),
    isElevated: () => ELEVATION_ELEVATED,
    ...overrides,
  };
}

/** 构建带受信 action 的 canonical task XML（供解析/状态测试复用）。 */
function trustedXml(overrides: { description?: string; command?: string; args?: string } = {}) {
  return buildWakeTaskXml({
    taskName: WAKE_TASK_NAME,
    description: overrides.description ?? buildWakeTaskDescription({ dailyAt: '09:00', timezone: 'Asia/Shanghai' }),
    command: overrides.command ?? PING,
    arguments: overrides.args ?? HOLD_ARGS,
    workingDirectory: path.join(SYSTEM_ROOT, 'System32'),
    startBoundary: '2026-08-16T08:58:00',
  });
}

/** 从 XML 中移除某个元素（模拟 Windows canonical XML 省略默认 false / 省略 RunLevel）。 */
function stripTag(xml: string, tag: string) {
  return xml.replace(new RegExp(`\\s*<${tag}>.*?</${tag}>`, 's'), '');
}

describe('wake trigger 计算', () => {
  it('09:00 plan → wake trigger 08:58', () => {
    expect(WAKE_LEAD_TIME_MINUTES).toBe(2);
    expect(computeWakeTime('09:00', WAKE_LEAD_TIME_MINUTES)).toBe('08:58');
  });

  it('跨午夜 schedule 正确计算', () => {
    expect(computeWakeTime('00:00', 2)).toBe('23:58');
    expect(computeWakeTime('00:01', 2)).toBe('23:59');
    expect(computeWakeTime('00:10', 2)).toBe('00:08');
    expect(computeWakeTime('23:59', 2)).toBe('23:57');
  });

  it('非法 dailyAt 抛错', () => {
    expect(() => computeWakeTime('25:00', 2)).toThrow();
    expect(() => computeWakeTime('9:00', 2)).toThrow();
    expect(() => computeWakeTime('aa:bb', 2)).toThrow();
  });

  it('computeNextWakeStartBoundary 取下一次（今天未过则今天，已过则明天）', () => {
    const now = new Date(2026, 7, 15, 8, 0, 0).getTime();
    expect(computeNextWakeStartBoundary({ dailyAt: '09:00', leadMinutes: 2, now })).toBe('2026-08-15T08:58:00');
    const later = new Date(2026, 7, 15, 10, 0, 0).getTime();
    expect(computeNextWakeStartBoundary({ dailyAt: '09:00', leadMinutes: 2, now: later })).toBe('2026-08-16T08:58:00');
  });
});

describe('parseWakeSchedule', () => {
  it('timezone 缺省补 Asia/Shanghai', () => {
    expect(parseWakeSchedule({ dailyAt: '09:00' })).toEqual({ dailyAt: '09:00', timezone: 'Asia/Shanghai' });
  });

  it('非法 dailyAt 抛错', () => {
    expect(() => parseWakeSchedule({ dailyAt: 'nope' })).toThrow();
    expect(() => parseWakeSchedule(null)).toThrow();
  });
});

describe('configured schedule 持久化（description metadata）与 drift 检测', () => {
  it('buildWakeTaskDescription 持久化 dailyAt/timezone/wakeLeadMinutes，且不含 secret', () => {
    const desc = buildWakeTaskDescription({ dailyAt: '09:00', timezone: 'Asia/Shanghai' });
    expect(desc).toContain('dailyAt=09:00');
    expect(desc).toContain('timezone=Asia/Shanghai');
    expect(desc).toContain('wakeLeadMinutes=2');
    expect(desc).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer/i);
  });

  it('parseConfiguredScheduleFromDescription 往返一致', () => {
    const desc = buildWakeTaskDescription({ dailyAt: '08:30', timezone: 'Asia/Singapore', wakeLeadMinutes: 3 });
    expect(parseConfiguredScheduleFromDescription(desc)).toEqual({
      dailyAt: '08:30',
      timezone: 'Asia/Singapore',
      wakeLeadMinutes: 3,
    });
  });

  it('无 marker / 非法 dailyAt → null', () => {
    expect(parseConfiguredScheduleFromDescription('no marker here')).toBeNull();
    expect(parseConfiguredScheduleFromDescription('')).toBeNull();
    expect(parseConfiguredScheduleFromDescription(null)).toBeNull();
    expect(parseConfiguredScheduleFromDescription('offerflow-wake-config: dailyAt=bad; timezone=x')).toBeNull();
  });

  it('detectScheduleDrift：configured dailyAt ≠ active dailyAt → true；一致 → false', () => {
    const parsed = parseWakeTaskQueryXml(trustedXml());
    expect(detectScheduleDrift(parsed, '09:00')).toBe(false);
    expect(detectScheduleDrift(parsed, '10:00')).toBe(true);
  });
});

describe('受信 action trust boundary（System32-only）', () => {
  it('production wake task action 只能位于 System32（ping.exe 绝对路径）', () => {
    expect(isTrustedSystem32Ping(PING, SYSTEM_ROOT)).toBe(true);
    expect(resolveTrustedHoldExecutable(SYSTEM_ROOT)).toBe(PING);
    expect(TRUSTED_HOLD_EXECUTABLE).toBe(PING);
  });

  it('拒绝 node.exe（含真实 node 路径）', () => {
    expect(isTrustedSystem32Ping('D:\\nodejs\\node.exe', SYSTEM_ROOT)).toBe(false);
    expect(isTrustedSystem32Ping('node.exe', SYSTEM_ROOT)).toBe(false);
  });

  it('拒绝裸 ping.exe（可能落到 PATH 中用户可写的同名文件）', () => {
    expect(isTrustedSystem32Ping('ping.exe', SYSTEM_ROOT)).toBe(false);
  });

  it('拒绝用户目录 / 其它可写路径', () => {
    expect(isTrustedSystem32Ping('D:\\VSCode\\offer-flow\\scripts\\autostart\\offerflowWakeBridge.mjs', SYSTEM_ROOT)).toBe(false);
    expect(isTrustedSystem32Ping('C:\\Users\\Administrator\\ping.exe', SYSTEM_ROOT)).toBe(false);
  });

  it('有界 hold 参数：127.0.0.1 -n 301，count 有界', () => {
    expect(WAKE_HOLD_PING_COUNT).toBe(301);
    expect(WAKE_HOLD_DURATION_MS).toBe(5 * 60 * 1000);
    expect(HOLD_ARGS).toBe('127.0.0.1 -n 301');
    expect(isTrustedHoldArguments('127.0.0.1 -n 301')).toBe(true);
    expect(isTrustedHoldArguments(' 127.0.0.1  -n  301 ')).toBe(true);
    expect(isTrustedHoldArguments('127.0.0.1 -n 999999')).toBe(false);
    expect(isTrustedHoldArguments('')).toBe(false);
  });
});

describe('wake task XML 冻结设置', () => {
  it('WakeToRun = true', () => {
    expect(trustedXml()).toContain('<WakeToRun>true</WakeToRun>');
  });

  it('StartWhenAvailable = false', () => {
    expect(trustedXml()).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
  });

  it('battery flags = false（DisallowStartIfOnBatteries / StopIfGoingOnBatteries）', () => {
    expect(trustedXml()).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(trustedXml()).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });

  it('MultipleInstancesPolicy = IgnoreNew', () => {
    expect(trustedXml()).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('action command = System32 ping.exe', () => {
    const parsed = parseWakeTaskQueryXml(trustedXml());
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe(PING);
    expect(parsed!.arguments).toBe(HOLD_ARGS);
  });

  it('无 node.exe / 无 repo script / 无 cmd.exe / 无 powershell.exe', () => {
    const xml = trustedXml();
    expect(xml).not.toMatch(/node\.exe/i);
    expect(xml).not.toMatch(/offerflowWakeBridge|\.mjs|offer-flow/i);
    expect(xml).not.toMatch(/cmd\.exe/i);
    expect(xml).not.toMatch(/powershell\.exe|pwsh/i);
  });

  it('XML / command 不含 secret', () => {
    expect(trustedXml()).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer|tvly-/i);
  });
});

describe('XML 编码契约（UTF-16 declaration 与实际字节编码一致）', () => {
  function xml() {
    return trustedXml();
  }

  it('XML declaration 固定为 UTF-16（不含 UTF-8 declaration）', () => {
    expect(xml()).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml()).not.toContain('encoding="UTF-8"');
  });

  it('encodeTaskXmlForWindows 输出 Buffer，且前两字节为 UTF-16LE BOM（FF FE）', () => {
    const buf = encodeTaskXmlForWindows(xml());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
  });

  it('不是 UTF-8 BOM（EF BB BF）', () => {
    const buf = encodeTaskXmlForWindows(xml());
    expect([buf[0], buf[1], buf[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('去除 BOM 后按 utf16le 解码正确，首行为 UTF-16 declaration', () => {
    const decoded = encodeTaskXmlForWindows(xml()).subarray(2).toString('utf16le');
    expect(decoded.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    expect(decoded).toContain('<WakeToRun>true</WakeToRun>');
  });

  it('编码后仍含全部冻结 settings（含 InteractiveToken / LeastPrivilege intent / System32 ping）', () => {
    const decoded = encodeTaskXmlForWindows(xml()).subarray(2).toString('utf16le');
    expect(decoded).toContain('<WakeToRun>true</WakeToRun>');
    expect(decoded).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
    expect(decoded).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(decoded).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(decoded).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(decoded).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(decoded).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(decoded).toContain(PING);
  });

  it('编码后仍不含 node.exe / cmd.exe / powershell.exe / secret', () => {
    const decoded = encodeTaskXmlForWindows(xml()).subarray(2).toString('utf16le');
    expect(decoded).not.toMatch(/node\.exe/i);
    expect(decoded).not.toMatch(/cmd\.exe|powershell\.exe|pwsh/i);
    expect(decoded).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer|tvly-/i);
  });

  it('实际写盘后可按 UTF-16LE + BOM 被正确读回（无 UTF-8 BOM）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-wake-xml-'));
    const file = path.join(dir, 'wake.xml');
    try {
      fs.writeFileSync(file, encodeTaskXmlForWindows(xml()));
      const buf = fs.readFileSync(file);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xfe);
      const decoded = buf.subarray(2).toString('utf16le');
      expect(decoded).toContain('<?xml version="1.0" encoding="UTF-16"?>');
      expect(decoded).toContain('<WakeToRun>true</WakeToRun>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schtasks 参数构造', () => {
  it('create 用 /XML + /F 完整注册', () => {
    const args = buildCreateArgs({ taskName: WAKE_TASK_NAME, xmlFilePath: 'C:\\temp\\w.xml' });
    expect(args).toEqual(['/Create', '/TN', WAKE_TASK_NAME, '/XML', 'C:\\temp\\w.xml', '/F']);
  });

  it('delete 只删自身 task', () => {
    const args = buildDeleteArgs({ taskName: WAKE_TASK_NAME });
    expect(args).toEqual(['/Delete', '/TN', WAKE_TASK_NAME, '/F']);
  });

  it('query 只读探测 /XML', () => {
    const args = buildQueryArgs({ taskName: WAKE_TASK_NAME });
    expect(args).toEqual(['/Query', '/TN', WAKE_TASK_NAME, '/XML']);
  });
});

describe('parseWakeTaskQueryXml / computeWakeTaskMismatches', () => {
  it('合法 XML 全部冻结设置无 mismatch', () => {
    const parsed = parseWakeTaskQueryXml(trustedXml());
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toEqual([]);
  });

  it('非 Task XML / 空 stdout → null → absent', () => {
    expect(parseWakeTaskQueryXml('')).toBeNull();
    expect(parseWakeTaskQueryXml('no such task')).toBeNull();
    expect(parseWakeTaskQueryXml(null)).toBeNull();
  });

  it('StartWhenAvailable XML 缺失 → 按 false 处理，不误判 stale（修复根因）', () => {
    const xml = stripTag(trustedXml(), 'StartWhenAvailable');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(parsed!.startWhenAvailable).toBe(false);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toEqual([]);
  });

  it('battery flags 缺失（默认 false）→ 不误判 stale', () => {
    let xml = stripTag(trustedXml(), 'DisallowStartIfOnBatteries');
    xml = stripTag(xml, 'StopIfGoingOnBatteries');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toEqual([]);
  });

  it('Builtin Administrator readback 缺失 RunLevel → 不造成错误 stale（PRINCIPAL 只比 LogonType）', () => {
    const xml = stripTag(trustedXml(), 'RunLevel');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(parsed!.runLevel).toBeNull();
    expect(parsed!.logonType).toBe('InteractiveToken');
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toEqual([]);
  });

  it('command drift（node.exe / 用户可写）→ COMMAND_MISMATCH', () => {
    const parsed = parseWakeTaskQueryXml(trustedXml({ command: 'D:\\nodejs\\node.exe' }));
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('COMMAND_MISMATCH');
  });

  it('arguments drift → ARGUMENTS_MISMATCH', () => {
    const parsed = parseWakeTaskQueryXml(trustedXml({ args: '127.0.0.1 -n 999999' }));
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('ARGUMENTS_MISMATCH');
  });

  it('WakeToRun=false → WAKE_TO_RUN_MISMATCH', () => {
    const xml = trustedXml().replace('<WakeToRun>true</WakeToRun>', '<WakeToRun>false</WakeToRun>');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('WAKE_TO_RUN_MISMATCH');
  });

  it('StartWhenAvailable=true → START_WHEN_AVAILABLE_MISMATCH', () => {
    const xml = trustedXml().replace('<StartWhenAvailable>false</StartWhenAvailable>', '<StartWhenAvailable>true</StartWhenAvailable>');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('START_WHEN_AVAILABLE_MISMATCH');
  });

  it('MultipleInstancesPolicy 漂移 → MULTIPLE_INSTANCE_MISMATCH', () => {
    const xml = trustedXml().replace('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('MULTIPLE_INSTANCE_MISMATCH');
  });

  it('battery flags=true → BATTERY_POLICY_MISMATCH', () => {
    const xml = trustedXml().replace('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('BATTERY_POLICY_MISMATCH');
  });

  it('LogonType 漂移 → PRINCIPAL_MISMATCH', () => {
    const xml = trustedXml().replace('<LogonType>InteractiveToken</LogonType>', '<LogonType>Password</LogonType>');
    const parsed = parseWakeTaskQueryXml(xml);
    expect(computeWakeTaskMismatches(parsed, { systemRoot: SYSTEM_ROOT })).toContain('PRINCIPAL_MISMATCH');
  });
});

describe('runWakeTaskCommand — enable', () => {
  const activePlanFetch: FetchJson = vi.fn(async (path: string) => {
    if (path === '/daily-search-plans') {
      return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
    }
    return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
  });

  it('注册 action = System32 ping.exe + 有界 hold，wakeAt = 08:58，绝不含 node/secret', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson: activePlanFetch, schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.wakeAt).toBe('08:58');
    expect(result.dailyAt).toBe('09:00');
    expect(result.command).toBe(PING);
    expect(result.arguments).toBe(HOLD_ARGS);
    expect(result.command).not.toMatch(/node\.exe|cmd\.exe|powershell\.exe/i);
    expect(result.xml).toContain('<WakeToRun>true</WakeToRun>');
    expect(result.xml).not.toMatch(/node\.exe|\.mjs|TAVILY|DEEPSEEK|SECRET|API_KEY/i);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/Create');
    expect(calls[0]).toContain('/XML');
  });

  it('enable 经唯一 writeXmlFile 写盘，且临时 XML 清理不回归', async () => {
    const writeXmlFile = vi.fn((_xml: string) => 'C:\\temp\\wake.xml');
    const removeXmlFile = vi.fn();
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson: activePlanFetch, schtasksExecutor: executor, writeXmlFile, removeXmlFile }));
    expect(result.ok).toBe(true);
    expect(writeXmlFile).toHaveBeenCalledTimes(1);
    const writtenXml = writeXmlFile.mock.calls[0][0];
    expect(writtenXml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    const buf = encodeTaskXmlForWindows(writtenXml);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
    expect(removeXmlFile).toHaveBeenCalledWith('C:\\temp\\wake.xml');
    expect(calls[0]).toContain('C:\\temp\\wake.xml');
  });

  it('无 active plan / paused → NO_ACTIVE_PLAN，0 次 schtasks mutation', async () => {
    const fetchJson: FetchJson = vi.fn(async () => ({ plans: [] }));
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NO_ACTIVE_PLAN');
    expect(calls).toHaveLength(0);
  });

  it('schtasks 返回非零 → SCHTASKS_ERROR', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: 'access denied' }));
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson: activePlanFetch, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SCHTASKS_ERROR');
    expect(result.stderr).toBe('access denied');
  });
});

describe('runWakeTaskCommand — disable', () => {
  it('只删自身 task，幂等（不存在也 ok）', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['disable'], baseDeps({ schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.existed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(buildDeleteArgs({ taskName: WAKE_TASK_NAME }));
  });

  it('task 不存在（schtasks 非零）→ 稳定 ok，existed=false', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = await runWakeTaskCommand(['disable'], baseDeps({ schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.existed).toBe(false);
  });
});

describe('runWakeTaskCommand — status', () => {
  const activePlanFetch: FetchJson = vi.fn(async (path: string) => {
    if (path === '/daily-search-plans') {
      return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
    }
    return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
  });

  it('task 不存在 → absent', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('absent');
  });

  it('真实 schedule current（contract 全对 + schedule 一致）→ status=current，无 reason', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: trustedXml(), stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson: activePlanFetch }));
    expect(result.status).toBe('current');
    expect(result.staleReasonCodes).toEqual([]);
    expect(result.scheduleDrift).toBe(false);
    expect(result.requiresElevatedReconciliation).toBe(false);
    expect(result.command).toBe(PING);
  });

  it('schedule drift（configured 09:00 vs active 10:00）→ stale + SCHEDULE_MISMATCH', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: trustedXml(), stderr: '' }));
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '10:00', timezone: 'Asia/Shanghai' } } };
    });
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson }));
    expect(result.status).toBe('stale');
    expect(result.scheduleDrift).toBe(true);
    expect(result.staleReasonCodes).toContain('SCHEDULE_MISMATCH');
    expect(result.requiresElevatedReconciliation).toBe(true);
  });

  it('command drift（node.exe）→ stale + COMMAND_MISMATCH', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: trustedXml({ command: 'D:\\nodejs\\node.exe' }), stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson: activePlanFetch }));
    expect(result.status).toBe('stale');
    expect(result.staleReasonCodes).toContain('COMMAND_MISMATCH');
    expect(result.requiresElevatedReconciliation).toBe(true);
  });

  it('旧 task 无配置 marker → stale + METADATA_MISMATCH', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({
      status: 0,
      stdout: trustedXml({ description: 'legacy description without marker' }),
      stderr: '',
    }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson: activePlanFetch }));
    expect(result.status).toBe('stale');
    expect(result.staleReasonCodes).toContain('METADATA_MISMATCH');
    expect(result.requiresElevatedReconciliation).toBe(true);
  });

  it('后端不可达 → registered（降级只读，不臆断 current/stale）', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: trustedXml(), stderr: '' }));
    const fetchJson: FetchJson = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson }));
    expect(result.status).toBe('registered');
    expect(result.scheduleDrift).toBeNull();
    expect(result.requiresElevatedReconciliation).toBe(false);
  });

  it('Wake Task 不调用 Run Now（status/enable 绝不 fetch /run-now）', async () => {
    const fetchCalls: string[] = [];
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      fetchCalls.push(path);
      if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
    });
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: trustedXml(), stderr: '' }));
    await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson }));
    expect(fetchCalls.some((p) => p.includes('run-now'))).toBe(false);
  });
});

describe('Windows 提权检测（elevation detector）', () => {
  const csv = (...rows: string[]) => rows.join('\n');

  it('Medium integrity S-1-16-8192 → not-elevated', () => {
    expect(parseElevationOutput(csv('"A","B","S-1-16-8192",""'))).toBe(ELEVATION_NOT_ELEVATED);
  });

  it('High integrity S-1-16-12288 → elevated', () => {
    expect(parseElevationOutput(csv('"A","B","S-1-16-12288",""'))).toBe(ELEVATION_ELEVATED);
  });

  it('System integrity S-1-16-16384 → elevated', () => {
    expect(parseElevationOutput(csv('"A","B","S-1-16-16384",""'))).toBe(ELEVATION_ELEVATED);
  });

  it('中文/乱码组名但 SID 正确 → 正确判定', () => {
    const garbled = '"BUILTIN\\��������Ա","����","S-1-5-32-544","ֻ���ھܾ�����"\n'
      + '"Mandatory Label\\Medium Mandatory Level","��ǩ","S-1-16-8192",""';
    expect(parseElevationOutput(garbled)).toBe(ELEVATION_NOT_ELEVATED);
  });

  it('Administrators 组 enabled 但 integrity=Medium → not-elevated', () => {
    const out = csv(
      '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Enabled"',
      '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
    );
    expect(parseElevationOutput(out)).toBe(ELEVATION_NOT_ELEVATED);
  });

  it('用户名是 Administrator 但 integrity=Medium → not-elevated', () => {
    const out = csv(
      '"MACHINE\\Administrator","User","S-1-5-21-1","Enabled"',
      '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
    );
    expect(parseElevationOutput(out)).toBe(ELEVATION_NOT_ELEVATED);
  });

  it('High integrity 即使不解析 Administrators 文本 → elevated', () => {
    expect(parseElevationOutput(csv('"A","B","S-1-16-12288",""'))).toBe(ELEVATION_ELEVATED);
  });

  it('无任何 integrity SID / 空输出 → check-failed', () => {
    expect(parseElevationOutput('')).toBe(ELEVATION_CHECK_FAILED);
    expect(parseElevationOutput(null as unknown as string)).toBe(ELEVATION_CHECK_FAILED);
    expect(parseElevationOutput(csv('"Everyone","","S-1-1-0",""'))).toBe(ELEVATION_CHECK_FAILED);
  });

  it('resolveWindowsWhoamiPath 指向 System32 whoami.exe，不是裸名/GNU', () => {
    const p = resolveWindowsWhoamiPath('C:\\Windows');
    expect(p).toBe(path.join('C:\\Windows', 'System32', 'whoami.exe'));
    expect(p.toLowerCase()).toContain('system32');
    expect(p.toLowerCase()).not.toContain('usr\\bin');
    expect(p).not.toBe('whoami.exe');
  });

  it('detectElevation：spawn error → check-failed（safe failure）', () => {
    const spawnSyncFn = vi.fn(() => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' }));
    expect(detectElevation({ whoamiPath: 'C:\\Windows\\System32\\whoami.exe', spawnSyncFn })).toBe(ELEVATION_CHECK_FAILED);
  });

  it('detectElevation：whoami non-zero exit → check-failed（safe failure）', () => {
    const spawnSyncFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'err' }));
    expect(detectElevation({ whoamiPath: 'C:\\Windows\\System32\\whoami.exe', spawnSyncFn })).toBe(ELEVATION_CHECK_FAILED);
  });

  it('detectElevation：调用显式 System32 whoami.exe + /groups /fo csv /nh + shell=false', () => {
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: '"A","B","S-1-16-12288",""', stderr: '' }));
    const result = detectElevation({ whoamiPath: 'C:\\Windows\\System32\\whoami.exe', spawnSyncFn });
    expect(result).toBe(ELEVATION_ELEVATED);
    expect(spawnSyncFn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\whoami.exe',
      ['/groups', '/fo', 'csv', '/nh'],
      { encoding: 'utf-8', shell: false },
    );
  });

  it('SID 常量值冻结为正确完整性级别', () => {
    expect(INTEGRITY_SID_HIGH).toBe('S-1-16-12288');
    expect(INTEGRITY_SID_SYSTEM).toBe('S-1-16-16384');
    expect(INTEGRITY_SID_MEDIUM).toBe('S-1-16-8192');
  });
});

describe('runWakeTaskCommand — 提权门禁（ELEVATION_REQUIRED / ELEVATION_CHECK_FAILED）', () => {
  const activePlanFetch: FetchJson = vi.fn(async (path: string) => {
    if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
    return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
  });

  it('enable 非提权 → ELEVATION_REQUIRED，0 次 schtasks mutation', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ isElevated: () => ELEVATION_NOT_ELEVATED, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ELEVATION_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('disable 非提权 → ELEVATION_REQUIRED，0 次 schtasks mutation', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['disable'], baseDeps({ isElevated: () => ELEVATION_NOT_ELEVATED, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ELEVATION_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('status 不要求提权（isElevated=not-elevated 仍可运行）', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ isElevated: () => ELEVATION_NOT_ELEVATED, schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('absent');
  });

  it('enable 检测失败（check-failed）→ ELEVATION_CHECK_FAILED，0 次 schtasks mutation', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ isElevated: () => ELEVATION_CHECK_FAILED, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ELEVATION_CHECK_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('disable 检测失败（check-failed）→ ELEVATION_CHECK_FAILED，0 次 schtasks mutation', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['disable'], baseDeps({ isElevated: () => ELEVATION_CHECK_FAILED, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ELEVATION_CHECK_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('enable 提权（elevated）→ 进入 create path（1 次 schtasks /Create）', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ isElevated: () => ELEVATION_ELEVATED, fetchJson: activePlanFetch, schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/Create');
  });
});

describe('平台门禁与未知子命令', () => {
  it('非 Windows 平台明确拒绝，不调用 schtasks', async () => {
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ platform: 'linux', schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NON_WINDOWS');
    expect(calls).toHaveLength(0);
  });

  it('未知子命令返回 UNKNOWN_COMMAND', async () => {
    const result = await runWakeTaskCommand(['frobnicate'], baseDeps());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNKNOWN_COMMAND');
    expect(result.code).toBe(2);
  });
});

describe('resolveWakeScheduleFromBackend', () => {
  it('返回第一个 active plan 的 schedule', async () => {
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') {
        return {
          plans: [
            { id: 'p1', status: 'paused', activeVersionId: 'v1' },
            { id: 'p2', status: 'active', activeVersionId: 'v2' },
          ],
        };
      }
      return { activeVersion: { id: 'v2', schedule: { dailyAt: '08:30', timezone: 'Asia/Shanghai' } } };
    });
    expect(await resolveWakeScheduleFromBackend(fetchJson)).toEqual({ dailyAt: '08:30', timezone: 'Asia/Shanghai' });
  });

  it('无 active plan → null', async () => {
    const fetchJson: FetchJson = vi.fn(async () => ({ plans: [{ id: 'p1', status: 'paused', activeVersionId: null }] }));
    expect(await resolveWakeScheduleFromBackend(fetchJson)).toBeNull();
  });

  it('后端不可用（fetch 抛错）→ null', async () => {
    const fetchJson: FetchJson = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await resolveWakeScheduleFromBackend(fetchJson)).toBeNull();
  });
});

describe('冻结常量（privilege boundary hardening）', () => {
  it('WAKE_TASK_MUTATION_FROM_SERVER = FORBIDDEN（backend 绝不 mutation wake task）', () => {
    expect(WAKE_TASK_MUTATION_FROM_SERVER).toBe('FORBIDDEN');
  });

  it('hold 窗口为有界 5 分钟，绝不无限运行', () => {
    expect(WAKE_HOLD_DURATION_MS).toBe(5 * 60 * 1000);
    expect(WAKE_HOLD_PING_COUNT).toBeGreaterThan(0);
    expect(WAKE_HOLD_PING_COUNT).toBeLessThanOrEqual(600);
  });

  it('新的安全验收口径（Builtin Administrator 实际 elevated 下的 least-attack-surface）', () => {
    expect(TASK_EXECUTION_MAY_BE_ELEVATED).toBe('YES');
    expect(TASK_ACTION_TRUST_BOUNDARY).toBe('WINDOWS_SYSTEM32_ONLY');
    expect(USER_WRITABLE_CODE_EXECUTED).toBe('NO');
  });
});
