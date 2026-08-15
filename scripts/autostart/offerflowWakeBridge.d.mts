/**
 * 声明文件：offerflowWakeBridge.mjs 的 TypeScript 类型。
 * 仅用于 vue-tsc 类型检查与 .spec.ts 导入，运行时由 offerflowWakeBridge.mjs 提供实现。
 */

import type { ConfiguredSchedule, WakeSchedule } from './wakeCore.mjs';

export function computeTodayOccurrenceLocal(input: {
  dailyAt: string;
  now: number;
}): { scheduledFor: number; scheduledDay: string };

export function sleep(setTimeoutFn: (fn: () => void, ms: number) => unknown, ms: number): Promise<unknown>;

export function checkHealth(input: {
  fetchJson: (path: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  healthUrl?: string;
  timeoutMs?: number;
}): Promise<{ healthy: boolean }>;

export function waitForHealthy(input: {
  fetchJson: (path: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  healthUrl?: string;
  pollIntervalMs?: number;
  deadlineMs: number;
  now: () => number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
}): Promise<{ healthy: boolean }>;

export interface ActiveOccurrence {
  planId: string;
  versionId: string;
  scheduledFor: number;
  scheduledDay: string;
  schedule: WakeSchedule;
}
export function resolveActiveOccurrence(input: {
  fetchJson: (path: string) => Promise<Record<string, unknown>>;
  now: () => number;
}): Promise<ActiveOccurrence | null>;

export function waitForOccurrence(input: {
  fetchJson: (path: string) => Promise<Record<string, unknown>>;
  planId: string;
  versionId: string;
  scheduledFor: number;
  scheduledDay: string;
  pollIntervalMs?: number;
  deadlineMs: number;
  now: () => number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
}): Promise<{ outcome: 'terminal' | 'timeout'; run?: Record<string, unknown> }>;

export interface WakeBridgeDeps {
  repoRoot?: string;
  nodeExecutable?: string;
  launcherPath?: string;
  healthUrl?: string;
  holdAwakeWindowMs?: number;
  recoverHealthWaitMs?: number;
  occurrencePollIntervalMs?: number;
  fetchJson?: (path: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  spawnLauncherFn?: (input: { nodeExecutable: string; launcherPath: string; repoRoot: string }) => unknown;
  readTaskConfiguredSchedule?: () => Promise<ConfiguredSchedule | null>;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  chdirFn?: (dir: string) => void;
  existsSyncFn?: (p: string) => boolean;
  mkdirSyncFn?: (dir: string, opts?: { recursive?: boolean }) => unknown;
  writeLog?: (line: string) => void;
}

export interface WakeBridgeResult {
  exitCode: number;
  reason?: string;
  outcome?: 'terminal' | 'timeout' | 'no_active_plan' | 'wake_task_stale';
}

export function main(deps?: WakeBridgeDeps): Promise<WakeBridgeResult>;
