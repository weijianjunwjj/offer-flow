import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunState, isTaskSucceeded, type RunState } from './store';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-store-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function baseState(overrides: Partial<RunState> = {}): RunState {
  const state = createRunState(cwd, 'run-fixture', '任务', 'custom');
  return { ...state, ...overrides };
}

describe('isTaskSucceeded：运行是否结束 与 任务是否成功 必须可区分', () => {
  it('STOPPED 时任务一律判定为不成功，即使已有改动文件', () => {
    const state = baseState({ currentPhase: 'STOPPED', changedFiles: ['a.ts'], stopReason: 'FLAKY_TESTS' });
    expect(isTaskSucceeded(state)).toBe(false);
  });

  it('DONE 但没有任何改动文件时也判定为不成功（避免空转当成功）', () => {
    const state = baseState({ currentPhase: 'DONE', changedFiles: [] });
    expect(isTaskSucceeded(state)).toBe(false);
  });

  it('DONE 且有改动文件时判定为成功', () => {
    const state = baseState({ currentPhase: 'DONE', changedFiles: ['a.ts'] });
    expect(isTaskSucceeded(state)).toBe(true);
  });

  it('尚未结束（如 IMPLEMENT 中途）时判定为不成功，不得提前判成功', () => {
    const state = baseState({ currentPhase: 'IMPLEMENT', changedFiles: ['a.ts'] });
    expect(isTaskSucceeded(state)).toBe(false);
  });
});
