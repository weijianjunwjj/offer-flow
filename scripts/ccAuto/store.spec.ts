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
    // 新字段为 optional，loadRunState 不应抛异常
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
    // 模拟老格式：移除新字段后保存
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

describe('持久化 — 原子保存', () => {
  it('saveRunState 使用临时文件+rename 原子写', () => {
    const state = createRunState(cwd, 'r-atomic', 'atomic', 'custom');
    const loaded = loadRunState(cwd, state.runId);
    expect(loaded.runId).toBe(state.runId);
    // 确认 state.json 存在（临时文件已 rename）
    const { existsSync } = require('node:fs');
    const statePath = path.join(runDir(cwd, state.runId), 'state.json');
    expect(existsSync(statePath)).toBe(true);
    // tmp 文件不应留下
    const tmpPath = statePath + '.tmp';
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('saveBudgetEstimate 使用原子机制（临时文件不留存）', () => {
    const state = createRunState(cwd, 'r-atomic2', 'atomic2', 'custom');
    saveBudgetEstimate(cwd, state.runId, fakeEstimate({ runId: state.runId }));
    saveBudgetEstimate(cwd, state.runId, fakeEstimate({ runId: state.runId, estimateId: 'est-v2' }));
    const loaded = loadBudgetEstimate(cwd, state.runId);
    expect(loaded!.estimateId).toBe('est-v2');
    // 没有 tmp 残留
    const { existsSync } = require('node:fs');
    expect(existsSync(path.join(runDir(cwd, state.runId), 'state.json.tmp'))).toBe(false);
  });
});
