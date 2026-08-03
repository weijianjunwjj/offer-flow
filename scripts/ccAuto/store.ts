/** 落盘存储：.cc-auto/runs/<run-id>/ 下的 state.json、phases/*.json、report.md。 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Phase, CallUsage, FailureRecord, StopReason, Classification } from './types';
import type { PricingMode } from './config';
import { redactForDisk } from './redact';

export interface RunState {
  runId: string;
  taskDescription: string;
  createdAt: string;
  updatedAt: string;
  currentPhase: Phase;
  classification?: Classification;
  calls: CallUsage[];
  failures: FailureRecord[];
  repairCycles: number;
  opusCalls: number;
  changedFiles: string[];
  stopReason?: StopReason;
  stopDetail?: string;
  /** 运行是否已结束（终态，无论成功或失败）；不代表任务本身是否成功，见 taskSucceeded。 */
  done: boolean;
  /** 本次 run 生效的计价模式，写入状态供 report 展示（不影响历史已记录调用的 costRmb）。 */
  pricingMode: PricingMode;
  /**
   * 仅当**真实进入并成功执行** Simple Direct Edit 执行路径（机器读取上下文 → tools:[] Builder →
   * 机器原子应用 edits）时才为 true。仅满足命中条件但准备/应用阶段失败时不得置 true，
   * 报告据此判断是否标记 Simple Direct Edit（不允许「标记但仍走标准 Agent Builder」）。
   */
  directEdit?: boolean;
  /** Direct Edit 真实执行的机器侧记录，供报告展示目标文件、edit 数量与应用结果。仅在 directEdit=true 时存在。 */
  directEditDetail?: DirectEditDetail;
}

export interface DirectEditDetail {
  /** 机器准备上下文时读取的目标文件（相对仓库根路径）。 */
  targetFiles: string[];
  /** 校验并原子应用的 edit 数量。 */
  editCount: number;
  /** 实际写盘且产生真实 git diff 的文件。 */
  appliedFiles: string[];
  /** Builder 返回的改动摘要。 */
  summary: string;
  /** Builder 建议的定向测试（若有）。 */
  suggestedTests: string[];
}

/**
 * 任务是否成功：只有「以 DONE 结束 + 有改动文件 + 最终验证通过」才算成功。
 * STOPPED、无改动、未过验证均为否，避免「运行已结束」与「任务已成功」的歧义。
 */
export function isTaskSucceeded(state: RunState): boolean {
  if (state.currentPhase !== 'DONE') return false;
  if (state.changedFiles.length === 0) return false;
  return true;
}

export function ccAutoRoot(cwd: string): string {
  return path.join(cwd, '.cc-auto');
}

export function runDir(cwd: string, runId: string): string {
  return path.join(ccAutoRoot(cwd), 'runs', runId);
}

export function phasesDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'phases');
}

export function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${Date.now()}-${rand}`;
}

export function createRunState(cwd: string, runId: string, taskDescription: string, pricingMode: PricingMode): RunState {
  const now = new Date().toISOString();
  const state: RunState = {
    runId,
    taskDescription,
    createdAt: now,
    updatedAt: now,
    currentPhase: 'INTAKE',
    calls: [],
    failures: [],
    repairCycles: 0,
    opusCalls: 0,
    changedFiles: [],
    done: false,
    pricingMode,
  };
  mkdirSync(phasesDir(cwd, runId), { recursive: true });
  saveRunState(cwd, state);
  return state;
}

export function saveRunState(cwd: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const file = path.join(runDir(cwd, state.runId), 'state.json');
  writeFileSync(file, redactForDisk(JSON.stringify(state, null, 2)), 'utf8');
}

export function loadRunState(cwd: string, runId: string): RunState {
  const file = path.join(runDir(cwd, runId), 'state.json');
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

export function runStateExists(cwd: string, runId: string): boolean {
  return existsSync(path.join(runDir(cwd, runId), 'state.json'));
}

/** 记录某阶段的输入输出快照（脱敏后），用于 resume 时判断该阶段是否已完成。 */
export function savePhaseRecord(cwd: string, runId: string, phase: Phase, record: unknown): void {
  const dir = phasesDir(cwd, runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${phase}.json`);
  writeFileSync(file, redactForDisk(JSON.stringify(record, null, 2)), 'utf8');
}

export function loadPhaseRecord<T>(cwd: string, runId: string, phase: Phase): T | undefined {
  const file = path.join(phasesDir(cwd, runId), `${phase}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function listRunIds(cwd: string): string[] {
  const dir = path.join(ccAutoRoot(cwd), 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function latestRunId(cwd: string): string | undefined {
  const ids = listRunIds(cwd);
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

export function writeReport(cwd: string, runId: string, markdown: string): string {
  const file = path.join(runDir(cwd, runId), 'report.md');
  writeFileSync(file, redactForDisk(markdown), 'utf8');
  return file;
}
