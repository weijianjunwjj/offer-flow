/** cost.spec.ts —— 人民币费用计算测试 */
import { describe, it, expect } from 'vitest';
import { computeCostRmbFromPricing, safeComputeCost } from './cost';
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
