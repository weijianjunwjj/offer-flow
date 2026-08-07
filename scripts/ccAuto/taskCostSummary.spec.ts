/** taskCostSummary.spec.ts — 任务成本复盘测试 */
import { describe, it, expect } from 'vitest';
import { buildTaskCostSummary, buildRunningCostSnapshot, formatCostRmbOrUnknown, formatPercentOrNA, formatRoleName } from './taskCostSummary';
import type { TaskBudgetEstimate, UsageRecord, ModelPricing } from './types';

// ============================================================================
// Fixtures
// ============================================================================

const PRO_PRICING: ModelPricing = {
  inputPerMTokens: 2.0, outputPerMTokens: 4.0,
  cacheCreationPerMTokens: 2.5, cacheReadPerMTokens: 0.2,
  currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
};

function fakeUsage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    model: 'builder',
    requestedModelId: 'deepseek-chat',
    reportedModel: 'deepseek-chat',
    providerId: 'deepseek-v4-flash',
    modelIdentityStatus: 'VERIFIED',
    pricingStatus: 'PRICED',
    usageStatus: 'AVAILABLE',
    costStatus: 'AVAILABLE',
    inputTokens: 5000,
    outputTokens: 2000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 500,
    costRmbCustom: 0.012,
    costRmbOfficial: null,
    durationMs: 2000,
    numTurns: 2,
    subtype: 'stop',
    isError: false,
    toolUseCounts: null,
    toolErrorCounts: null,
    permissionDenialsCount: 0,
    ...overrides,
  };
}

const PV = 'cc-auto-model-routing-v1' as const;

function fakeEstimate(): TaskBudgetEstimate {
  return {
    estimateId: 'est-test',
    runId: 'run-1', taskId: 'task-1',
    routingPolicyVersion: 'cc-auto-model-routing-v1',
    initialSelection: {
      role: 'FAST_EXECUTOR', provider: 'deepseek', profileId: 'f', modelLogicalName: 'flash',
      source: 'POLICY', reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV,
    },
    currency: 'CNY',
    estimatedCalls: [],
    totalEstimatedCostRmb: { min: 0.01, expected: 0.05, max: 0.5 },
    assumptions: [],
    createdAt: new Date().toISOString(),
  };
}

// ============================================================================
// RunningCostSnapshot
// ============================================================================

describe('buildRunningCostSnapshot — 运行中快照', () => {
  it('累计 input/output tokens', () => {
    const snapshot = buildRunningCostSnapshot({
      runId: 'r1', taskId: 't1', estimate: fakeEstimate(),
      usageRecords: [
        { usage: fakeUsage({ inputTokens: 5000, outputTokens: 2000 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      ],
    });
    expect(snapshot.actualInputTokens).toBe(5000);
    expect(snapshot.actualOutputTokens).toBe(2000);
    expect(snapshot.completedCallCount).toBe(1);
  });

  it('costRmb null 时 actualCostRmb 为 null', () => {
    const snapshot = buildRunningCostSnapshot({
      runId: 'r1', taskId: 't1', estimate: fakeEstimate(),
      usageRecords: [
        { usage: fakeUsage({ costRmbCustom: null }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      ],
    });
    expect(snapshot.actualCostRmb).toBeNull();
  });

  it('多条记录累计正确', () => {
    const snapshot = buildRunningCostSnapshot({
      runId: 'r1', taskId: 't1', estimate: fakeEstimate(),
      usageRecords: [
        { usage: fakeUsage({ inputTokens: 1000, outputTokens: 500, costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
        { usage: fakeUsage({ inputTokens: 2000, outputTokens: 800, costRmbCustom: 0.008 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      ],
    });
    expect(snapshot.actualInputTokens).toBe(3000);
    expect(snapshot.actualOutputTokens).toBe(1300);
    expect(snapshot.actualCostRmb).toBeCloseTo(0.013);
  });

  it('不同角色分开累计', () => {
    const snapshot = buildRunningCostSnapshot({
      runId: 'r1', taskId: 't1', estimate: fakeEstimate(),
      usageRecords: [
        { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
        { usage: fakeUsage({ costRmbCustom: 0.05 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
      ],
    });
    expect(snapshot.costByRole['FAST_EXECUTOR']?.costRmb).toBeCloseTo(0.01);
    expect(snapshot.costByRole['STRONG_EXECUTOR']?.costRmb).toBeCloseTo(0.05);
  });
});

// ============================================================================
// TaskCostSummary
// ============================================================================

function makeSummary(
  usageRecords: Array<{ usage: UsageRecord; role: any; provider: string; modelLogicalName: string }>,
  overrides: Partial<Parameters<typeof buildTaskCostSummary>[0]> = {},
) {
  return buildTaskCostSummary({
    runId: 'r1', taskId: 't1', estimate: fakeEstimate(),
    usageRecords,
    selections: overrides.selections ?? [{ role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV }],
    attempts: overrides.attempts ?? [{ role: 'FAST_EXECUTOR' as any }],
    completed: overrides.completed ?? true,
    strongModelPricing: overrides.strongModelPricing !== undefined ? overrides.strongModelPricing : PRO_PRICING,
    strongModelLogicalName: 'pro',
  });
}

describe('buildTaskCostSummary — 成本总结', () => {
  it('单次 Flash 汇总', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ inputTokens: 5000, outputTokens: 2000, costRmbCustom: 0.012 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.totalCalls).toBe(1);
    expect(summary.actual.totalTokens).toBe(7000);
    expect(summary.actual.costRmb).toBeCloseTo(0.012);
    expect(summary.completed).toBe(true);
  });

  it('单次 Pro 汇总', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.05 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], { selections: [{ role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'POLICY' as any, reasonCodes: ['MULTI_FILE_CHANGE'], policyVersion: PV }] });
    expect(summary.actual.totalCalls).toBe(1);
    expect(summary.actual.costRmb).toBeCloseTo(0.05);
  });

  it('Flash→Pro 独立 Usage', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ costRmbCustom: 0.05 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    expect(summary.actual.totalCalls).toBe(2);
    expect(summary.byRole.length).toBeGreaterThanOrEqual(1);
  });

  it('各模型 Token 占比', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ inputTokens: 3000, outputTokens: 1000, costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ inputTokens: 6000, outputTokens: 2000, costRmbCustom: 0.015 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    const flashEntry = summary.byRole.find((e) => e.role === 'FAST_EXECUTOR');
    const proEntry = summary.byRole.find((e) => e.role === 'STRONG_EXECUTOR');
    expect(flashEntry).toBeDefined();
    expect(proEntry).toBeDefined();
    expect(flashEntry!.tokenShare).toBeGreaterThan(0);
    expect(proEntry!.tokenShare).toBeGreaterThan(0);
  });

  it('各模型成本占比', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.006 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ costRmbCustom: 0.014 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    const flashEntry = summary.byRole.find((e) => e.role === 'FAST_EXECUTOR');
    const proEntry = summary.byRole.find((e) => e.role === 'STRONG_EXECUTOR');
    expect(flashEntry!.costShare).toBeCloseTo(0.3, 1);
    expect(proEntry!.costShare).toBeCloseTo(0.7, 1);
  });

  it('actual/expected ratio', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.025 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.estimateComparison.actualVsExpectedRatio).not.toBeNull();
  });

  it('actual/max ratio', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.1 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.estimateComparison.actualVsMaximumRatio).not.toBeNull();
  });

  it('expected=0 时 ratio 为 null', () => {
    const zeroEst = { ...fakeEstimate(), totalEstimatedCostRmb: { min: 0, expected: 0, max: 0 } };
    const summary = buildTaskCostSummary({
      runId: 'r1', taskId: 't1', estimate: zeroEst,
      usageRecords: [{ usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' }],
      selections: [{ role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV }],
      attempts: [{ role: 'FAST_EXECUTOR' as any }],
      completed: true,
      strongModelPricing: PRO_PRICING, strongModelLogicalName: 'pro',
    });
    expect(summary.estimateComparison.actualVsExpectedRatio).toBeNull();
  });

  it('成本不可核验时标记正确', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: null }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.costRmb).toBeNull();
    expect(formatCostRmbOrUnknown(summary.actual.costRmb)).toBe('(不可核验)');
  });

  it('UNVERIFIED 模型 costRmb 为 null', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ modelIdentityStatus: 'UNVERIFIED', costRmbCustom: null, costStatus: 'UNAVAILABLE' }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.costRmb).toBeNull();
  });

  it('部分 cost 可用时整体 costRmb 为 null', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ costRmbCustom: null }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.costRmb).toBeNull();
  });

  it('任务失败仍生成总结', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ], { completed: false, attempts: [{ role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } }] });
    expect(summary.completed).toBe(false);
    expect(summary.actual.totalCalls).toBe(1);
  });

  it('totalTokens = input + output', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ inputTokens: 10000, outputTokens: 5000 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.totalTokens).toBe(15000);
  });

  it('cache Token 累计正确', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ cacheCreationInputTokens: 100, cacheReadInputTokens: 200 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.cachedTokens).toBe(300);
  });

  it('不产生 NaN/Infinity', () => {
    const summary = makeSummary([
      { usage: fakeUsage(), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    const json = JSON.stringify(summary);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });
});

// ============================================================================
// 节省效果
// ============================================================================

describe('节省效果', () => {
  it('hypotheticalAllProCostRmb > 实际 Flash 成本', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ inputTokens: 10000, outputTokens: 2000, costRmbCustom: 0.014 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.routingEffect.hypotheticalAllProCostRmb).toBeGreaterThan(summary.actual.costRmb!);
  });

  it('Flash savedVsAllPro > 0', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ inputTokens: 10000, outputTokens: 2000, costRmbCustom: 0.014 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.routingEffect.savedVsAllProRmb).toBeGreaterThan(0);
    expect(summary.routingEffect.savedVsAllProPercent).toBeGreaterThan(0);
  });

  it('无 Pro 价格时节省为 null', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ], { strongModelPricing: null });
    expect(summary.routingEffect.hypotheticalAllProCostRmb).toBeNull();
    expect(summary.routingEffect.savedVsAllProRmb).toBeNull();
    expect(summary.routingEffect.savedVsAllProPercent).toBeNull();
  });

  it('全程 Pro 时 savedVsAllPro = 0', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.028, inputTokens: 10000, outputTokens: 2000 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], { selections: [{ role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'POLICY' as any, reasonCodes: ['MULTI_FILE_CHANGE'], policyVersion: PV }] });
    expect(summary.routingEffect.savedVsAllProRmb).toBeCloseTo(0);
  });

  it('无 Opus Usage 时 opusCostShare 为 null', () => {
    const summary = makeSummary([
      { usage: fakeUsage(), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.routingEffect.opusCostShare).toBeNull();
  });
});

// ============================================================================
// 升级成本
// ============================================================================

describe('升级成本', () => {
  it('失败 Flash 成本计入 escalationCostRmb', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ costRmbCustom: 0.02 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    expect(summary.routingEffect.escalationCount).toBe(1);
    expect(summary.routingEffect.escalationCostRmb).toBeCloseTo(0.005);
  });

  it('contributedToFinalResult=true 不计入升级成本', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ costRmbCustom: 0.02 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: true } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    expect(summary.routingEffect.escalationCount).toBe(1);
    // contributed=true → escalation cost is at 0 (no waste)
    expect(summary.routingEffect.escalationCostRmb).toBeNull();
  });

  it('无升级时 escalationCount=0', () => {
    const summary = makeSummary([
      { usage: fakeUsage(), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.routingEffect.escalationCount).toBe(0);
  });
});

// ============================================================================
// 格式化
// ============================================================================

describe('格式化', () => {
  it('formatCostRmbOrUnknown — null → (不可核验)', () => {
    expect(formatCostRmbOrUnknown(null)).toBe('(不可核验)');
  });

  it('formatCostRmbOrUnknown — 正常值', () => {
    expect(formatCostRmbOrUnknown(0.25)).toContain('¥');
  });

  it('formatPercentOrNA — null → N/A', () => {
    expect(formatPercentOrNA(null)).toBe('N/A');
  });

  it('formatPercentOrNA — 正常值', () => {
    expect(formatPercentOrNA(50)).toContain('%');
  });

  it('formatRoleName', () => {
    expect(formatRoleName('FAST_EXECUTOR')).toBe('V4 Flash');
    expect(formatRoleName('STRONG_EXECUTOR')).toBe('V4 Pro');
    expect(formatRoleName('ARBITER')).toBe('Opus 5');
  });
});
