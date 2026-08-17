/** cc-auto v0.2.0 Slice 1B — 人民币费用计算。
 *
 * 唯一定价来源：ProviderProfile.pricing
 *
 * Flat 与 context-tiered 均使用同一四维费用公式；tiered 先按请求
 * context token 数确定一档，再把该档完整 rates 应用于整个 invocation。
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
 * - flat 的低层计算保留 null 按 0 的旧行为；safeComputeCost 仍会拒绝不完整 usage
 * - tiered 缺少 request context 或任一计费维度时 cost 必须为 null
 */
import type {
  ContextPricingTier,
  ModelPricing,
  RawProviderUsage,
  TokenPricingRates,
} from './types';

export type PricingDecisionReason =
  | 'PRICING_CONTEXT_TOKENS_UNAVAILABLE'
  | 'MISSING_TOKENS';

export interface PricingDecision {
  pricingTierId: string | null;
  requestContextTokens: number | null;
  appliedRates: TokenPricingRates | null;
  cost: number | null;
  reason: PricingDecisionReason | null;
}

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
): number | null {
  return computePricingDecision(usage, pricing).cost;
}

/** Deterministic, auditable pricing decision for one Provider invocation. */
export function computePricingDecision(
  usage: RawProviderUsage,
  pricing: ModelPricing,
): PricingDecision {
  if (pricing.pricingType === 'context-tiered') {
    const requestContextTokens = computeRequestContextTokens(usage);
    if (requestContextTokens === null) {
      return {
        pricingTierId: null,
        requestContextTokens: null,
        appliedRates: null,
        cost: null,
        reason: 'PRICING_CONTEXT_TOKENS_UNAVAILABLE',
      };
    }
    const tier = selectContextPricingTier(pricing.tiers, requestContextTokens);
    if (
      usage.inputTokens === null
      || usage.outputTokens === null
      || usage.cacheCreationInputTokens === null
      || usage.cacheReadInputTokens === null
    ) {
      return {
        pricingTierId: tier.id,
        requestContextTokens,
        appliedRates: tier.rates,
        cost: null,
        reason: 'MISSING_TOKENS',
      };
    }
    return {
      pricingTierId: tier.id,
      requestContextTokens,
      appliedRates: tier.rates,
      cost: computeCostWithRates(usage, tier.rates, false),
      reason: null,
    };
  }

  return {
    pricingTierId: null,
    requestContextTokens: null,
    appliedRates: pricing,
    cost: computeCostWithRates(usage, pricing, true),
    reason: null,
  };
}

/** request context excludes output and reconstructs prompt/context from ordinary + cached input. */
export function computeRequestContextTokens(usage: RawProviderUsage): number | null {
  if (usage.inputTokens === null || usage.cacheReadInputTokens === null) return null;
  return usage.inputTokens + usage.cacheReadInputTokens;
}

function selectContextPricingTier(
  tiers: readonly ContextPricingTier[],
  requestContextTokens: number,
): ContextPricingTier {
  const tier = tiers.find(candidate => (
    requestContextTokens >= candidate.fromInclusive
    && (candidate.upToInclusive === null || requestContextTokens <= candidate.upToInclusive)
  ));
  if (!tier) throw new Error('PRICING_TIER_COVERAGE_INVALID');
  return tier;
}

function computeCostWithRates(
  usage: RawProviderUsage,
  rates: TokenPricingRates,
  nullAsZero: boolean,
): number {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;

  if (!nullAsZero && Object.values(usage).some(value => value === null)) {
    throw new Error('MISSING_TOKENS');
  }

  const cost =
    (inputTokens / 1_000_000) * rates.inputPerMTokens +
    (outputTokens / 1_000_000) * rates.outputPerMTokens +
    (cacheCreationInputTokens / 1_000_000) * rates.cacheCreationPerMTokens +
    (cacheReadInputTokens / 1_000_000) * rates.cacheReadPerMTokens;

  return cost;
}

/**
 * 安全计算费用——仅当所有 token 字段非 null 且存在定价时返回 ok:true。
 * 否则返回 ok:false + reason，不返回估算值。
 */
export interface SafeCostResult {
  ok: boolean;
  cost?: number;
  decision?: PricingDecision;
  reason?: 'MISSING_TOKENS' | 'MISSING_PRICING' | 'UNPRICED_MODEL' | 'PRICING_CONTEXT_TOKENS_UNAVAILABLE';
}

export function safeComputeCost(
  usage: RawProviderUsage,
  pricing: ModelPricing | undefined,
): SafeCostResult {
  if (!pricing) {
    return { ok: false, reason: 'MISSING_PRICING' };
  }

  const decision = computePricingDecision(usage, pricing);
  if (decision.reason === 'PRICING_CONTEXT_TOKENS_UNAVAILABLE') {
    return { ok: false, reason: decision.reason, decision };
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

  if (decision.cost === null) {
    return { ok: false, reason: decision.reason ?? 'MISSING_TOKENS', decision };
  }
  return { ok: true, cost: decision.cost, decision };
}
