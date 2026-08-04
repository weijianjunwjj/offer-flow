/** cc-auto v0.2.0 Slice 1B — 人民币费用计算。
 *
 * 唯一定价来源：ProviderProfile.pricing
 *
 * 费用公式：
 * costRmbCustom =
 *   inputTokens / 1_000_000 * inputPerMTokens
 *   + outputTokens / 1_000_000 * outputPerMTokens
 *   + cacheCreationInputTokens / 1_000_000 * cacheCreationPerMTokens
 *   + cacheReadInputTokens / 1_000_000 * cacheReadPerMTokens
 *
 * 规则：
 * - 所有价格必须为 CNY
 * - 使用足够精度计算，持久化不得提前格式化为字符串
 * - CLI / 报告格式化与内部数值分离
 * - null 的 token 字段按 0 计算金额（允许保守低估，但 costStatus 仍为 UNAVAILABLE）
 * - 只有当所有价格字段都存在且所有 token 字段非 null 时，才能安全计算
 */
import type { RawProviderUsage, ModelPricing } from './types';

/**
 * 使用 ProviderProfile.pricing 中的单价计算人民币费用。
 * 计算使用实际模型：reportedModel ?? requestedModelId。
 *
 * 内部使用 Number 精度，不格式化为字符串。
 * null token 按 0 处理金额，但调用方应已通过 usageStatus/costStatus 区分。
 */
export function computeCostRmbFromPricing(
  usage: RawProviderUsage,
  pricing: ModelPricing,
): number {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMTokens +
    (outputTokens / 1_000_000) * pricing.outputPerMTokens +
    (cacheCreationInputTokens / 1_000_000) * pricing.cacheCreationPerMTokens +
    (cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMTokens;

  return cost;
}

/**
 * 安全计算费用——仅当所有 token 字段非 null 且存在定价时返回 ok:true。
 * 否则返回 ok:false + reason，不返回估算值。
 */
export interface SafeCostResult {
  ok: boolean;
  cost?: number;
  reason?: 'MISSING_TOKENS' | 'MISSING_PRICING' | 'UNPRICED_MODEL';
}

export function safeComputeCost(
  usage: RawProviderUsage,
  pricing: ModelPricing | undefined,
): SafeCostResult {
  if (!pricing) {
    return { ok: false, reason: 'MISSING_PRICING' };
  }

  // 检查是否有 token 字段为 null
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.cacheCreationInputTokens === null ||
    usage.cacheReadInputTokens === null
  ) {
    return { ok: false, reason: 'MISSING_TOKENS' };
  }

  return {
    ok: true,
    cost: computeCostRmbFromPricing(usage, pricing),
  };
}
