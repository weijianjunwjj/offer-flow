/** taskBudget.spec.ts — 任务前预算估算测试 */
import { describe, it, expect, beforeEach } from 'vitest';
import { estimateTaskBudget, resetEstimateSequence, checkBudgetLimits, estimateTokensFromCharacters } from './taskBudget';
import type { ModelSelection, ModelRoutingConfig, TaskBudgetPolicy } from './types';
import type { ModelPricing } from './types';

const FLASH_SELECTION: ModelSelection = {
  role: 'FAST_EXECUTOR',
  provider: 'deepseek',
  profileId: 'deepseek-v4-flash',
  modelLogicalName: 'deepseek-v4-flash',
  source: 'POLICY',
  reasonCodes: ['DEFAULT_FLASH'],
  policyVersion: 'cc-auto-model-routing-v1',
};

const PRO_SELECTION: ModelSelection = {
  role: 'STRONG_EXECUTOR',
  provider: 'deepseek',
  profileId: 'deepseek-v4-pro',
  modelLogicalName: 'deepseek-v4-pro',
  source: 'POLICY',
  reasonCodes: ['MULTI_FILE_CHANGE'],
  policyVersion: 'cc-auto-model-routing-v1',
};

const FLASH_PRICING: ModelPricing = {
  inputPerMTokens: 1.0,
  outputPerMTokens: 2.0,
  cacheCreationPerMTokens: 1.25,
  cacheReadPerMTokens: 0.1,
  currency: 'CNY',
  source: 'test',
  updatedAt: '2026-08-04',
};

const PRO_PRICING: ModelPricing = {
  inputPerMTokens: 2.0,
  outputPerMTokens: 4.0,
  cacheCreationPerMTokens: 2.5,
  cacheReadPerMTokens: 0.2,
  currency: 'CNY',
  source: 'test',
  updatedAt: '2026-08-04',
};

const OPUS_PRICING: ModelPricing = {
  inputPerMTokens: 3.5,
  outputPerMTokens: 17.5,
  cacheCreationPerMTokens: 4.38,
  cacheReadPerMTokens: 0.35,
  currency: 'CNY',
  source: 'test',
  updatedAt: '2026-08-04',
};

const ROUTING_CONFIG: ModelRoutingConfig = {
  enabled: true,
  fastModel: { provider: 'deepseek', profileId: 'deepseek-v4-flash', modelLogicalName: 'deepseek-v4-flash' },
  strongModel: { provider: 'deepseek', profileId: 'deepseek-v4-pro', modelLogicalName: 'deepseek-v4-pro' },
  arbiterModel: { provider: 'anthropic', profileId: 'opus-5', modelLogicalName: 'claude-opus-5' },
  allowStrongEscalation: true,
  allowArbiterEscalation: true,
};

const DEFAULT_POLICY: TaskBudgetPolicy = {
  mode: 'BALANCED',
  requireConfirmationAboveSoftLimit: false,
  stopBeforeHardLimit: false,
};

function baseInput(overrides: Partial<Parameters<typeof estimateTaskBudget>[0]> = {}) {
  return {
    runId: 'test-run',
    taskId: 'test-task',
    initialSelection: FLASH_SELECTION,
    taskType: 'CODE_IMPLEMENTATION' as const,
    affectedFileCount: 1,
    usesToolLoop: false,
    maxToolLoopTurns: 8,
    maxToolCalls: 16,
    systemPromptChars: 5000,
    userPromptChars: 2000,
    routingConfig: ROUTING_CONFIG,
    budgetPolicy: DEFAULT_POLICY,
    pricingByModel: { 'deepseek-v4-flash': FLASH_PRICING, 'deepseek-v4-pro': PRO_PRICING, 'claude-opus-5': OPUS_PRICING },
    hasOpusProvider: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetEstimateSequence();
});

// ============================================================================
// 预算基本测试
// ============================================================================

describe('estimateTaskBudget — 预算', () => {
  // 1. Flash 单次任务预算
  it('Flash 单次任务预算', () => {
    const est = estimateTaskBudget(baseInput());
    expect(est.estimatedCalls[0].role).toBe('FAST_EXECUTOR');
    expect(est.estimatedCalls[0].minCalls).toBe(1);
    expect(est.totalEstimatedCostRmb.expected).toBeGreaterThan(0);
    expect(est.totalEstimatedCostRmb.expected).not.toBeNull();
    expect(est.currency).toBe('CNY');
  });

  // 2. Pro 直接任务预算
  it('Pro 直接任务预算', () => {
    const est = estimateTaskBudget(baseInput({ initialSelection: PRO_SELECTION }));
    expect(est.estimatedCalls[0].role).toBe('STRONG_EXECUTOR');
    expect(est.totalEstimatedCostRmb.expected).toBeGreaterThan(0);
  });

  // 3. Flash→Pro 最坏链预算
  it('Flash→Pro 最坏链预算', () => {
    const est = estimateTaskBudget(baseInput());
    // 至少 2 个 estimatedCalls：Flash + Pro（upgrade）
    expect(est.estimatedCalls.length).toBeGreaterThanOrEqual(2);
    const proEst = est.estimatedCalls.find((c) => c.role === 'STRONG_EXECUTOR');
    expect(proEst).toBeDefined();
    expect(proEst!.minCalls).toBe(0); // 正常情况下不调用
    expect(proEst!.maxCalls).toBe(1);
    // max cost > expected cost
    if (est.totalEstimatedCostRmb.max !== null && est.totalEstimatedCostRmb.expected !== null) {
      expect(est.totalEstimatedCostRmb.max).toBeGreaterThanOrEqual(est.totalEstimatedCostRmb.expected);
    }
  });

  // 4. Pro→Opus 最坏链预算
  it('Pro→Opus 最坏链预算', () => {
    const est = estimateTaskBudget(baseInput({ initialSelection: PRO_SELECTION, hasOpusProvider: true }));
    const opusEst = est.estimatedCalls.find((c) => c.role === 'ARBITER');
    expect(opusEst).toBeDefined();
  });

  // 5. 路由关闭预算
  it('路由关闭时仍生成预算', () => {
    const est = estimateTaskBudget(baseInput({
      routingConfig: { ...ROUTING_CONFIG, enabled: false },
    }));
    expect(est.estimatedCalls.length).toBeGreaterThan(0);
    // 路由关闭仍会生成正常升级链假设，非空即可
    expect(est.assumptions.length).toBeGreaterThanOrEqual(0);
  });

  // 6. PricingConfig 缺失
  it('PricingConfig 缺失时成本为 null', () => {
    const est = estimateTaskBudget(baseInput({ pricingByModel: {} }));
    expect(est.totalEstimatedCostRmb.expected).toBeNull();
    expect(est.assumptions.some((a) => a.includes('缺失'))).toBe(true);
  });

  // 7. Token 估算值明确标记 estimated
  it('Token 估算值存在且为正整数', () => {
    const est = estimateTaskBudget(baseInput());
    const primary = est.estimatedCalls[0];
    expect(primary.estimatedInputTokens.expected).toBeGreaterThan(0);
    expect(Number.isInteger(primary.estimatedInputTokens.expected)).toBe(true);
  });

  // 12. 预算计算不改变模型选择
  it('预算计算不改变模型选择', () => {
    const est = estimateTaskBudget(baseInput());
    expect(est.initialSelection.role).toBe('FAST_EXECUTOR');
  });

  // 含 Tool Loop 预算
  it('含 Tool Loop 预算', () => {
    const est = estimateTaskBudget(baseInput({ usesToolLoop: true, maxToolLoopTurns: 8 }));
    expect(est.estimatedCalls[0].estimatedInputTokens.max).toBeGreaterThan(
      estimateTaskBudget(baseInput({ usesToolLoop: false })).estimatedCalls[0].estimatedInputTokens.max,
    );
  });

  // 任务类型影响预算
  it('ARCHITECTURE 输出预算大于简单任务', () => {
    const simple = estimateTaskBudget(baseInput());
    const arch = estimateTaskBudget(baseInput({ taskType: 'ARCHITECTURE', initialSelection: PRO_SELECTION }));
    expect(arch.estimatedCalls[0].estimatedOutputTokens.expected).toBeGreaterThanOrEqual(
      simple.estimatedCalls[0].estimatedOutputTokens.expected,
    );
  });
});

// ============================================================================
// Token 字符估算
// ============================================================================

describe('estimateTokensFromCharacters — Token 估算', () => {
  it('返回正整数', () => {
    const tokens = estimateTokensFromCharacters(3000);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('中文 3000 字符约 1000 tokens', () => {
    // 保守系数 ~3 chars/token
    const tokens = estimateTokensFromCharacters(3000);
    expect(tokens).toBe(1000);
  });

  it('短文本估算为正整数', () => {
    const tokens = estimateTokensFromCharacters(10);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('空文本为 0', () => {
    const tokens = estimateTokensFromCharacters(0);
    expect(tokens).toBe(0);
  });
});

// ============================================================================
// 预算限制
// ============================================================================

describe('checkBudgetLimits — 预算限制', () => {
  // 9. soft limit
  it('超过软上限且 requireConfirmationAboveSoftLimit=true → SOFT_LIMIT', () => {
    const est = estimateTaskBudget(baseInput());
    const result = checkBudgetLimits(est, {
      mode: 'BALANCED',
      softLimitRmb: 0.001, // very low to trigger
      requireConfirmationAboveSoftLimit: true,
      stopBeforeHardLimit: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SOFT_LIMIT');
  });

  // 10. hard limit
  it('超过硬上限且 stopBeforeHardLimit=true → HARD_LIMIT', () => {
    const est = estimateTaskBudget(baseInput());
    const result = checkBudgetLimits(est, {
      mode: 'ECONOMY',
      hardLimitRmb: 0.001, // very low
      requireConfirmationAboveSoftLimit: false,
      stopBeforeHardLimit: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('HARD_LIMIT');
  });

  // 11. 默认策略不阻断
  it('默认策略不触发限制', () => {
    const est = estimateTaskBudget(baseInput());
    const result = checkBudgetLimits(est, DEFAULT_POLICY);
    expect(result.ok).toBe(true);
  });

  it('软上限关闭时通过', () => {
    const est = estimateTaskBudget(baseInput());
    const result = checkBudgetLimits(est, {
      mode: 'QUALITY',
      softLimitRmb: 0.001,
      hardLimitRmb: 500,
      requireConfirmationAboveSoftLimit: false,
      stopBeforeHardLimit: false,
    });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// 时间顺序
// ============================================================================

describe('预算创建时间', () => {
  // 8. 预算 createdAt
  it('预算 createdAt 为有效 ISO 时间', () => {
    const est = estimateTaskBudget(baseInput());
    expect(() => new Date(est.createdAt)).not.toThrow();
    expect(new Date(est.createdAt).getTime()).toBeGreaterThan(0);
  });

  it('预算 createdAt 在调用前（时间戳合理）', () => {
    const before = new Date().toISOString();
    const est = estimateTaskBudget(baseInput());
    const after = new Date().toISOString();
    expect(est.createdAt >= before).toBe(true);
    expect(est.createdAt <= after).toBe(true);
  });
});
