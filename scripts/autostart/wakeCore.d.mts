/**
 * 声明文件：wakeCore.mjs 的 TypeScript 类型。
 * 仅用于 vue-tsc 类型检查与 .spec.ts 导入，运行时由 wakeCore.mjs 提供实现。
 */

export const WAKE_TASK_NAME: string;
export const WAKE_LEAD_TIME_MINUTES: number;
export const DEFAULT_HOLD_AWAKE_WINDOW_MS: number;
export const WAKE_TASK_EXECUTION_TIME_LIMIT: string;
export const HEALTH_URL: string;
export const HEALTH_TIMEOUT_MS: number;
export const RECOVER_HEALTH_WAIT_MS: number;
export const OCCURRENCE_POLL_INTERVAL_MS: number;
export const SOURCE_RUN_TERMINAL_STATUSES: string[];

export function isValidDailyAt(dailyAt: string): boolean;

export interface WakeSchedule {
  dailyAt: string;
  timezone: string;
}
export function parseWakeSchedule(schedule: unknown): WakeSchedule;

export function computeWakeTime(dailyAt: string, leadMinutes: number): string;
export function computeNextWakeStartBoundary(input: {
  dailyAt: string;
  leadMinutes: number;
  now: number;
}): string;
export function localStartBoundary(instant: number): string;

export function buildWakeTaskCommand(input: {
  nodeExecutable: string;
  wakeBridgePath: string;
}): string;

export function buildWakeTaskXml(input: {
  taskName: string;
  description: string;
  nodeExecutable: string;
  wakeBridgePath: string;
  workingDirectory: string;
  startBoundary: string;
  executionTimeLimit?: string;
}): string;

export function buildWakeTaskDescription(input: { timezone: string }): string;

export function buildCreateArgs(input: { taskName: string; xmlFilePath: string }): string[];
export function buildDeleteArgs(input: { taskName: string }): string[];
export function buildQueryArgs(input: { taskName: string }): string[];

export interface WakeTaskParsed {
  command: string;
  arguments: string;
  startBoundary: string | null;
  wakeToRun: boolean | null;
  startWhenAvailable: boolean | null;
  multipleInstancesPolicy: string | null;
  disallowStartIfOnBatteries: boolean | null;
  stopIfGoingOnBatteries: boolean | null;
}
export function parseWakeTaskQueryXml(stdout: string | null | undefined): WakeTaskParsed | null;
export function isWakeTaskCommandSafe(parsed: WakeTaskParsed | null): boolean;

export interface WakeTaskSettings {
  allVerified: boolean;
  commandSafe: boolean;
  wakeToRun: boolean;
  startWhenAvailable: boolean | null;
  multipleInstancesPolicy: boolean | null;
  batteryFlags: boolean | null;
}
export function verifyWakeTaskSettings(parsed: WakeTaskParsed | null): WakeTaskSettings;
export function detectWakeTaskStale(
  parsed: WakeTaskParsed | null,
  expected: { nodeExecutable: string; wakeBridgePath: string },
): boolean;

export interface SchtasksExecutorResult {
  status: number;
  stdout?: string | null;
  stderr?: string | null;
}
export type SchtasksExecutor = (args: string[]) => SchtasksExecutorResult;
export type FetchJson = (path: string) => Promise<Record<string, unknown>>;

export interface WakeTaskRunDeps {
  platform: string;
  nodeExecutable: string;
  wakeBridgePath: string;
  workingDirectory: string;
  schtasksExecutor: SchtasksExecutor;
  writeXmlFile: (xml: string) => string;
  removeXmlFile: (xmlFilePath: string) => void;
  fetchJson: FetchJson;
  now?: () => number;
}

export interface WakeTaskRunResult {
  ok: boolean;
  code: number;
  subcommand?: string;
  reason?: string;
  stderr?: string;
  taskName?: string;
  command?: string;
  arguments?: string;
  startBoundary?: string;
  wakeAt?: string;
  dailyAt?: string;
  timezone?: string;
  xml?: string;
  schtasksArgs?: string[];
  status?: 'absent' | 'registered';
  settings?: WakeTaskSettings;
  stale?: boolean;
  existed?: boolean;
}

export function runWakeTaskCommand(argv: string[], deps: WakeTaskRunDeps): Promise<WakeTaskRunResult>;
export function resolveWakeScheduleFromBackend(fetchJson: FetchJson): Promise<WakeSchedule | null>;
