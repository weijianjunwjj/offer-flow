import { describe, expect, it } from 'vitest';
import { checkBudgetBeforeCall, customRmbCost, opusShare, summarizeUsage, usdToRmb } from './budget';
import { DEFAULT_CONFIG } from './config';
import type { CallUsage } from './types';

function call(model: CallUsage['model'], costRmb: number): CallUsage {
  return {
    callId: 'test-call',
    model, modelId: 'x', inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd: costRmb / DEFAULT_CONFIG.usdToRmbRate,
    costRmbOfficial: costRmb, costRmbCustom: costRmb, costRmb, durationMs: 0, numTurns: 1, pricingStatus: 'PRICED',
    subtype: 'success', isError: false, permissionDenialsCount: 0,
  };
}

describe('usdToRmb', () => {
  it('按配置汇率换算', () => {
    expect(usdToRmb(1, DEFAULT_CONFIG)).toBeCloseTo(DEFAULT_CONFIG.usdToRmbRate);
  });
});

describe('summarizeUsage / opusShare', () => {
  it('按角色累加费用', () => {
    const totals = summarizeUsage([call('scout', 1), call('builder', 5), call('arbiter', 2)]);
    expect(totals.totalRmb).toBeCloseTo(8);
    expect(totals.byModel.arbiter).toBeCloseTo(2);
  });

  it('opusShare 在无调用时为 0', () => {
    expect(opusShare(summarizeUsage([]))).toBe(0);
  });

  it('opusShare 计算占比', () => {
    const totals = summarizeUsage([call('builder', 8), call('arbiter', 2)]);
    expect(opusShare(totals)).toBeCloseTo(0.2);
  });
});

describe('checkBudgetBeforeCall', () => {
  it('未超任务/当日上限时放行', () => {
    const result = checkBudgetBeforeCall(10, 30, 50, 2, 5, 3);
    expect(result.exceeded).toBe(false);
  });

  it('超任务预算上限（取 min(taskBudget, absoluteMax)）时拦截', () => {
    const result = checkBudgetBeforeCall(10, 30, 50, 9, 5, 5);
    expect(result.exceeded).toBe(true);
    expect(result.reason).toBe('BUDGET_TASK_EXCEEDED');
  });

  it('超当日预算上限时拦截', () => {
    const result = checkBudgetBeforeCall(30, 30, 50, 1, 48, 5);
    expect(result.exceeded).toBe(true);
    expect(result.reason).toBe('BUDGET_DAILY_EXCEEDED');
  });
});

// 每个模型每 1M tokens 的人民币单价（第三方渠道价目表，与 config.ts customPricing 保持一致）。
const PRICE_TABLE: Record<string, { inputPerMTokens: number; outputPerMTokens: number; cacheCreationPerMTokens: number; cacheReadPerMTokens: number }> = {
  'claude-opus-5': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-opus-4-8': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-opus-4-7': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-opus-4-6': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-sonnet-5': { inputPerMTokens: 1.40, outputPerMTokens: 7.00, cacheCreationPerMTokens: 1.75, cacheReadPerMTokens: 0.14 },
  'claude-sonnet-4-6': { inputPerMTokens: 2.10, outputPerMTokens: 10.50, cacheCreationPerMTokens: 2.63, cacheReadPerMTokens: 0.21 },
  'claude-haiku-4-5': { inputPerMTokens: 0.70, outputPerMTokens: 3.50, cacheCreationPerMTokens: 0.88, cacheReadPerMTokens: 0.07 },
};

const ZERO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

describe('customRmbCost：按第三方渠道价目表逐模型、逐 token 类型校验', () => {
  for (const [modelId, rate] of Object.entries(PRICE_TABLE)) {
    describe(modelId, () => {
      it('仅 input tokens：1,000,000 tokens 应恰好收取 inputPerMTokens', () => {
        const result = customRmbCost(modelId, { ...ZERO_TOKENS, inputTokens: 1_000_000 }, DEFAULT_CONFIG);
        expect(result.ok).toBe(true);
        expect(result.cost).toBeCloseTo(rate.inputPerMTokens);
      });

      it('仅 output tokens：1,000,000 tokens 应恰好收取 outputPerMTokens', () => {
        const result = customRmbCost(modelId, { ...ZERO_TOKENS, outputTokens: 1_000_000 }, DEFAULT_CONFIG);
        expect(result.ok).toBe(true);
        expect(result.cost).toBeCloseTo(rate.outputPerMTokens);
      });

      it('仅 cacheCreation tokens：1,000,000 tokens 应恰好收取 cacheCreationPerMTokens', () => {
        const result = customRmbCost(modelId, { ...ZERO_TOKENS, cacheCreationInputTokens: 1_000_000 }, DEFAULT_CONFIG);
        expect(result.ok).toBe(true);
        expect(result.cost).toBeCloseTo(rate.cacheCreationPerMTokens);
      });

      it('仅 cacheRead tokens：1,000,000 tokens 应恰好收取 cacheReadPerMTokens', () => {
        const result = customRmbCost(modelId, { ...ZERO_TOKENS, cacheReadInputTokens: 1_000_000 }, DEFAULT_CONFIG);
        expect(result.ok).toBe(true);
        expect(result.cost).toBeCloseTo(rate.cacheReadPerMTokens);
      });
    });
  }
});

describe('customRmbCost：固定 Token 示例（用于交付报告展示公式与结果）', () => {
  // 固定示例：claude-sonnet-5，input=200000 output=50000 cacheCreation=100000 cacheRead=1000000。
  // 公式：cost = (input/1e6)*inputRate + (output/1e6)*outputRate + (cacheCreation/1e6)*cacheCreationRate + (cacheRead/1e6)*cacheReadRate
  //           = (200000/1e6)*1.40 + (50000/1e6)*7.00 + (100000/1e6)*1.75 + (1000000/1e6)*0.14
  //           = 0.28 + 0.35 + 0.175 + 0.14 = 0.945 元
  it('claude-sonnet-5 固定示例计算结果应为 0.945 元', () => {
    const tokens = { inputTokens: 200_000, outputTokens: 50_000, cacheCreationInputTokens: 100_000, cacheReadInputTokens: 1_000_000 };
    const result = customRmbCost('claude-sonnet-5', tokens, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.cost).toBeCloseTo(0.945);
  });
});

describe('customRmbCost：模型 ID 未在价格表中时不得猜测默认价格', () => {
  it('返回 ok:false 并携带未知模型 ID，不计算任何费用', () => {
    const result = customRmbCost('claude-unknown-model', { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.unknownModelId).toBe('claude-unknown-model');
    expect(result.cost).toBe(0);
  });
});
