import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRunState,
  isTaskSucceeded,
  saveBudgetEstimate,
  saveRoutingDecision,
  saveCostSummary,
  saveArbitrationCapsule,
  loadBudgetEstimate,
  loadRoutingDecisions,
  loadCostSummary,
  loadArbitrationCapsule,
  loadRunState,
  runDir,
  saveRunState,
  _atomicRenameWithRetry,
  StatePersistenceError,
  type RunState,
} from './store';
import type {
  TaskBudgetEstimate,
  RoutingDecisionRecord,
  TaskCostSummary,
  ArbitrationCapsule,
} from './types';

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

  it('DONE + changedFiles + stopReason=PROVIDER_ERROR → false（H3: terminal error）', () => {
    const state = baseState({ currentPhase: 'DONE', changedFiles: ['a.ts'], stopReason: 'PROVIDER_ERROR', stopDetail: 'REPORTER_OUTPUT_FAILED_AFTER_EXECUTION' });
    expect(isTaskSucceeded(state)).toBe(false);
  });

  it('DONE + changedFiles + other stopReason → false', () => {
    const state = baseState({ currentPhase: 'DONE', changedFiles: ['a.ts'], stopReason: 'BUDGET_TASK_EXCEEDED' });
    expect(isTaskSucceeded(state)).toBe(false);
  });

  it('尚未结束（如 IMPLEMENT 中途）时判定为不成功，不得提前判成功', () => {
    const state = baseState({ currentPhase: 'IMPLEMENT', changedFiles: ['a.ts'] });
    expect(isTaskSucceeded(state)).toBe(false);
  });
});

// ============================================================================
// v0.2.0 Slice 1F：路由与预算持久化测试
// ============================================================================

function fakeEstimate(overrides: Partial<TaskBudgetEstimate> = {}): TaskBudgetEstimate {
  return {
    estimateId: 'est-test-1',
    runId: 'r1',
    taskId: 't1',
    routingPolicyVersion: 'cc-auto-model-routing-v1',
    initialSelection: {
      role: 'FAST_EXECUTOR',
      provider: 'deepseek',
      profileId: 'f',
      modelLogicalName: 'flash',
      source: 'POLICY',
      reasonCodes: ['DEFAULT_FLASH'],
      policyVersion: 'cc-auto-model-routing-v1',
    },
    currency: 'CNY',
    estimatedCalls: [{
      role: 'FAST_EXECUTOR',
      provider: 'deepseek',
      modelLogicalName: 'flash',
      minCalls: 1, expectedCalls: 1, maxCalls: 1,
      estimatedInputTokens: { min: 1000, expected: 2000, max: 5000 },
      estimatedOutputTokens: { min: 500, expected: 1000, max: 2000 },
      estimatedCostRmb: { min: 0.001, expected: 0.003, max: 0.009 },
    }],
    totalEstimatedCostRmb: { min: 0.001, expected: 0.003, max: 0.009 },
    assumptions: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDecision(overrides: Partial<RoutingDecisionRecord> = {}): RoutingDecisionRecord {
  return {
    decisionId: 'rd-test-1',
    runId: 'r1',
    taskId: 't1',
    attemptId: 'attempt-0',
    role: 'FAST_EXECUTOR',
    provider: 'deepseek',
    profileId: 'f',
    modelLogicalName: 'flash',
    source: 'POLICY',
    reasonCodes: ['DEFAULT_FLASH'],
    policyVersion: 'cc-auto-model-routing-v1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeSummary(overrides: Partial<TaskCostSummary> = {}): TaskCostSummary {
  return {
    runId: 'r1',
    taskId: 't1',
    currency: 'CNY',
    estimate: fakeEstimate(),
    actual: {
      totalCalls: 1,
      inputTokens: 5000,
      outputTokens: 2000,
      cachedTokens: 0,
      totalTokens: 7000,
      costRmb: 0.012,
    },
    byRole: [{
      role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash',
      calls: 1, inputTokens: 5000, outputTokens: 2000, cachedTokens: 0,
      totalTokens: 7000, costRmb: 0.012, tokenShare: 1.0, costShare: 1.0,
    }],
    estimateComparison: {
      actualVsExpectedRatio: 4.0,
      actualVsMaximumRatio: 1.33,
      absoluteVarianceRmb: 0.009,
      variancePercent: 300,
    },
    routingEffect: {
      flashCallShare: 1.0, proCallShare: null, opusCallShare: null,
      flashCostShare: 1.0, proCostShare: null, opusCostShare: null,
      escalationCount: 0, escalationCostRmb: null,
      hypotheticalAllProCostRmb: 0.028,
      savedVsAllProRmb: 0.016, savedVsAllProPercent: 57.14,
    },
    completed: true,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeCapsule(overrides: Partial<ArbitrationCapsule> = {}): ArbitrationCapsule {
  return {
    taskGoal: 'fix bug in auth',
    hardConstraints: ['no schema change'],
    attemptedModels: [{ role: 'STRONG_EXECUTOR', modelLogicalName: 'pro', outcome: 'FAILED', failureCategory: 'MODEL_QUALITY_FAILURE' }],
    changedFiles: ['auth.ts'],
    verifierFailures: ['unit test failed'],
    relevantDiff: '--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-foo\n+bar',
    unresolvedQuestions: ['ambiguous spec'],
    ...overrides,
  };
}

describe('持久化 — 预算估算', () => {
  it('预算保存后可重新读取', () => {
    const state = createRunState(cwd, 'r-budget', 'budget task', 'custom');
    const est = fakeEstimate({ runId: state.runId });
    saveBudgetEstimate(cwd, state.runId, est);
    const loaded = loadBudgetEstimate(cwd, state.runId);
    expect(loaded).toBeDefined();
    expect(loaded!.estimateId).toBe('est-test-1');
    expect(loaded!.runId).toBe(state.runId);
  });

  it('RunState 不存在时 saveBudgetEstimate 不抛错', () => {
    expect(() => saveBudgetEstimate(cwd, 'nonexistent', fakeEstimate())).not.toThrow();
  });

  it('RunState 不存在时 loadBudgetEstimate 返回 undefined', () => {
    expect(loadBudgetEstimate(cwd, 'nonexistent')).toBeUndefined();
  });
});

describe('持久化 — 路由决策', () => {
  it('路由记录保存后可重新读取', () => {
    const state = createRunState(cwd, 'r-rd', 'rd task', 'custom');
    const d = fakeDecision({ runId: state.runId });
    saveRoutingDecision(cwd, state.runId, d);
    const loaded = loadRoutingDecisions(cwd, state.runId);
    expect(loaded.length).toBe(1);
    expect(loaded[0].decisionId).toBe('rd-test-1');
    expect(loaded[0].role).toBe('FAST_EXECUTOR');
  });

  it('多条路由记录顺序追加', () => {
    const state = createRunState(cwd, 'r-rd2', 'rd2 task', 'custom');
    saveRoutingDecision(cwd, state.runId, fakeDecision({ decisionId: 'rd-a', runId: state.runId }));
    saveRoutingDecision(cwd, state.runId, fakeDecision({ decisionId: 'rd-b', runId: state.runId, role: 'STRONG_EXECUTOR' }));
    const loaded = loadRoutingDecisions(cwd, state.runId);
    expect(loaded.length).toBe(2);
    expect(loaded[0].decisionId).toBe('rd-a');
    expect(loaded[1].decisionId).toBe('rd-b');
    expect(loaded[1].role).toBe('STRONG_EXECUTOR');
  });

  it('重复 decisionId 不重复写入', () => {
    const state = createRunState(cwd, 'r-rd3', 'rd3 task', 'custom');
    saveRoutingDecision(cwd, state.runId, fakeDecision({ decisionId: 'dup', runId: state.runId }));
    saveRoutingDecision(cwd, state.runId, fakeDecision({ decisionId: 'dup', runId: state.runId }));
    const loaded = loadRoutingDecisions(cwd, state.runId);
    expect(loaded.length).toBe(1);
  });

  it('RunState 不存在时 saveRoutingDecision 不抛错', () => {
    expect(() => saveRoutingDecision(cwd, 'nonexistent', fakeDecision())).not.toThrow();
  });

  it('RunState 不存在时 loadRoutingDecisions 返回空数组', () => {
    expect(loadRoutingDecisions(cwd, 'nonexistent')).toEqual([]);
  });
});

describe('持久化 — 成本总结', () => {
  it('成本总结保存后可重新读取', () => {
    const state = createRunState(cwd, 'r-cs', 'cs task', 'custom');
    const s = fakeSummary({ runId: state.runId });
    saveCostSummary(cwd, state.runId, s);
    const loaded = loadCostSummary(cwd, state.runId);
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe(state.runId);
    expect(loaded!.actual.totalCalls).toBe(1);
  });

  it('多次保存覆盖（最后一次生效）', () => {
    const state = createRunState(cwd, 'r-cs2', 'cs2 task', 'custom');
    saveCostSummary(cwd, state.runId, fakeSummary({ runId: state.runId, actual: { ...fakeSummary().actual, totalCalls: 1 } }));
    saveCostSummary(cwd, state.runId, fakeSummary({ runId: state.runId, actual: { ...fakeSummary().actual, totalCalls: 3 } }));
    const loaded = loadCostSummary(cwd, state.runId);
    expect(loaded!.actual.totalCalls).toBe(3);
  });

  it('RunState 不存在时 saveCostSummary 不抛错', () => {
    expect(() => saveCostSummary(cwd, 'nonexistent', fakeSummary())).not.toThrow();
  });

  it('RunState 不存在时 loadCostSummary 返回 undefined', () => {
    expect(loadCostSummary(cwd, 'nonexistent')).toBeUndefined();
  });
});

describe('持久化 — 仲裁 Capsule', () => {
  it('Capsule 保存后可重新读取', () => {
    const state = createRunState(cwd, 'r-ac', 'ac task', 'custom');
    const cap = fakeCapsule();
    saveArbitrationCapsule(cwd, state.runId, cap);
    const loaded = loadArbitrationCapsule(cwd, state.runId);
    expect(loaded).toBeDefined();
    expect(loaded!.taskGoal).toBe('fix bug in auth');
    expect(loaded!.hardConstraints).toEqual(['no schema change']);
    expect(loaded!.attemptedModels.length).toBe(1);
  });

  it('RunState 不存在时 saveArbitrationCapsule 不抛错', () => {
    expect(() => saveArbitrationCapsule(cwd, 'nonexistent', fakeCapsule())).not.toThrow();
  });

  it('RunState 不存在时 loadArbitrationCapsule 返回 undefined', () => {
    expect(loadArbitrationCapsule(cwd, 'nonexistent')).toBeUndefined();
  });
});

describe('持久化 — 老状态兼容', () => {
  it('老 RunState 无新字段时仍可读取', () => {
    const state = createRunState(cwd, 'r-old', 'old task', 'custom');
    const loaded = loadRunState(cwd, state.runId);
    expect(loaded.budgetEstimate).toBeUndefined();
    expect(loaded.routingDecisions).toBeUndefined();
    expect(loaded.costSummary).toBeUndefined();
    expect(loaded.arbitrationCapsule).toBeUndefined();
  });

  it('routingDecisions 默认按空数组处理', () => {
    const state = createRunState(cwd, 'r-old2', 'old2 task', 'custom');
    const decisions = loadRoutingDecisions(cwd, state.runId);
    expect(decisions).toEqual([]);
  });

  it('手动写入缺少新字段的 JSON 也不抛错', () => {
    const state = createRunState(cwd, 'r-manual', 'manual', 'custom');
    const raw: any = { ...loadRunState(cwd, state.runId) };
    delete raw.budgetEstimate;
    delete raw.routingDecisions;
    delete raw.costSummary;
    delete raw.arbitrationCapsule;
    writeFileSync(
      path.join(runDir(cwd, state.runId), 'state.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
    const loaded = loadRunState(cwd, state.runId);
    expect(loaded.budgetEstimate).toBeUndefined();
    expect(loaded.routingDecisions).toBeUndefined();
    expect(loaded.costSummary).toBeUndefined();
    expect(loaded.arbitrationCapsule).toBeUndefined();
  });
});

// ============================================================================
// v0.2.0 P9: Windows state.json 原子持久化 EPERM 收口
// ============================================================================

describe('持久化 — 原子保存 (P9 Windows EPERM 收口)', () => {
  it('saveRunState 使用唯一临时文件+rename 原子写', () => {
    const state = createRunState(cwd, 'r-atomic', 'atomic', 'custom');
    const loaded = loadRunState(cwd, state.runId);
    expect(loaded.runId).toBe(state.runId);
    // P9: 不再使用固定 state.json.tmp，唯一临时文件不应残留
    const { readdirSync, existsSync } = awaitFs();
    const statePath = path.join(runDir(cwd, state.runId), 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const runDirPath = runDir(cwd, state.runId);
    const residualTmps = readdirSync(runDirPath).filter((f: string) => f.endsWith('.tmp'));
    expect(residualTmps).toEqual([]);
  });

  it('saveBudgetEstimate 也通过原子 saveRunState（临时文件不留存）', () => {
    const state = createRunState(cwd, 'r-atomic2', 'atomic2', 'custom');
    saveBudgetEstimate(cwd, state.runId, fakeEstimate({ runId: state.runId }));
    saveBudgetEstimate(cwd, state.runId, fakeEstimate({ runId: state.runId, estimateId: 'est-v2' }));
    const loaded = loadBudgetEstimate(cwd, state.runId);
    expect(loaded!.estimateId).toBe('est-v2');
    // P9: 无任何 tmp 残留
    const { readdirSync } = awaitFs();
    const runDirPath = runDir(cwd, state.runId);
    const residualTmps = readdirSync(runDirPath).filter((f: string) => f.endsWith('.tmp'));
    expect(residualTmps).toEqual([]);
  });

  // ====================================================================
  // P9 Regression A — EPERM 一次后成功
  // ====================================================================
  it('P9-A: EPERM 一次后 rename 成功，attempts=2', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-p9a-'));
    const target = path.join(tmpDir, 'state.json');
    const tmp = target + '.42368.0.tmp';
    writeFileSync(tmp, 'updated content', 'utf8');

    let calls = 0;
    const renameFn = (_t: string, _d: string) => {
      calls += 1;
      if (calls === 1) {
        const err: any = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      // Success on attempt 2
    };

    _atomicRenameWithRetry(tmp, target, renameFn);
    expect(calls).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ====================================================================
  // P9 Regression B — 连续 EPERM 后成功
  // ====================================================================
  it('P9-B: 连续 EPERM ×2 后第三次成功，backoff 生效', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-p9b-'));
    const target = path.join(tmpDir, 'state.json');
    const tmp = target + '.42368.0.tmp';
    writeFileSync(tmp, 'content', 'utf8');

    let calls = 0;
    const renameFn = (_t: string, _d: string) => {
      calls += 1;
      if (calls <= 2) {
        const err: any = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }
    };

    _atomicRenameWithRetry(tmp, target, renameFn);
    expect(calls).toBe(3);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ====================================================================
  // P9 Regression C — EPERM 永久失败
  // ====================================================================
  it('P9-C: 所有 attempts EPERM → StatePersistenceError', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-p9c-'));
    const target = path.join(tmpDir, 'state.json');
    const tmp = target + '.42368.0.tmp';
    writeFileSync(tmp, 'content', 'utf8');

    const renameFn = () => {
      const err: any = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    };

    expect(() => _atomicRenameWithRetry(tmp, target, renameFn)).toThrow(StatePersistenceError);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ====================================================================
  // P9 Regression D — 非 transient filesystem error 不 retry
  // ====================================================================
  it('P9-D: ENOSPC 不 retry，直接透传', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-p9d-'));
    const target = path.join(tmpDir, 'state.json');
    const tmp = target + '.42368.0.tmp';
    writeFileSync(tmp, 'content', 'utf8');

    let calls = 0;
    const renameFn = () => {
      calls += 1;
      const err: any = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    };

    expect(() => _atomicRenameWithRetry(tmp, target, renameFn)).toThrow();
    expect(calls).toBe(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ====================================================================
  // P9 Regression E — unique temp，连续保存无 collision
  // ====================================================================
  it('P9-E: 连续两次 saveRunState temp path 不冲突，最终内容为最后一次合法内容，无 tmp 残留', () => {
    const state = createRunState(cwd, 'r-e', 'task E', 'custom');
    state.taskDescription = 'first';
    saveRunState(cwd, state);
    expect(loadRunState(cwd, state.runId).taskDescription).toBe('first');

    state.taskDescription = 'second';
    saveRunState(cwd, state);
    expect(loadRunState(cwd, state.runId).taskDescription).toBe('second');

    // 无 tmp 残留
    const { readdirSync } = awaitFs();
    const runDirPath = runDir(cwd, state.runId);
    const residualTmps = readdirSync(runDirPath).filter((f: string) => f.endsWith('.tmp'));
    expect(residualTmps).toEqual([]);
  });

  // ====================================================================
  // P9 — StatePersistenceError 结构化字段
  // ====================================================================
  it('P9: StatePersistenceError 包含脱敏字段 (operation/errorCode/attempts)', () => {
    const err = new StatePersistenceError({
      operation: 'rename',
      file: 'state.json',
      errorCode: 'EPERM',
      attempts: 5,
    });
    expect(err.name).toBe('StatePersistenceError');
    expect(err.operation).toBe('rename');
    expect(err.file).toBe('state.json');
    expect(err.errorCode).toBe('EPERM');
    expect(err.attempts).toBe(5);
    expect(err.message).toContain('5 attempts');
    expect(err.message).toContain('EPERM');
  });
});

/**
 * Small helper to avoid dynamic require() in vitest.
 * Returns the node:fs module with renameSync mutable for mocking.
 */
function awaitFs(): typeof import('node:fs') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:fs');
}
