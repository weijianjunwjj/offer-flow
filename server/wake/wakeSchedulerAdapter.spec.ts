/**
 * OfferFlow v0.9 — Windows Wake Scheduler Adapter 测试（WakeTaskReconciliation）。
 *
 * 覆盖（PHASE 16 点位 13-16）：
 *   Plan paused / 无 active plan → wake task disable（删除）
 *   Resume / 新 active PlanVersion schedule 变化 → wake task 重新对齐（startBoundary 更新）
 *   非 Windows → skip；非法 schedule → skip（不触碰 schtasks）
 *
 * 全部通过 fake listActivePlans / getActiveVersion / schtasksExecutor / writeXmlFile / removeXmlFile
 * 测纯逻辑，绝不触碰真实 Task Scheduler / 文件系统。
 */

import { describe, expect, it, vi } from 'vitest';
import type { DailySearchPlan, DailySearchPlanVersion } from '../search-plan/types';
import {
  WAKE_TASK_NAME,
  buildWakeTaskXml,
} from '../../scripts/autostart/wakeCore.mjs';
import {
  decideWakeAction,
  reconcileWakeTask,
  type WindowsWakeSchedulerDeps,
} from './wakeSchedulerAdapter';

const NODE = 'D:\\nodejs\\node.exe';
const BRIDGE = 'D:\\VSCode\\offer-flow\\scripts\\autostart\\offerflowWakeBridge.mjs';
const REPO_ROOT = 'D:\\VSCode\\offer-flow';

function makePlan(id: string, status: DailySearchPlan['status'] = 'active'): DailySearchPlan {
  return {
    id,
    name: `plan-${id}`,
    status,
    activeVersionId: status === 'active' ? `${id}-v1` : null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
}

function makeVersion(planId: string, schedule: Record<string, unknown>): DailySearchPlanVersion {
  return {
    id: `${planId}-v1`,
    searchPlanId: planId,
    version: 1,
    cities: [],
    roleDirections: [],
    baseKeywords: [],
    expandedKeywords: [],
    hardConstraints: [],
    sourceConfigs: [],
    schedule,
    scanBudget: {},
    analysisBudget: {},
    briefPolicy: {},
    explorationPolicy: {},
    notificationPolicy: {},
    latestCatchUpTime: '12:00',
    createdAt: 0,
    activatedAt: null,
    supersedesVersionId: null,
  };
}

function captureSchtasks() {
  const calls: string[][] = [];
  const executor = vi.fn((args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  return { executor, calls };
}

function makeDeps(overrides: Partial<WindowsWakeSchedulerDeps> = {}): WindowsWakeSchedulerDeps {
  return {
    platform: 'win32',
    nodeExecutable: NODE,
    wakeBridgePath: BRIDGE,
    workingDirectory: REPO_ROOT,
    listActivePlans: vi.fn(() => []),
    getActiveVersion: vi.fn(() => null),
    schtasksExecutor: captureSchtasks().executor,
    writeXmlFile: vi.fn(() => 'C:\\temp\\wake.xml'),
    removeXmlFile: vi.fn(),
    now: () => new Date(2026, 7, 15, 8, 0, 0).getTime(),
    ...overrides,
  };
}

describe('decideWakeAction（纯决策）', () => {
  it('无 active schedule → disable', () => {
    expect(decideWakeAction([])).toEqual({ action: 'disable' });
  });

  it('有 active schedule → enable，取第一个（production active plan count = 1）', () => {
    expect(decideWakeAction([{ dailyAt: '09:00', timezone: 'Asia/Shanghai' }]))
      .toEqual({ action: 'enable', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } });
  });
});

describe('reconcileWakeTask', () => {
  it('无 active plan → disable（/Delete 自身 task），不写 XML', async () => {
    const { executor, calls } = captureSchtasks();
    const writeXmlFile = vi.fn(() => 'C:\\temp\\wake.xml');
    const result = reconcileWakeTask(makeDeps({ schtasksExecutor: executor, writeXmlFile }));
    expect(result.action).toBe('disable');
    expect(result.taskName).toBe(WAKE_TASK_NAME);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/Delete');
    expect(writeXmlFile).not.toHaveBeenCalled();
  });

  it('Plan paused（listActivePlans 空）→ disable', async () => {
    const { executor, calls } = captureSchtasks();
    const result = reconcileWakeTask(makeDeps({
      listActivePlans: vi.fn(() => []),
      schtasksExecutor: executor,
    }));
    expect(result.action).toBe('disable');
    expect(calls[0][0]).toBe('/Delete');
  });

  it('active plan → enable（/Create + XML），wake trigger = dailyAt - 2min', async () => {
    const { executor, calls } = captureSchtasks();
    const written: string[] = [];
    const writeXmlFile = vi.fn((xml: string) => { written.push(xml); return 'C:\\temp\\wake.xml'; });
    const result = reconcileWakeTask(makeDeps({
      listActivePlans: vi.fn(() => [makePlan('p1')]),
      getActiveVersion: vi.fn(() => makeVersion('p1', { dailyAt: '09:00', timezone: 'Asia/Shanghai' })),
      schtasksExecutor: executor,
      writeXmlFile,
    }));
    expect(result.action).toBe('enable');
    expect(result.command).toBe(`"${NODE}" "${BRIDGE}"`);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/Create');
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('<WakeToRun>true</WakeToRun>');
    expect(written[0]).toContain('<StartBoundary>2026-08-15T08:58:00</StartBoundary>');
    expect(written[0]).not.toMatch(/cmd\.exe|powershell\.exe|TAVILY|DEEPSEEK|SECRET/i);
  });

  it('new PlanVersion schedule 变化 → task schedule 更新（startBoundary 跟随新 dailyAt）', async () => {
    const { executor } = captureSchtasks();
    const written: string[] = [];
    const writeXmlFile = vi.fn((xml: string) => { written.push(xml); return 'C:\\temp\\wake.xml'; });
    reconcileWakeTask(makeDeps({
      listActivePlans: vi.fn(() => [makePlan('p1')]),
      getActiveVersion: vi.fn(() => makeVersion('p1', { dailyAt: '08:00', timezone: 'Asia/Shanghai' })),
      schtasksExecutor: executor,
      writeXmlFile,
    }));
    expect(written[0]).toContain('<StartBoundary>2026-08-16T07:58:00</StartBoundary>');
  });

  it('非 Windows 平台 → skip，不调用 schtasks', async () => {
    const { executor, calls } = captureSchtasks();
    const result = reconcileWakeTask(makeDeps({ platform: 'linux', schtasksExecutor: executor }));
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('NON_WINDOWS');
    expect(calls).toHaveLength(0);
  });

  it('非法 schedule → skip（INVALID_SCHEDULE），不触碰 schtasks', async () => {
    const { executor, calls } = captureSchtasks();
    const result = reconcileWakeTask(makeDeps({
      listActivePlans: vi.fn(() => [makePlan('p1')]),
      getActiveVersion: vi.fn(() => makeVersion('p1', { dailyAt: 'bad', timezone: 'Asia/Shanghai' })),
      schtasksExecutor: executor,
    }));
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('INVALID_SCHEDULE');
    expect(calls).toHaveLength(0);
  });

  it('schtasks /Create 失败 → 返回 SCHTASKS_ERROR，不抛错', async () => {
    const executor = vi.fn(() => ({ status: 1, stdout: '', stderr: 'access denied' }));
    const result = reconcileWakeTask(makeDeps({
      listActivePlans: vi.fn(() => [makePlan('p1')]),
      getActiveVersion: vi.fn(() => makeVersion('p1', { dailyAt: '09:00', timezone: 'Asia/Shanghai' })),
      schtasksExecutor: executor,
    }));
    expect(result.action).toBe('enable');
    expect(result.reason).toBe('SCHTASKS_ERROR');
    expect(result.stderr).toBe('access denied');
  });
});

describe('生成的 XML 与 wakeCore 契约一致', () => {
  it('buildWakeTaskXml 冻结项可被 reconcile 复用', () => {
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: 'test (Asia/Shanghai)',
      nodeExecutable: NODE,
      wakeBridgePath: BRIDGE,
      workingDirectory: REPO_ROOT,
      startBoundary: '2026-08-15T08:58:00',
    });
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });
});
