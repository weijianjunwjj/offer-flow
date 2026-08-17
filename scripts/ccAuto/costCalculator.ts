/** cc-auto v0.2.0 Slice R0 — 逐条 UsageRecord 成本计算工具。
 *
 * 职责：
 * - 逐条 UsageRecord 使用指定的 ModelPricing 重算成本
 * - 分别跟踪 input/output/cacheCreation/cacheRead 四类 Token 的完整性
 * - 不合并 Token、不取平均单价
 */

import type { UsageRecord } from './types';
import type { ModelPricing } from './types';
import { computeCostRmbFromPricing as computeUsageCost } from './cost';

/** 四类 Token 完整性标记 */
export interface TokenCompleteness {
  allInputTokensKnown: boolean;
  allOutputTokensKnown: boolean;
  allCacheCreationTokensKnown: boolean;
  allCacheReadTokensKnown: boolean;
}

/** 单条 UsageRecord 的计算结果 */
export interface SingleCallCost {
  costRmb: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
}

/**
 * 逐条 UsageRecord 使用 Pro Pricing 重算成本。
 * 返回每条记录的成本以及四类 Token 完整性标记。
 */
export function computeAllProCostPerCall(
  usageRecords: UsageRecord[],
  proPricing: ModelPricing,
): {
  perCallCosts: SingleCallCost[];
  completeness: TokenCompleteness;
  sumCostRmb: number | null;
} {
  const perCallCosts: SingleCallCost[] = [];
  const completeness: TokenCompleteness = {
    allInputTokensKnown: true,
    allOutputTokensKnown: true,
    allCacheCreationTokensKnown: true,
    allCacheReadTokensKnown: true,
  };

  let allCallsPriced = true;

  for (const usage of usageRecords) {
    const inputT = usage.inputTokens;
    const outputT = usage.outputTokens;
    const cacheCreateT = usage.cacheCreationInputTokens;
    const cacheReadT = usage.cacheReadInputTokens;

    if (inputT === null || inputT === undefined) completeness.allInputTokensKnown = false;
    if (outputT === null || outputT === undefined) completeness.allOutputTokensKnown = false;
    if (cacheCreateT === null || cacheCreateT === undefined) completeness.allCacheCreationTokensKnown = false;
    if (cacheReadT === null || cacheReadT === undefined) completeness.allCacheReadTokensKnown = false;

    // 单次 invocation 的完整成本要求四类 usage 均已知；不得把未知 cache usage 当成 0。
    if (
      inputT === null || inputT === undefined
      || outputT === null || outputT === undefined
      || cacheCreateT === null || cacheCreateT === undefined
      || cacheReadT === null || cacheReadT === undefined
    ) {
      allCallsPriced = false;
      perCallCosts.push({
        costRmb: null,
        inputTokens: inputT ?? null,
        outputTokens: outputT ?? null,
        cacheCreationTokens: cacheCreateT ?? null,
        cacheReadTokens: cacheReadT ?? null,
      });
      continue;
    }

    const costRmb = computeCostRmbFromPricing(
      inputT, outputT,
      cacheCreateT, cacheReadT,
      proPricing,
    );

    perCallCosts.push({
      costRmb,
      inputTokens: inputT,
      outputTokens: outputT,
      cacheCreationTokens: cacheCreateT ?? null,
      cacheReadTokens: cacheReadT ?? null,
    });
  }

  const sumCostRmb = allCallsPriced
    ? perCallCosts.reduce((sum, c) => sum + (c.costRmb ?? 0), 0)
    : null;

  return { perCallCosts, completeness, sumCostRmb };
}

/**
 * 使用指定 pricing 计算单次调用的成本（RMB）。
 * cacheCreation 和 cacheRead 分别计价。
 */
export function computeCostRmbFromPricing(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  pricing: ModelPricing,
): number {
  const cost = computeUsageCost({
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreationTokens,
    cacheReadInputTokens: cacheReadTokens,
  }, pricing);
  if (cost === null) throw new Error('PRICING_CONTEXT_TOKENS_UNAVAILABLE');
  return roundCost(cost);
}

/**
 * 从 UsageRecord 提取标准化的四类 Token 计数。
 * 用于在任务完成后逐条重算成本。
 */
export function normalizeUsageForCost(usage: UsageRecord): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationInputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
  };
}

function roundCost(cost: number): number {
  return Math.round(cost * 1_000_000) / 1_000_000;
}
