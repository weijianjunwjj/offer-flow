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
import {
  DEFAULT_HOLD_AWAKE_WINDOW_MS,
  WAKE_LEAD_TIME_MINUTES,
  WAKE_TASK_NAME,
  buildCreateArgs,
  buildDeleteArgs,
  buildQueryArgs,
  buildWakeTaskCommand,
  buildWakeTaskXml,
  computeNextWakeStartBoundary,
  computeWakeTime,
  detectWakeTaskStale,
  isWakeTaskCommandSafe,
  parseWakeSchedule,
  parseWakeTaskQueryXml,
  resolveWakeScheduleFromBackend,
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
  it('task 不存在 → absent', async () => {
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('absent');
  });

  it('task 已注册且设置正确 → registered + allVerified', async () => {
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: 'test',
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: xml, stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor }));
    expect(result.status).toBe('registered');
    expect(result.settings?.allVerified).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.command).toBe(NODE);
  });

  it('task command 与当前 repo 不一致 → stale=true', async () => {
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: 'test',
      nodeExecutable: 'D:\\old\\node.exe',
      wakeBridgePath: 'D:\\old\\bridge.mjs',
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-16T08:58:00',
    });
    const executor: SchtasksExecutor = vi.fn(() => ({ status: 0, stdout: xml, stderr: '' }));
    const result = await runWakeTaskCommand(['status'], baseDeps({ schtasksExecutor: executor }));
    expect(result.status).toBe('registered');
    expect(result.stale).toBe(true);
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
  it('hold-awake 窗口为有界 10 分钟', () => {
    expect(DEFAULT_HOLD_AWAKE_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});
