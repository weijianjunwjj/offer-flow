/**
 * OfferFlow v0.9 — Windows Wake Scheduler Adapter（WakeTaskReconciliation 边界）。
 *
 * 职责：把「business 层 lifecycle 变化」对齐到 Windows Task Scheduler wake task，
 * 使 wake trigger 永不永久停留在旧 schedule。
 *
 *   - Plan paused / 无 active plan → disable（删除）wake task，避免每天无意义唤醒机器。
 *   - Plan resumed / 新 active PlanVersion schedule 变化 → 重新注册 wake task（wake trigger = dailyAt - 2min）。
 *
 * 边界：
 *   - 本模块是唯一「business → schtasks」的收口，T023 API / control layer 不得直接散落调用 schtasks。
 *   - 只做 HOST WAKE 对齐，绝不调用 run-now、DailyRunCoordinator、DailyPipeline、不创建 SourceRun。
 *   - 全部 schtasks / 文件系统 side effect 通过 deps 注入，测试用 fake 替换，绝不触碰真实 Task Scheduler。
 *   - 非 Windows 平台 skip（no-op）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DailySearchPlan, DailySearchPlanVersion } from '../search-plan/types';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import type { SqliteDatabase } from '../db';
import { parseDailySearchSchedule } from '../daily-run/schedule';
import {
  WAKE_LEAD_TIME_MINUTES,
  WAKE_TASK_NAME,
  buildCreateArgs,
  buildDeleteArgs,
  buildWakeTaskCommand,
  buildWakeTaskDescription,
  buildWakeTaskXml,
  computeNextWakeStartBoundary,
} from '../../scripts/autostart/wakeCore.mjs';
import type { SchtasksExecutor } from '../../scripts/autostart/wakeCore.mjs';

/** 一次 reconciliation 的决策：enable（对齐 schedule）或 disable（无 active plan / paused）。 */
export type WakeReconcileAction =
  | { action: 'enable'; schedule: { dailyAt: string; timezone: string } }
  | { action: 'disable' };

/**
 * 纯决策：根据「已解析的 active schedule 列表」决定 enable 或 disable。
 * 当前 production active plan count = 1，取第一个 active schedule；不支持多 Plan task topology（不提前过度设计）。
 */
export function decideWakeAction(
  activeSchedules: Array<{ dailyAt: string; timezone: string }>,
): WakeReconcileAction {
  if (activeSchedules.length === 0) return { action: 'disable' };
  return { action: 'enable', schedule: activeSchedules[0] };
}

export interface WindowsWakeSchedulerDeps {
  platform?: string;
  nodeExecutable: string;
  wakeBridgePath: string;
  workingDirectory: string;
  listActivePlans: () => DailySearchPlan[];
  getActiveVersion: (planId: string) => DailySearchPlanVersion | null;
  schtasksExecutor: SchtasksExecutor;
  writeXmlFile: (xml: string) => string;
  removeXmlFile: (xmlFilePath: string) => void;
  now?: () => number;
}

export interface WakeReconcileResult {
  action: 'enable' | 'disable' | 'skipped';
  reason?: 'NON_WINDOWS' | 'NO_ACTIVE_PLAN' | 'INVALID_SCHEDULE' | 'SCHTASKS_ERROR';
  taskName?: string;
  command?: string;
  schtasksArgs?: string[];
  stderr?: string;
}

/** 从 active plans 解析出 active schedule 列表；非法 schedule 抛错（由调用方决定 skip）。 */
function resolveActiveSchedules(
  listActivePlans: () => DailySearchPlan[],
  getActiveVersion: (planId: string) => DailySearchPlanVersion | null,
): Array<{ dailyAt: string; timezone: string }> {
  const schedules: Array<{ dailyAt: string; timezone: string }> = [];
  for (const plan of listActivePlans()) {
    if (plan.status !== 'active') continue;
    const version = getActiveVersion(plan.id);
    if (version === null) continue;
    schedules.push(parseDailySearchSchedule(version.schedule));
  }
  return schedules;
}

/**
 * 一次完整 reconciliation：读 active schedule → 决策 → 构建 XML → 执行 schtasks。
 * 失败不抛错（返回结构化 result），由 control layer 记录日志；不阻塞 lifecycle 变更本身。
 */
export function reconcileWakeTask(deps: WindowsWakeSchedulerDeps): WakeReconcileResult {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    return { action: 'skipped', reason: 'NON_WINDOWS' };
  }

  let schedules: Array<{ dailyAt: string; timezone: string }>;
  try {
    schedules = resolveActiveSchedules(deps.listActivePlans, deps.getActiveVersion);
  } catch {
    return { action: 'skipped', reason: 'INVALID_SCHEDULE' };
  }

  const decision = decideWakeAction(schedules);
  if (decision.action === 'disable') {
    const args = buildDeleteArgs({ taskName: WAKE_TASK_NAME });
    const result = deps.schtasksExecutor(args);
    return {
      action: 'disable',
      taskName: WAKE_TASK_NAME,
      schtasksArgs: args,
      ...(result.status !== 0 ? { stderr: result.stderr ?? '' } : {}),
    };
  }

  const { dailyAt, timezone } = decision.schedule;
  const now = (deps.now ?? Date.now)();
  const startBoundary = computeNextWakeStartBoundary({
    dailyAt,
    leadMinutes: WAKE_LEAD_TIME_MINUTES,
    now,
  });
  const command = buildWakeTaskCommand({
    nodeExecutable: deps.nodeExecutable,
    wakeBridgePath: deps.wakeBridgePath,
  });
  const xml = buildWakeTaskXml({
    taskName: WAKE_TASK_NAME,
    description: buildWakeTaskDescription({ timezone }),
    nodeExecutable: deps.nodeExecutable,
    wakeBridgePath: deps.wakeBridgePath,
    workingDirectory: deps.workingDirectory,
    startBoundary,
  });

  const xmlFilePath = deps.writeXmlFile(xml);
  const createArgs = buildCreateArgs({ taskName: WAKE_TASK_NAME, xmlFilePath });
  const result = deps.schtasksExecutor(createArgs);
  try {
    deps.removeXmlFile(xmlFilePath);
  } catch {
    // 临时 XML 清理失败不影响注册结果。
  }
  if (result.status !== 0) {
    return {
      action: 'enable',
      taskName: WAKE_TASK_NAME,
      schtasksArgs: createArgs,
      stderr: result.stderr ?? '',
      reason: 'SCHTASKS_ERROR',
    };
  }
  return { action: 'enable', taskName: WAKE_TASK_NAME, command, schtasksArgs: createArgs };
}

// ── 真实运行时组合（production composition root，测试不触达真实 schtasks）────────

/** 真实 schtasks.exe executor（spawnSync，不经过 shell / CMD / PowerShell）。 */
function createSchtasksExecutor(): SchtasksExecutor {
  return (args) => {
    const result = spawnSync('schtasks.exe', args, { encoding: 'utf-8' });
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

function createWriteXmlFile(): (xml: string) => string {
  return (xml) => {
    const filePath = path.join(os.tmpdir(), `offerflow-wake-task-${process.pid}.xml`);
    fs.writeFileSync(filePath, xml, 'utf-8');
    return filePath;
  };
}

function createRemoveXmlFile(): (xmlFilePath: string) => void {
  return (filePath) => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // 临时文件清理失败不影响注册结果。
    }
  };
}

/**
 * 组装真实 Windows wake reconciler（供 control layer 在 lifecycle 变化后调用）。
 * 返回 { reconcile }；reconcile 幂等、非 Windows 平台 skip、失败不抛错。
 */
export function createWindowsWakeReconciler(db: SqliteDatabase): { reconcile: () => WakeReconcileResult } {
  const planRepo = new SearchPlanRepository(db);
  const nodeExecutable = process.execPath;
  const repoRoot = process.cwd();
  const wakeBridgePath = path.join(repoRoot, 'scripts', 'autostart', 'offerflowWakeBridge.mjs');
  const schtasksExecutor = createSchtasksExecutor();
  const writeXmlFile = createWriteXmlFile();
  const removeXmlFile = createRemoveXmlFile();

  return {
    reconcile: () =>
      reconcileWakeTask({
        platform: process.platform,
        nodeExecutable,
        wakeBridgePath,
        workingDirectory: repoRoot,
        listActivePlans: () => planRepo.listActivePlans(),
        getActiveVersion: (id) => planRepo.getActiveVersion(id),
        schtasksExecutor,
        writeXmlFile,
        removeXmlFile,
      }),
  };
}
