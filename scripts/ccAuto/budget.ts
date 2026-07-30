/** 预算与费用统计：从 CallUsage 累计 RMB 估算值，并判断是否超限。 */
import type { CallUsage, ModelRole } from './types';
import type { CcAutoConfig, ModelPricingRmb } from './config';

export function usdToRmb(usd: number, config: CcAutoConfig): number {
  return usd * config.usdToRmbRate;
}

export interface CustomRmbCostResult {
  ok: boolean;
  /** ok=true 时为计算出的人民币费用；ok=false 时无意义（恒为 0），调用方不得据此累计预算。 */
  cost: number;
  /** ok=false 时携带未找到价格的模型 ID，供上层触发 PRICING_NOT_FOUND 并写入报告。 */
  unknownModelId?: string;
}

/**
 * 按渠道自定义单价表计算某次调用的人民币费用（与官方 total_cost_usd 无关）。
 * 模型 ID 不在价格表中时不得猜测默认价格，返回 ok:false，调用方须立即停止（PRICING_NOT_FOUND）。
 */
export function customRmbCost(
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number },
  config: CcAutoConfig,
): CustomRmbCostResult {
  const rate: ModelPricingRmb | undefined = config.customPricing[modelId];
  if (!rate) return { ok: false, cost: 0, unknownModelId: modelId };
  const perToken = (count: number, perM: number) => (count / 1_000_000) * perM;
  const cost =
    perToken(tokens.inputTokens, rate.inputPerMTokens) +
    perToken(tokens.outputTokens, rate.outputPerMTokens) +
    perToken(tokens.cacheCreationInputTokens, rate.cacheCreationPerMTokens) +
    perToken(tokens.cacheReadInputTokens, rate.cacheReadPerMTokens);
  return { ok: true, cost };
}

export interface PricingValidationResult {
  ok: boolean;
  /** ok=false 时列出「角色 -> 缺少价格的模型 ID」，供上层触发 PRICING_NOT_FOUND 并写入报告。 */
  missing: Array<{ role: keyof CcAutoConfig['models']; modelId: string }>;
}

/**
 * 启动任何 claude 子进程之前的配置级校验：
 * scout / builderDefault / builderHighRisk / arbiter 四个角色配置的具体模型 ID，
 * 必须全部存在于 customPricing。任一缺失即返回 ok:false，调用方须在 spawn 任何子进程前停止（PRICING_NOT_FOUND），
 * 不猜测默认价格、不发起任何真实模型调用。
 */
export function validateConfiguredModelPricing(config: CcAutoConfig): PricingValidationResult {
  const roles: Array<keyof CcAutoConfig['models']> = ['scout', 'builderDefault', 'builderHighRisk', 'arbiter'];
  const missing: PricingValidationResult['missing'] = [];
  for (const role of roles) {
    const modelId = config.models[role].model;
    if (!config.customPricing[modelId]) missing.push({ role, modelId });
  }
  return { ok: missing.length === 0, missing };
}

export interface BudgetTotals {
  /**
   * 第三方渠道人民币费用合计（预算止损与历史累计的唯一依据，与 pricingMode 无关）。
   * 仅累加 PRICED 调用；存在 UNPRICED 调用时该值只是「已知费用下限」，见 hasUnpriced。
   */
  totalRmb: number;
  byModel: Record<ModelRole, number>;
  /** 两种口径的合计，仅用于报告中并列对照展示，不参与止损判断。official 含全部调用（含 UNPRICED）。 */
  totalRmbOfficial: number;
  /** 渠道口径合计，等同 totalRmb（只含 PRICED）。 */
  totalRmbCustom: number;
  /** 调用总数（含 UNPRICED）。 */
  callCount: number;
  /** 无法定价（UNPRICED）的调用数；>0 时 totalRmb/totalRmbCustom 只是费用下限。 */
  unpricedCount: number;
  /** 是否存在无法定价的调用——报告须据此声明「已知人民币合计只是下限」。 */
  hasUnpriced: boolean;
}

export function summarizeUsage(calls: CallUsage[]): BudgetTotals {
  const byModel: Record<ModelRole, number> = { scout: 0, builder: 0, arbiter: 0 };
  let totalRmb = 0;
  let totalRmbOfficial = 0;
  let totalRmbCustom = 0;
  let unpricedCount = 0;
  for (const call of calls) {
    // UNPRICED 调用的 costRmbCustom 为 null：仍计入调用数与官方费用，但不计入已知渠道人民币合计。
    totalRmbOfficial += call.costRmbOfficial;
    if (call.pricingStatus === 'UNPRICED' || call.costRmbCustom === null) {
      unpricedCount += 1;
      continue;
    }
    byModel[call.model] += call.costRmbCustom;
    totalRmb += call.costRmbCustom;
    totalRmbCustom += call.costRmbCustom;
  }
  return {
    totalRmb,
    byModel,
    totalRmbOfficial,
    totalRmbCustom,
    callCount: calls.length,
    unpricedCount,
    hasUnpriced: unpricedCount > 0,
  };
}

export function opusShare(totals: BudgetTotals): number {
  if (totals.totalRmb <= 0) return 0;
  return totals.byModel.arbiter / totals.totalRmb;
}

export interface BudgetCheckResult {
  exceeded: boolean;
  reason?: 'BUDGET_TASK_EXCEEDED' | 'BUDGET_DAILY_EXCEEDED';
  detail?: string;
}

/** 在发起下一次模型调用前检查：任务预算上限、绝对上限、当日预算上限。 */
export function checkBudgetBeforeCall(
  taskBudgetRmb: number,
  absoluteMaxRmb: number,
  dailyMaxRmb: number,
  currentTaskRmb: number,
  currentDailyRmb: number,
  estimatedNextCallRmb: number,
): BudgetCheckResult {
  const projectedTask = currentTaskRmb + estimatedNextCallRmb;
  const projectedDaily = currentDailyRmb + estimatedNextCallRmb;
  const taskCap = Math.min(taskBudgetRmb, absoluteMaxRmb);
  if (projectedTask > taskCap) {
    return {
      exceeded: true,
      reason: 'BUDGET_TASK_EXCEEDED',
      detail: `预计任务花费 ${projectedTask.toFixed(2)} 元将超过任务上限 ${taskCap.toFixed(2)} 元`,
    };
  }
  if (projectedDaily > dailyMaxRmb) {
    return {
      exceeded: true,
      reason: 'BUDGET_DAILY_EXCEEDED',
      detail: `预计当日花费 ${projectedDaily.toFixed(2)} 元将超过当日上限 ${dailyMaxRmb.toFixed(2)} 元`,
    };
  }
  return { exceeded: false };
}
