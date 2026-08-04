/** usage.spec.ts —— Usage null 语义测试 */
import { describe, it, expect } from 'vitest';
import { classifyUsage, determineCostStatus, buildUsageRecord, formatCostRmb } from './usage';
import type { RawProviderUsage } from './types';

function makeUsage(overrides: Partial<Record<keyof RawProviderUsage, number | null>>): RawProviderUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  };
}

describe('classifyUsage', () => {
  // 21. 完整 usage → AVAILABLE
  it('classifies complete usage as AVAILABLE', () => {
    const raw = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    const result = classifyUsage(raw);
    expect(result.usageStatus).toBe('AVAILABLE');
    expect(result.missingTokenFields).toEqual([]);
  });

  // 22. 全部缺失 → MISSING
  it('classifies all-null usage as MISSING', () => {
    const raw = makeUsage({
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    const result = classifyUsage(raw);
    expect(result.usageStatus).toBe('MISSING');
    expect(result.missingTokenFields).toEqual([
      'inputTokens',
      'outputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
    ]);
  });

  // 23. 部分缺失 → PARTIAL
  it('classifies partial-null usage as PARTIAL', () => {
    const raw = makeUsage({
      inputTokens: 1000,
      outputTokens: null,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: null,
    });
    const result = classifyUsage(raw);
    expect(result.usageStatus).toBe('PARTIAL');
    expect(result.missingTokenFields).toContain('outputTokens');
    expect(result.missingTokenFields).toContain('cacheReadInputTokens');
  });

  // 24. Token=0 保留 0
  it('preserves 0 token counts', () => {
    const raw = makeUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    const result = classifyUsage(raw);
    expect(result.usageStatus).toBe('AVAILABLE'); // 0 不是 null
    expect(raw.inputTokens).toBe(0);
    expect(raw.outputTokens).toBe(0);
  });

  // 25. null 不转为 0
  it('does not convert null to 0 in classification', () => {
    const raw: RawProviderUsage = {
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const result = classifyUsage(raw);
    expect(result.usageStatus).toBe('MISSING');
    // 原始值仍是 null
    expect(raw.inputTokens).toBeNull();
  });
});

describe('determineCostStatus', () => {
  // 26. usage 非完整 → COST_UNAVAILABLE（保守规则）
  it('returns UNAVAILABLE when usage is not AVAILABLE', () => {
    expect(determineCostStatus('MISSING')).toBe('UNAVAILABLE');
    expect(determineCostStatus('PARTIAL')).toBe('UNAVAILABLE');
  });

  it('returns AVAILABLE only when usage is AVAILABLE', () => {
    expect(determineCostStatus('AVAILABLE')).toBe('AVAILABLE');
  });
});

describe('buildUsageRecord', () => {
  const baseInput = {
    model: 'builder' as const,
    requestedModelId: 'deepseek-chat',
    reportedModel: 'deepseek-chat',
    providerId: 'ds',
    modelIdentityStatus: 'VERIFIED' as const,
    rawUsage: makeUsage({}),
    pricingStatus: 'PRICED' as const,
    costRmbCustom: 0.0035,
    costRmbOfficial: 0.0005,
    durationMs: 1200,
    numTurns: 3,
    subtype: 'success',
    isError: false,
  };

  it('builds a complete UsageRecord', () => {
    const record = buildUsageRecord(baseInput);
    expect(record.model).toBe('builder');
    expect(record.usageStatus).toBe('AVAILABLE');
    expect(record.costStatus).toBe('AVAILABLE');
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(500);
    expect(record.costRmbCustom).toBe(0.0035);
    expect(record.toolUseCounts).toBeNull();
    expect(record.permissionDenialsCount).toBe(0);
  });

  it('preserves null for missing token fields in UsageRecord', () => {
    const input = {
      ...baseInput,
      rawUsage: makeUsage({ inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null }),
    };
    const record = buildUsageRecord(input);
    expect(record.inputTokens).toBeNull();
    expect(record.outputTokens).toBeNull();
    expect(record.usageStatus).toBe('MISSING');
    expect(record.costStatus).toBe('UNAVAILABLE');
  });

  it('preserves null cost in UsageRecord', () => {
    const input = { ...baseInput, costRmbCustom: null, pricingStatus: 'UNPRICED' as const };
    const record = buildUsageRecord(input);
    expect(record.costRmbCustom).toBeNull();
    expect(record.pricingStatus).toBe('UNPRICED');
  });

  it('UNVERIFIED forces costStatus=UNAVAILABLE even when usage is AVAILABLE', () => {
    const input = {
      ...baseInput,
      modelIdentityStatus: 'UNVERIFIED' as const,
      reportedModel: null,
      pricingStatus: 'PRICED' as const,
      costRmbCustom: null,
    };
    const record = buildUsageRecord(input);
    expect(record.modelIdentityStatus).toBe('UNVERIFIED');
    expect(record.usageStatus).toBe('AVAILABLE');
    // costStatus 必须为 UNAVAILABLE——实际计费模型无法确认
    expect(record.costStatus).toBe('UNAVAILABLE');
    expect(record.costRmbCustom).toBeNull();
  });

  it('UNPRICED always yields costStatus=UNAVAILABLE', () => {
    const input = {
      ...baseInput,
      modelIdentityStatus: 'VERIFIED' as const,
      pricingStatus: 'UNPRICED' as const,
      costRmbCustom: null,
    };
    const record = buildUsageRecord(input);
    expect(record.usageStatus).toBe('AVAILABLE');
    expect(record.pricingStatus).toBe('UNPRICED');
    expect(record.costStatus).toBe('UNAVAILABLE');
  });
});

describe('formatCostRmb', () => {
  it('formats valid cost with CNY symbol', () => {
    expect(formatCostRmb(0.0035)).toBe('¥0.003500');
  });

  it('formats zero cost correctly', () => {
    expect(formatCostRmb(0)).toBe('¥0.000000');
  });

  // 34. null 费用不显示为 ¥0.00
  it('returns a non-monetary placeholder for null cost', () => {
    const result = formatCostRmb(null);
    expect(result).not.toContain('¥');
    expect(result).not.toContain('0.00');
    expect(result).toBe('(无法计算)');
  });
});
