/** cost.spec.ts —— 人民币费用计算测试 */
import { describe, it, expect } from 'vitest';
import { computeCostRmbFromPricing, computePricingDecision, safeComputeCost } from './cost';
import type { RawProviderUsage, ModelPricing } from './types';

const samplePricing: ModelPricing = {
  inputPerMTokens: 1.0,
  outputPerMTokens: 2.0,
  cacheCreationPerMTokens: 1.25,
  cacheReadPerMTokens: 0.1,
  currency: 'CNY',
  source: 'test',
  updatedAt: '2026-08-04',
};

const contextTieredPricing: ModelPricing = {
  pricingType: 'context-tiered',
  thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
  tiers: [{
    id: 'context-up-to-200k',
    fromInclusive: 0,
    upToInclusive: 200_000,
    rates: {
      inputPerMTokens: 2,
      outputPerMTokens: 6,
      cacheCreationPerMTokens: 0,
      cacheReadPerMTokens: 0.3,
    },
  }, {
    id: 'context-over-200k',
    fromInclusive: 200_001,
    upToInclusive: null,
    rates: {
      inputPerMTokens: 4,
      outputPerMTokens: 12,
      cacheCreationPerMTokens: 0,
      cacheReadPerMTokens: 0.6,
    },
  }],
  currency: 'CNY',
  source: 'provider-a enterprise pricing',
  updatedAt: '2026-08-17',
};

describe('computeCostRmbFromPricing', () => {
  // 30. 费用公式正确
  it('calculates cost correctly for complete usage', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1_000_000,    // 1.0 * 1.0 = 1.0
      outputTokens: 500_000,     // 0.5 * 2.0 = 1.0
      cacheCreationInputTokens: 200_000, // 0.2 * 1.25 = 0.25
      cacheReadInputTokens: 100_000,     // 0.1 * 0.1 = 0.01
    };
    const cost = computeCostRmbFromPricing(usage, samplePricing);
    expect(cost).toBeCloseTo(1.0 + 1.0 + 0.25 + 0.01, 6);
  });

  // 31. CNY 精度测试
  it('preserves sufficient precision for small token counts', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1,  // 1 / 1_000_000 * 1.0 = 0.000001
      outputTokens: 1, // 1 / 1_000_000 * 2.0 = 0.000002
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const cost = computeCostRmbFromPricing(usage, samplePricing);
    expect(cost).toBeCloseTo(0.000003, 8);
  });

  // 32. 内部保存 number，不提前格式化字符串
  it('returns a number, not a string', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const cost = computeCostRmbFromPricing(usage, samplePricing);
    expect(typeof cost).toBe('number');
  });

  it('handles null tokens as 0 in calculation', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1000,
      outputTokens: null,   // treated as 0
      cacheCreationInputTokens: null, // treated as 0
      cacheReadInputTokens: null,     // treated as 0
    };
    const cost = computeCostRmbFromPricing(usage, samplePricing);
    expect(cost).toBeCloseTo(0.001, 6); // only inputTokens contributes
  });

  it('calculates zero cost for all-zero tokens', () => {
    const usage: RawProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const cost = computeCostRmbFromPricing(usage, samplePricing);
    expect(cost).toBe(0);
  });
});

describe('safeComputeCost', () => {
  it('returns ok with cost when all tokens present and pricing exists', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const result = safeComputeCost(usage, samplePricing);
    expect(result.ok).toBe(true);
    expect(result.cost).toBeDefined();
  });

  it('returns MISSING_TOKENS when any token field is null', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1000,
      outputTokens: null,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const result = safeComputeCost(usage, samplePricing);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('MISSING_TOKENS');
  });

  it('returns MISSING_PRICING when pricing is undefined', () => {
    const usage: RawProviderUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const result = safeComputeCost(usage, undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('MISSING_PRICING');
  });

  it('returns MISSING_TOKENS for all-null usage', () => {
    const usage: RawProviderUsage = {
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const result = safeComputeCost(usage, samplePricing);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('MISSING_TOKENS');
  });
});

describe('context-tiered pricing', () => {
  function decision(inputTokens: number, outputTokens = 1_000, cacheReadInputTokens = 0) {
    return computePricingDecision({
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens,
    }, contextTieredPricing);
  }

  it.each([
    [199_999, 'context-up-to-200k', 2, 6],
    [200_000, 'context-up-to-200k', 2, 6],
    [200_001, 'context-over-200k', 4, 12],
  ] as const)('selects the exact boundary tier for %i request context tokens', (
    inputTokens,
    tierId,
    inputRate,
    outputRate,
  ) => {
    const result = decision(inputTokens);
    expect(result.pricingTierId).toBe(tierId);
    expect(result.requestContextTokens).toBe(inputTokens);
    expect(result.appliedRates?.inputPerMTokens).toBe(inputRate);
    expect(result.appliedRates?.outputPerMTokens).toBe(outputRate);
    expect(result.cost).toBeCloseTo(
      (inputTokens / 1_000_000) * inputRate
      + (1_000 / 1_000_000) * outputRate,
      12,
    );
  });

  it('includes cache read in request context while billing it separately from ordinary input', () => {
    const result = decision(150_000, 1_000, 60_001);
    expect(result.requestContextTokens).toBe(210_001);
    expect(result.pricingTierId).toBe('context-over-200k');
    expect(result.cost).toBeCloseTo(
      (150_000 / 1_000_000) * 4
      + (60_001 / 1_000_000) * 0.6
      + (1_000 / 1_000_000) * 12,
      12,
    );
  });

  it('does not include output in the threshold and applies one request tier to output', () => {
    const largeOutput = decision(100_000, 150_000);
    expect(largeOutput.pricingTierId).toBe('context-up-to-200k');
    expect(largeOutput.appliedRates?.outputPerMTokens).toBe(6);

    const smallHighTierOutput = decision(250_000, 1);
    expect(smallHighTierOutput.pricingTierId).toBe('context-over-200k');
    expect(smallHighTierOutput.appliedRates?.outputPerMTokens).toBe(12);
  });

  it('keeps cache creation as an explicit zero rate in every tier', () => {
    expect(decision(200_000).appliedRates?.cacheCreationPerMTokens).toBe(0);
    expect(decision(200_001).appliedRates?.cacheCreationPerMTokens).toBe(0);
  });

  it('fails honest when request context tokens are unavailable even if output is known', () => {
    const usage: RawProviderUsage = {
      inputTokens: null,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: null,
    };
    const result = computePricingDecision(usage, contextTieredPricing);
    expect(result).toMatchObject({
      cost: null,
      pricingTierId: null,
      requestContextTokens: null,
      reason: 'PRICING_CONTEXT_TOKENS_UNAVAILABLE',
    });
    expect(safeComputeCost(usage, contextTieredPricing)).toMatchObject({
      ok: false,
      reason: 'PRICING_CONTEXT_TOKENS_UNAVAILABLE',
    });
  });
});
