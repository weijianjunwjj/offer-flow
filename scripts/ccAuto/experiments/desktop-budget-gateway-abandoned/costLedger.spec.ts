/**
 * costLedger 测试：四类 Token 人民币费用、百分比合计 100%、零费用、未知模型、缺失 usage。
 */
import { describe, expect, it } from 'vitest';
import { customRmbCostBreakdown, computeCallCost, lookupPricing } from './costLedger';
import { DEFAULT_GATEWAY_CONFIG } from './gatewayConfig';
import type { GatewayConfig } from './gatewayConfig';

function testConfig(): GatewayConfig {
  return {
    ...DEFAULT_GATEWAY_CONFIG,
    modelPricing: {
      'deepseek-v4-pro': { inputPerMTokens: 1.40, outputPerMTokens: 7.00, cacheCreationPerMTokens: 1.75, cacheReadPerMTokens: 0.14 },
      'deepseek-v4-flash': { inputPerMTokens: 0.70, outputPerMTokens: 3.50, cacheCreationPerMTokens: 0.88, cacheReadPerMTokens: 0.07 },
      'claude-sonnet-5': { inputPerMTokens: 1.40, outputPerMTokens: 7.00, cacheCreationPerMTokens: 1.75, cacheReadPerMTokens: 0.14 },
      'claude-haiku-4-5': { inputPerMTokens: 0.70, outputPerMTokens: 3.50, cacheCreationPerMTokens: 0.88, cacheReadPerMTokens: 0.07 },
      'claude-opus-5': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
    },
  };
}

// === 测试项 1–6：四类 Token 费用 + DeepSeek 模型 ===

describe('customRmbCostBreakdown：四项 Token 人民币费用', () => {
  const config = testConfig();

  it('test-1：仅 input tokens 费用正确（DeepSeek V4 Pro 1M input = ¥1.40）', () => {
    const pricing = config.modelPricing['deepseek-v4-pro'];
    const result = customRmbCostBreakdown(
      { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      pricing,
    );
    expect(result.inputCostRmb).toBeCloseTo(1.40);
    expect(result.outputCostRmb).toBe(0);
    expect(result.totalCostRmb).toBeCloseTo(1.40);
    expect(result.inputPercent).toBeCloseTo(100);
  });

  it('test-2：仅 output tokens 费用正确（DeepSeek V4 Pro 1M output = ¥7.00）', () => {
    const pricing = config.modelPricing['deepseek-v4-pro'];
    const result = customRmbCostBreakdown(
      { inputTokens: 0, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      pricing,
    );
    expect(result.outputCostRmb).toBeCloseTo(7.00);
    expect(result.outputPercent).toBeCloseTo(100);
  });

  it('test-3：仅 cache creation tokens 费用正确', () => {
    const pricing = config.modelPricing['deepseek-v4-pro'];
    const result = customRmbCostBreakdown(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 0 },
      pricing,
    );
    expect(result.cacheCreationCostRmb).toBeCloseTo(1.75);
  });

  it('test-4：仅 cache read tokens 费用正确', () => {
    const pricing = config.modelPricing['deepseek-v4-pro'];
    const result = customRmbCostBreakdown(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 },
      pricing,
    );
    expect(result.cacheReadCostRmb).toBeCloseTo(0.14);
  });

  it('test-5：百分比合计为 100%（四舍五入到小数一位后修复）', () => {
    const pricing = config.modelPricing['deepseek-v4-pro'];
    // 各项费用不等比例的场景
    const result = customRmbCostBreakdown(
      { inputTokens: 200_000, outputTokens: 50_000, cacheCreationInputTokens: 100_000, cacheReadInputTokens: 1_000_000 },
      pricing,
    );
    const sum = result.inputPercent + result.outputPercent + result.cacheCreationPercent + result.cacheReadPercent;
    expect(sum).toBeCloseTo(100, 0);
  });

  it('test-6：总费用为 0 时不产生 NaN 百分比', () => {
    const pricing = config.modelPricing['deepseek-v4-pro'];
    const result = customRmbCostBreakdown(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      pricing,
    );
    expect(result.totalCostRmb).toBe(0);
    expect(isNaN(result.inputPercent)).toBe(false);
    expect(isNaN(result.outputPercent)).toBe(false);
    expect(isNaN(result.cacheCreationPercent)).toBe(false);
    expect(isNaN(result.cacheReadPercent)).toBe(false);
    expect(result.inputPercent).toBe(0);
    expect(result.outputPercent).toBe(0);
  });

  it('test-7：DeepSeek V4 Flash 混合 token 费用正确', () => {
    const pricing = config.modelPricing['deepseek-v4-flash'];
    const result = customRmbCostBreakdown(
      { inputTokens: 100_000, outputTokens: 20_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 50_000 },
      pricing,
    );
    expect(result.inputCostRmb).toBeCloseTo(0.07); // 100k/1M * 0.70
    expect(result.outputCostRmb).toBeCloseTo(0.07); // 20k/1M * 3.50
    expect(result.cacheReadCostRmb).toBeCloseTo(0.0035); // 50k/1M * 0.07
  });

  it('test-8：原第三方实际模型（claude-sonnet-5）费用正确', () => {
    const pricing = config.modelPricing['claude-sonnet-5'];
    const result = customRmbCostBreakdown(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      pricing,
    );
    expect(result.inputCostRmb).toBeCloseTo(1.40);
    expect(result.outputCostRmb).toBeCloseTo(7.00);
    expect(result.totalCostRmb).toBeCloseTo(8.40);
  });
});

// === 测试项 9–10：未知模型、缺失 usage ===

describe('computeCallCost：错误处理', () => {
  const config = testConfig();

  it('test-9：未知模型 ID 返回 PRICING_NOT_FOUND', () => {
    const result = computeCallCost('unknown-model-xyz', {
      inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('PRICING_NOT_FOUND');
    }
  });

  it('test-10：缺失 usage 字段返回 MISSING_USAGE', () => {
    const result = computeCallCost('deepseek-v4-pro', {}, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('MISSING_USAGE');
    }
  });

  it('个别 usage 字段为 0 时仍可正常计算', () => {
    const result = computeCallCost('deepseek-v4-pro', {
      inputTokens: 1000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    }, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokenEstimatedCostRmb).toBeGreaterThan(0);
    }
  });
});

describe('lookupPricing', () => {
  const config = testConfig();

  it('已知模型返回 ok:true', () => {
    expect(lookupPricing('deepseek-v4-pro', config).ok).toBe(true);
    expect(lookupPricing('claude-haiku-4-5', config).ok).toBe(true);
  });

  it('未知模型返回 ok:false 并携带模型 ID', () => {
    const result = lookupPricing('no-such-model', config);
    expect(result.ok).toBe(false);
    expect(result.unknownModelId).toBe('no-such-model');
  });
});
