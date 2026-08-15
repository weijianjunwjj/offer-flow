/**
 * OfferFlow v0.9 — Windows Wake Layer 核心逻辑测试。
 *
 * 覆盖（PHASE 16 点位 1-6、17、18）：
 *   09:00 → 08:58、跨午夜、WakeToRun=true、StartWhenAvailable=false、battery flags=false、
 *   MultipleInstancesPolicy=IgnoreNew、XML/command 不含 secret、command 不含 cmd.exe/powershell.exe，
 *   以及 enable / disable / status 子命令编排（fake schtasksExecutor / writeXmlFile / fetchJson）。
 *
 * 全部通过 fake 注入测纯逻辑，绝不触碰真实 schtasks.exe / Task Scheduler / 文件系统 / 后端 HTTP。
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HOLD_AWAKE_WINDOW_MS,
  ELEVATION_CHECK_FAILED,
  ELEVATION_ELEVATED,
  ELEVATION_NOT_ELEVATED,
  INTEGRITY_SID_HIGH,
  INTEGRITY_SID_MEDIUM,
  INTEGRITY_SID_SYSTEM,
  WAKE_LEAD_TIME_MINUTES,
  WAKE_TASK_NAME,
  WAKE_TASK_MUTATION_FROM_SERVER,
  buildCreateArgs,
  buildDeleteArgs,
  buildQueryArgs,
  buildWakeTaskCommand,
  buildWakeTaskDescription,
  buildWakeTaskXml,
  computeNextWakeStartBoundary,
  computeWakeTime,
  detectElevation,
  detectScheduleDrift,
  detectWakeTaskStale,
  encodeTaskXmlForWindows,
  isWakeTaskCommandSafe,
  parseConfiguredScheduleFromDescription,
  parseElevationOutput,
  parseWakeSchedule,
  parseWakeTaskQueryXml,
  resolveWakeScheduleFromBackend,
  resolveWindowsWhoamiPath,
  runWakeTaskCommand,
  verifyWakeTaskSettings,
} from './wakeCore.mjs';
import type { FetchJson, SchtasksExecutor, WakeTaskRunDeps } from './wakeCore.mjs';

const NODE = 'D:\\nodejs\\node.exe';
const BRIDGE = 'D:\\VSCode\\offer-flow\\scripts\\autostart\\offerflowWakeBridge.mjs';
const REPO_ROOT = 'D:\\VSCode\\offer-flow';

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
    nodeExecutable: NODE,
    wakeBridgePath: BRIDGE,
    workingDirectory: REPO_ROOT,
    schtasksExecutor: captureSchtasks().executor,
    writeXmlFile: vi.fn(() => 'C:\\temp\\wake.xml'),
    removeXmlFile: vi.fn(),
    fetchJson: vi.fn(async () => ({})),
    isElevated: () => ELEVATION_ELEVATED,
    ...overrides,
  };
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
    // 本地 2026-08-15 08:00，dailyAt=09:00 → wake 08:58 今天（未来）。
    const now = new Date(2026, 7, 15, 8, 0, 0).getTime();
    expect(computeNextWakeStartBoundary({ dailyAt: '09:00', leadMinutes: 2, now })).toBe('2026-08-15T08:58:00');
    // 本地 2026-08-15 10:00，dailyAt=09:00 → 今天的 08:58 已过 → 明天 08:58。
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
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: buildWakeTaskDescription({ dailyAt: '09:00', timezone: 'Asia/Shanghai' }),
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
    const parsed = parseWakeTaskQueryXml(xml);
    expect(detectScheduleDrift(parsed, '09:00')).toBe(false);
    expect(detectScheduleDrift(parsed, '10:00')).toBe(true);
  });
});

describe('wake task command / XML 冻结设置', () => {
  function xml() {
    return buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: 'test wake task (Asia/Shanghai)',
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
  }

  it('WakeToRun = true', () => {
    expect(xml()).toContain('<WakeToRun>true</WakeToRun>');
  });

  it('StartWhenAvailable = false', () => {
    expect(xml()).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
  });

  it('battery flags = false（DisallowStartIfOnBatteries / StopIfGoingOnBatteries）', () => {
    expect(xml()).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml()).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });

  it('MultipleInstancesPolicy = IgnoreNew', () => {
    expect(xml()).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('command 不含 cmd.exe / powershell.exe（只用 node + bridge）', () => {
    const parsed = parseWakeTaskQueryXml(xml());
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe(NODE);
    expect(parsed!.arguments).toBe(`"${BRIDGE}"`);
    expect(isWakeTaskCommandSafe(parsed)).toBe(true);
  });

  it('XML / command 不含 secret', () => {
    const command = buildWakeTaskCommand({ nodeExecutable: NODE, wakeBridgePath: BRIDGE });
    expect(command).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer/i);
    expect(xml()).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer|tvly-/i);
  });

  it('buildWakeTaskCommand 只含 node + bridge 两个 token', () => {
    expect(buildWakeTaskCommand({ nodeExecutable: NODE, wakeBridgePath: BRIDGE })).toBe(`"${NODE}" "${BRIDGE}"`);
  });
});

describe('XML 编码契约（UTF-16 declaration 与实际字节编码一致）', () => {
  function xml() {
    return buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: buildWakeTaskDescription({ dailyAt: '09:00', timezone: 'Asia/Shanghai' }),
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
  }

  it('XML declaration 固定为 UTF-16（不含 UTF-8 declaration）', () => {
    const x = xml();
    expect(x).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(x).not.toContain('encoding="UTF-8"');
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

  it('不是纯 UTF-8 字节（首两字节不是 "<" 0x3c + "?" 0x3f）', () => {
    const buf = encodeTaskXmlForWindows(xml());
    expect(buf[0] === 0x3c && buf[1] === 0x3f).toBe(false);
  });

  it('编码后仍含全部冻结 settings（含 InteractiveToken / LeastPrivilege）', () => {
    const decoded = encodeTaskXmlForWindows(xml()).subarray(2).toString('utf16le');
    expect(decoded).toContain('<WakeToRun>true</WakeToRun>');
    expect(decoded).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
    expect(decoded).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(decoded).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(decoded).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(decoded).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(decoded).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('编码后 command 仍安全（不含 cmd.exe / powershell.exe / secret）', () => {
    const decoded = encodeTaskXmlForWindows(xml()).subarray(2).toString('utf16le');
    expect(decoded).not.toMatch(/cmd\.exe|powershell\.exe|pwsh/i);
    expect(decoded).not.toMatch(/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer|tvly-/i);
  });

  it('metadata（description）编码后仍正确保留', () => {
    const decoded = encodeTaskXmlForWindows(xml()).subarray(2).toString('utf16le');
    expect(decoded).toContain('dailyAt=09:00');
    expect(decoded).toContain('timezone=Asia/Shanghai');
    expect(decoded).toContain('wakeLeadMinutes=2');
  });

  it('实际写盘后可按 UTF-16LE + BOM 被正确读回（无 UTF-8 BOM）', () => {
    // 本测试是唯一真实触碰文件系统的点位：验证 encodeTaskXmlForWindows 产物与 declaration 一致。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-wake-xml-'));
    const file = path.join(dir, 'wake.xml');
    try {
      fs.writeFileSync(file, encodeTaskXmlForWindows(xml()));
      const buf = fs.readFileSync(file);
      // 首字节必须是 UTF-16LE BOM（FF FE），不是 UTF-8 BOM（EF BB BF）或 '<'（0x3c）。
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

describe('parseWakeTaskQueryXml / verifyWakeTaskSettings', () => {
  function xmlWithOverrides(pairs: Record<string, string>) {
    let x = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: 'test',
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
    for (const [tag, value] of Object.entries(pairs)) {
      x = x.replace(new RegExp(`<${tag}>.*?</${tag}>`, 's'), `<${tag}>${value}</${tag}>`);
    }
    return x;
  }

  it('合法 XML 全部冻结设置通过校验', () => {
    const parsed = parseWakeTaskQueryXml(xmlWithOverrides({}));
    const settings = verifyWakeTaskSettings(parsed);
    expect(settings.allVerified).toBe(true);
    expect(settings.wakeToRun).toBe(true);
    expect(settings.startWhenAvailable).toBe(true);
    expect(settings.multipleInstancesPolicy).toBe(true);
    expect(settings.batteryFlags).toBe(true);
    expect(settings.commandSafe).toBe(true);
  });

  it('非 Task XML / 空 stdout → null → absent', () => {
    expect(parseWakeTaskQueryXml('')).toBeNull();
    expect(parseWakeTaskQueryXml('no such task')).toBeNull();
    expect(parseWakeTaskQueryXml(null)).toBeNull();
  });

  it('WakeToRun=false → 校验失败', () => {
    const parsed = parseWakeTaskQueryXml(xmlWithOverrides({ WakeToRun: 'false' }));
    expect(verifyWakeTaskSettings(parsed).allVerified).toBe(false);
    expect(verifyWakeTaskSettings(parsed).wakeToRun).toBe(false);
  });

  it('StartWhenAvailable=true → 校验失败（不得建第二套 missed-run recovery）', () => {
    const parsed = parseWakeTaskQueryXml(xmlWithOverrides({ StartWhenAvailable: 'true' }));
    expect(verifyWakeTaskSettings(parsed).startWhenAvailable).toBe(false);
  });

  it('battery flags=true → 校验失败', () => {
    const parsed = parseWakeTaskQueryXml(xmlWithOverrides({ DisallowStartIfOnBatteries: 'true' }));
    expect(verifyWakeTaskSettings(parsed).batteryFlags).toBe(false);
  });

  it('command 含 cmd.exe → commandSafe=false', () => {
    const parsed = parseWakeTaskQueryXml(xmlWithOverrides({ Command: 'C:\\Windows\\System32\\cmd.exe' }));
    expect(isWakeTaskCommandSafe(parsed)).toBe(false);
    expect(verifyWakeTaskSettings(parsed).allVerified).toBe(false);
  });

  it('detectWakeTaskStale：repo 移动 / node 变化 → stale', () => {
    const parsed = parseWakeTaskQueryXml(xmlWithOverrides({}));
    expect(detectWakeTaskStale(parsed, { nodeExecutable: NODE, wakeBridgePath: BRIDGE })).toBe(false);
    expect(detectWakeTaskStale(parsed, { nodeExecutable: 'D:\\other\\node.exe', wakeBridgePath: BRIDGE })).toBe(true);
    expect(detectWakeTaskStale(parsed, { nodeExecutable: NODE, wakeBridgePath: 'D:\\old\\bridge.mjs' })).toBe(true);
  });
});

describe('runWakeTaskCommand — enable', () => {
  it('从后端 active schedule 取 dailyAt 注册，绝不含 secret，wakeAt = dailyAt - 2min', async () => {
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') {
        return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      }
      if (path === '/daily-search-plans/p1') {
        return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
      }
      return {};
    });
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson, schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.wakeAt).toBe('08:58');
    expect(result.dailyAt).toBe('09:00');
    expect(result.command).toBe(`"${NODE}" "${BRIDGE}"`);
    expect(result.taskName).toBe(WAKE_TASK_NAME);
    expect(result.xml).toContain('<WakeToRun>true</WakeToRun>');
    expect(result.command).not.toMatch(/TAVILY|DEEPSEEK|SECRET|API_KEY/i);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/Create');
    expect(calls[0]).toContain('/XML');
  });

  it('enable 经唯一 writeXmlFile 写盘（UTF-16 helper 可落盘），且临时 XML 清理不回归', async () => {
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
    });
    const writeXmlFile = vi.fn((_xml: string) => 'C:\\temp\\wake.xml');
    const removeXmlFile = vi.fn();
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson, schtasksExecutor: executor, writeXmlFile, removeXmlFile }));
    expect(result.ok).toBe(true);
    // 唯一写盘入口：writeXmlFile 恰好调用一次，收到完整 frozen xml（UTF-16 declaration）。
    expect(writeXmlFile).toHaveBeenCalledTimes(1);
    const writtenXml = writeXmlFile.mock.calls[0][0];
    expect(writtenXml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    // 该 xml 经唯一 encoding helper 落盘后是 UTF-16LE + BOM（不是 UTF-8 字节）。
    const buf = encodeTaskXmlForWindows(writtenXml);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
    // 临时 XML 清理照常执行，且路径与 schtasks /Create 使用的临时文件路径一致。
    expect(removeXmlFile).toHaveBeenCalledWith('C:\\temp\\wake.xml');
    expect(calls[0]).toContain('C:\\temp\\wake.xml');
  });

  it('无 active plan → NO_ACTIVE_PLAN，不调用 schtasks', async () => {
    const fetchJson: FetchJson = vi.fn(async () => ({ plans: [] }));
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson, schtasksExecutor: executor }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NO_ACTIVE_PLAN');
    expect(calls).toHaveLength(0);
  });

  it('schtasks 返回非零 → SCHTASKS_ERROR', async () => {
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
    });
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: 'access denied' }));
    const result = await runWakeTaskCommand(['enable'], baseDeps({ fetchJson, schtasksExecutor: executor }));
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

  function currentXml(dailyAt = '09:00', nodeExecutable = NODE, bridgePath = BRIDGE) {
    return buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: buildWakeTaskDescription({ dailyAt, timezone: 'Asia/Shanghai' }),
      nodeExecutable,
      wakeBridgePath: bridgePath,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
  }

  it('task 不存在 → absent', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('absent');
  });

  it('task 已注册 + 设置正确 + schedule 与 active plan 一致 → current', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: currentXml('09:00'), stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson: activePlanFetch }));
    expect(result.status).toBe('current');
    expect(result.settings?.allVerified).toBe(true);
    expect(result.commandDrift).toBe(false);
    expect(result.scheduleDrift).toBe(false);
    expect(result.requiresElevatedReconciliation).toBe(false);
    expect(result.command).toBe(NODE);
  });

  it('schedule drift（configured 09:00 vs active 10:00）→ stale + 需提权 reconcile', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: currentXml('09:00'), stderr: '' }));
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '10:00', timezone: 'Asia/Shanghai' } } };
    });
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson }));
    expect(result.status).toBe('stale');
    expect(result.scheduleDrift).toBe(true);
    expect(result.requiresElevatedReconciliation).toBe(true);
  });

  it('command drift（node.exe 变化）→ stale + 需提权 reconcile', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: currentXml('09:00', 'D:\\old\\node.exe'), stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson: activePlanFetch }));
    expect(result.status).toBe('stale');
    expect(result.commandDrift).toBe(true);
    expect(result.requiresElevatedReconciliation).toBe(true);
  });

  it('旧 task 无配置 marker → stale（无法证明 current，需 re-bootstrap）', async () => {
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: 'legacy description without marker',
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: xml, stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson: activePlanFetch }));
    expect(result.status).toBe('stale');
    expect(result.requiresElevatedReconciliation).toBe(true);
  });

  it('后端不可达 → registered（降级只读，不臆断 current/stale）', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: currentXml('09:00'), stderr: '' }));
    const fetchJson: FetchJson = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor, fetchJson }));
    expect(result.status).toBe('registered');
    expect(result.scheduleDrift).toBeNull();
    expect(result.requiresElevatedReconciliation).toBe(false);
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
    // 模拟真实 whoami CSV：组名是 GBK 乱码，SID 仍是 ASCII。
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
    // 不含 "Administrators" 字样，仅凭 S-1-16-12288 判定。
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
    const fetchJson: FetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
    });
    const { executor, calls } = captureSchtasks();
    const result = await runWakeTaskCommand(['enable'], baseDeps({ isElevated: () => ELEVATION_ELEVATED, fetchJson, schtasksExecutor: executor }));
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

describe('冻结常量', () => {
  it('WAKE_TASK_MUTATION_FROM_SERVER = FORBIDDEN（backend 绝不 mutation wake task）', () => {
    expect(WAKE_TASK_MUTATION_FROM_SERVER).toBe('FORBIDDEN');
  });

  it('hold-awake 窗口为有界 10 分钟', () => {
    expect(DEFAULT_HOLD_AWAKE_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});
