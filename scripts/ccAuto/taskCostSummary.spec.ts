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
  usageRecords: Array<{ usage: UsageRecord; role: any; provider: string; modelLogicalName: string; callId?: string }>,
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
    // P7 语义变更：null → "无法计算"，不再输出裸"不可核验"
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: null }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
    ]);
    expect(summary.actual.costRmb).toBeNull();
    expect(formatCostRmbOrUnknown(summary.actual.costRmb)).toBe('无法计算');
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
      { usage: fakeUsage({ costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash', callId: 'call-f1' },
      { usage: fakeUsage({ costRmbCustom: 0.02 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-p1' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV, escalatedFromCallId: 'call-f1' },
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
      { usage: fakeUsage({ costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash', callId: 'call-f1' },
      { usage: fakeUsage({ costRmbCustom: 0.02 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-p1' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV, escalatedFromCallId: 'call-f1' },
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

  it('Flash 同 role 两次调用，第二次失败升级，成本归因到第二次', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.001 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash', callId: 'call-f1' },
      { usage: fakeUsage({ costRmbCustom: 0.008 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash', callId: 'call-f2' },
      { usage: fakeUsage({ costRmbCustom: 0.03 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-p1' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV, escalatedFromCallId: 'call-f2' },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    // 升级只在 role 变化时计数：Flash→Pro 为 1 次
    expect(summary.routingEffect.escalationCount).toBe(1);
    // 应归因到 call-f2（最后一次 Flash 调用），成本 0.008
    // escalatedFromCallId='call-f2' 精确匹配 usageRecords 中 callId='call-f2' 的条目
    expect(summary.routingEffect.escalationCostRmb).toBeCloseTo(0.008);
  });

  it('Pro 同 role 多次调用不会取第一条 Usage', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-p1' },
      { usage: fakeUsage({ costRmbCustom: 0.02 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-p2' },
      { usage: fakeUsage({ costRmbCustom: 0.05 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash', callId: 'call-f1' },
    ], {
      selections: [
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'POLICY' as any, reasonCodes: ['MULTI_FILE_CHANGE'], policyVersion: PV },
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'ESCALATION' as any, reasonCodes: ['PRO_QUALITY_FAILURE'], policyVersion: PV, escalatedFromCallId: 'call-p2' },
      ],
      attempts: [
        { role: 'STRONG_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'FAST_EXECUTOR' as any },
      ],
    });
    // Pro→Flash 升级 1 次
    expect(summary.routingEffect.escalationCount).toBe(1);
    // escalatedFromCallId='call-p2' 精确归因到第二次 Pro（0.02），而非第一条 Usage（0.01）
    expect(summary.routingEffect.escalationCostRmb).toBeCloseTo(0.02);
  });

  it('无 callId 时 escalation cost 为 null 不猜测', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: null }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
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
    expect(summary.routingEffect.escalationCostRmb).toBeNull();
  });

  it('escalatedFromCallId 是真实 callId', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.005 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash', callId: 'call-real-f1' },
      { usage: fakeUsage({ costRmbCustom: 0.05 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-real-p1' },
    ], {
      selections: [
        { role: 'FAST_EXECUTOR' as any, provider: 'ds', profileId: 'f', modelLogicalName: 'flash', source: 'POLICY' as any, reasonCodes: ['DEFAULT_FLASH'], policyVersion: PV },
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'ESCALATION' as any, reasonCodes: ['FLASH_QUALITY_FAILURE'], policyVersion: PV, escalatedFromCallId: 'call-real-f1' },
      ],
      attempts: [
        { role: 'FAST_EXECUTOR' as any, failure: { category: 'MODEL_QUALITY_FAILURE' as any, summary: 'fail', contributedToFinalResult: false } },
        { role: 'STRONG_EXECUTOR' as any },
      ],
    });
    expect(summary.routingEffect.escalationCount).toBe(1);
    // 通过 escalatedFromCallId='call-real-f1' 精确归因到 0.005
    expect(summary.routingEffect.escalationCostRmb).toBeCloseTo(0.005);
  });

  it('ARBITER Capsule 无真实调用时不产生假 callId', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro', callId: 'call-p-only' },
    ], {
      selections: [
        { role: 'STRONG_EXECUTOR' as any, provider: 'ds', profileId: 'p', modelLogicalName: 'pro', source: 'POLICY' as any, reasonCodes: ['MULTI_FILE_CHANGE'], policyVersion: PV },
        { role: 'ARBITER' as any, provider: 'anthropic', profileId: 'opus', modelLogicalName: 'opus-model', source: 'ESCALATION' as any, reasonCodes: ['OPUS_ARBITRATION'], policyVersion: PV },
      ],
      attempts: [
        { role: 'STRONG_EXECUTOR' as any },
        { role: 'ARBITER' as any },
      ],
    });
    // ARBITER 未真正调用（useRecords 只有 1 条 Pro），escalationCostRmb 为 null
    expect(summary.routingEffect.escalationCostRmb).toBeNull();
  });
});

// ============================================================================
// 格式化
// ============================================================================

describe('格式化', () => {
  it('formatCostRmbOrUnknown — null → 无法计算', () => {
    // P7 语义变更：null → "无法计算"，不再输出裸"不可核验"
    expect(formatCostRmbOrUnknown(null)).toBe('无法计算');
  });

  it('formatCostRmbOrUnknown — 正常值', () => {
    expect(formatCostRmbOrUnknown(0.25)).toContain('¥');
  });

  it('formatPercentOrNA — null → N/A', () => {
    expect(formatPercentOrNA(null)).toBe('N/A');
  });

  it('formatPercentOrNA — 正常值', () => {
    expect(formatPercentOrNA(0.5)).toBe('50.0%');
    expect(formatPercentOrNA(0.262)).toBe('26.2%');
    expect(formatPercentOrNA(1.0)).toBe('100.0%');
  });

  it('formatRoleName', () => {
    expect(formatRoleName('FAST_EXECUTOR')).toBe('V4 Flash');
    expect(formatRoleName('STRONG_EXECUTOR')).toBe('V4 Pro');
    expect(formatRoleName('ARBITER')).toBe('Opus 5');
    expect(formatRoleName('WRITER')).toBe('Writer');
  });
});

describe('Writer cost attribution', () => {
  it('Grok Writer cost 归入 WRITER，不落入 FAST_EXECUTOR', () => {
    const summary = makeSummary([
      {
        usage: fakeUsage({
          requestedModelId: 'grok-4.6',
          reportedModel: 'grok-4.6',
          providerId: 'apikey-grok-4-6',
          costRmbCustom: 0.0203,
        }),
        role: 'WRITER',
        provider: 'apikey-grok-4-6',
        modelLogicalName: 'grok-4-6-writer',
      },
    ]);
    const writer = summary.byRole.find((e) => e.role === 'WRITER');
    const flash = summary.byRole.find((e) => e.role === 'FAST_EXECUTOR');
    expect(writer).toBeTruthy();
    expect(writer!.costRmb).toBeCloseTo(0.0203);
    expect(writer!.modelLogicalName).toBe('grok-4-6-writer');
    expect(flash).toBeUndefined();
  });

  it('FAST / STRONG / ARBITER 路径仍各自归入历史 lane', () => {
    const summary = makeSummary([
      { usage: fakeUsage({ costRmbCustom: 0.01 }), role: 'FAST_EXECUTOR', provider: 'ds', modelLogicalName: 'flash' },
      { usage: fakeUsage({ costRmbCustom: 0.02 }), role: 'STRONG_EXECUTOR', provider: 'ds', modelLogicalName: 'pro' },
      { usage: fakeUsage({ costRmbCustom: 0.03 }), role: 'ARBITER', provider: 'anthropic', modelLogicalName: 'opus' },
    ]);
    expect(summary.byRole.find((e) => e.role === 'FAST_EXECUTOR')?.costRmb).toBeCloseTo(0.01);
    expect(summary.byRole.find((e) => e.role === 'STRONG_EXECUTOR')?.costRmb).toBeCloseTo(0.02);
    expect(summary.byRole.find((e) => e.role === 'ARBITER')?.costRmb).toBeCloseTo(0.03);
    expect(summary.byRole.find((e) => e.role === 'WRITER')).toBeUndefined();
  });
});
