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
  done: boolean;
  /** 本次 run 生效的计价模式，写入状态供 report 展示（不影响历史已记录调用的 costRmb）。 */
  pricingMode: PricingMode;
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
