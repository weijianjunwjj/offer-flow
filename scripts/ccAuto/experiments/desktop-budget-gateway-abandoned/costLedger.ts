/** Token 人民币费用计算：四项分别计价，百分比基于费用。 */

import type { CostBreakdown, ModelPricingRmb } from './types';
import type { GatewayConfig } from './gatewayConfig';

export interface PricingLookupResult {
  ok: boolean;
  pricing?: ModelPricingRmb;
  unknownModelId?: string;
}

/** 查找模型定价，未找到返回 ok:false */
export function lookupPricing(modelId: string, config: GatewayConfig): PricingLookupResult {
  const pricing = config.modelPricing[modelId];
  if (!pricing) return { ok: false, unknownModelId: modelId };
  return { ok: true, pricing };
}

/**
 * 计算四项 token 的人民币费用与百分比。
 * 百分比基于费用（非 Token），合计四舍五入后处理为 100.0%。
 */
export function customRmbCostBreakdown(
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
  pricing: ModelPricingRmb,
): CostBreakdown {
  const perToken = (count: number, perM: number) => (count / 1_000_000) * perM;

  const inputCostRmb = perToken(tokens.inputTokens, pricing.inputPerMTokens);
  const outputCostRmb = perToken(tokens.outputTokens, pricing.outputPerMTokens);
  const cacheCreationCostRmb = perToken(tokens.cacheCreationInputTokens, pricing.cacheCreationPerMTokens);
  const cacheReadCostRmb = perToken(tokens.cacheReadInputTokens, pricing.cacheReadPerMTokens);
  const totalCostRmb = inputCostRmb + outputCostRmb + cacheCreationCostRmb + cacheReadCostRmb;

  // 总费用为 0 时不得产生 NaN 百分比
  if (totalCostRmb <= 0) {
    return {
      inputCostRmb: 0,
      outputCostRmb: 0,
      cacheCreationCostRmb: 0,
      cacheReadCostRmb: 0,
      totalCostRmb: 0,
      inputPercent: 0,
      outputPercent: 0,
      cacheCreationPercent: 0,
      cacheReadPercent: 0,
    };
  }

  const inputPercent = (inputCostRmb / totalCostRmb) * 100;
  const outputPercent = (outputCostRmb / totalCostRmb) * 100;
  const cacheCreationPercent = (cacheCreationCostRmb / totalCostRmb) * 100;
  const cacheReadPercent = (cacheReadCostRmb / totalCostRmb) * 100;

  // 四舍五入后修复为 100.0%
  const rounded = [
    { key: 'input', raw: inputPercent, value: Math.round(inputPercent * 10) / 10 },
    { key: 'output', raw: outputPercent, value: Math.round(outputPercent * 10) / 10 },
    { key: 'cacheCreation', raw: cacheCreationPercent, value: Math.round(cacheCreationPercent * 10) / 10 },
    { key: 'cacheRead', raw: cacheReadPercent, value: Math.round(cacheReadPercent * 10) / 10 },
  ];

  let sum = rounded.reduce((s, r) => s + r.value, 0);
  const diff = Math.round((100 - sum) * 10) / 10;

  // 按原始比例分配差值
  if (diff !== 0) {
    // 找到原始小数部分最大的项进行微调
    const sorted = [...rounded].sort((a, b) => (b.raw - b.value) - (a.raw - a.value));
    const step = diff > 0 ? 0.1 : -0.1;
    let remaining = Math.abs(diff);
    for (let i = 0; i < sorted.length && remaining > 0.005; i++) {
      sorted[i].value += step;
      remaining -= 0.1;
    }
  }

  const result: Record<string, number> = {};
  for (const r of rounded) result[r.key] = r.value;

  return {
    inputCostRmb,
    outputCostRmb,
    cacheCreationCostRmb,
    cacheReadCostRmb,
    totalCostRmb,
    inputPercent: result.input,
    outputPercent: result.output,
    cacheCreationPercent: result.cacheCreation,
    cacheReadPercent: result.cacheRead,
  };
}

/**
 * 根据实际模型 ID 和四类 token 计算费用。
 * 未知模型返回 ok: false（不得猜测默认价格）。
 * usage 缺少关键字段时同样返回 ok: false。
 */
export function computeCallCost(
  modelId: string,
  tokens: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  },
  config: GatewayConfig,
): { ok: true; tokenEstimatedCostRmb: number; breakdown: CostBreakdown } | { ok: false; reason: 'PRICING_NOT_FOUND' | 'MISSING_USAGE'; detail?: string } {
  // 检查 usage 字段完整性
  if (
    tokens.inputTokens === undefined ||
    tokens.outputTokens === undefined ||
    tokens.cacheCreationInputTokens === undefined ||
    tokens.cacheReadInputTokens === undefined
  ) {
    return {
      ok: false,
      reason: 'MISSING_USAGE',
      detail: `usage 缺少关键字段：需要 input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens`,
    };
  }

  const pricingResult = lookupPricing(modelId, config);
  if (!pricingResult.ok) {
    return { ok: false, reason: 'PRICING_NOT_FOUND', detail: `模型 ID "${pricingResult.unknownModelId}" 不在价格表中` };
  }

  const breakdown = customRmbCostBreakdown(
    {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheCreationInputTokens: tokens.cacheCreationInputTokens,
      cacheReadInputTokens: tokens.cacheReadInputTokens,
    },
    pricingResult.pricing!,
  );

  return { ok: true, tokenEstimatedCostRmb: breakdown.totalCostRmb, breakdown };
}
