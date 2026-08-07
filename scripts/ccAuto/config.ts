/** cc-auto v0.1 默认配置（预算、模型规则、限额）。可被 .cc-auto/config.json 覆盖。 */
// v0.2.0: 新增 providerProfiles，ProviderProfile 配置统一在 .cc-auto/config.json 中，
// 不创建第二个配置真相来源。
// v0.2.0 Slice 1F: 新增 modelRouting、budgetPolicy、contextBudget 配置字段。

export interface BudgetConfig {
  simpleTaskRmb: number;
  normalTaskRmb: number;
  complexTaskRmb: number;
  absoluteTaskMaxRmb: number;
  dailyMaxRmb: number;
  opusShareMax: number; // 0-1
}

export interface LimitsConfig {
  maxRepairCycles: number;
  maxOpusCalls: number;
  maxHandoffs: number;
  maxContextFiles: number;
  maxChangedFiles: number;
}

export interface ModelRuleConfig {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
}

/** 某个模型每 1M tokens 的人民币单价（渠道自定义计价，不是官方账单）。 */
export interface ModelPricingRmb {
  inputPerMTokens: number;
  outputPerMTokens: number;
  cacheCreationPerMTokens: number;
  cacheReadPerMTokens: number;
}

/** official：按 claude CLI 返回的 total_cost_usd 换算；custom：按下方渠道单价表计算。默认 custom。 */
export type PricingMode = 'official' | 'custom';

export interface CcAutoConfig {
  budget: BudgetConfig;
  limits: LimitsConfig;
  models: {
    scout: ModelRuleConfig;
    builderDefault: ModelRuleConfig;
    builderHighRisk: ModelRuleConfig;
    arbiter: ModelRuleConfig;
  };
  /** 美元转人民币估算汇率，仅用于 official 模式换算，不代表真实账单。 */
  usdToRmbRate: number;
  /** 报告主口径展示用；预算止损始终按第三方渠道人民币费用判断，与本字段无关（见 budget.ts）。 */
  pricingMode: PricingMode;
  /** 按具体模型 ID（如 claude-sonnet-5）查单价；找不到对应模型时立即停止（PRICING_NOT_FOUND），不猜测默认价格。 */
  customPricing: Record<string, ModelPricingRmb>;
  /**
   * v0.2.0: Provider 配置（按 Profile ID 索引）。
   * 与 v0.1 字段共存于同一 .cc-auto/config.json，不创建第二个配置真相来源。
   */
  providerProfiles?: Record<string, unknown>;
  /**
   * v0.2.0 Slice R0: 三级模型路由配置。
   * enabled=false 时 100% 保持旧行为。
   */
  modelRouting?: import('./types').ModelRoutingConfig;
  /**
   * v0.2.0 Slice 1F: 任务预算策略。
   */
  budgetPolicy?: import('./types').TaskBudgetPolicy;
  /**
   * v0.2.0 Slice 1F: 模型上下文预算。
   */
  contextBudget?: {
    flash?: import('./types').ModelContextBudget;
    strong?: import('./types').ModelContextBudget;
    arbiter?: import('./types').ModelContextBudget;
  };
}

export const DEFAULT_CONFIG: CcAutoConfig = {
  budget: {
    simpleTaskRmb: 3,
    normalTaskRmb: 10,
    complexTaskRmb: 25,
    absoluteTaskMaxRmb: 30,
    dailyMaxRmb: 50,
    opusShareMax: 0.15,
  },
  limits: {
    maxRepairCycles: 2,
    maxOpusCalls: 1,
    maxHandoffs: 1,
    maxContextFiles: 12,
    maxChangedFiles: 15,
  },
  models: {
    // 固定使用具体模型 ID，不使用 haiku/sonnet/opus 等可能随时间漂移的别名。
    scout: { model: 'claude-haiku-4-5', effort: 'low', maxTurns: 6 },
    builderDefault: { model: 'claude-sonnet-5', effort: 'medium', maxTurns: 16 },
    builderHighRisk: { model: 'claude-sonnet-5', effort: 'high', maxTurns: 16 },
    arbiter: { model: 'claude-opus-5', effort: 'high', maxTurns: 4 },
  },
  usdToRmbRate: 7.2,
  pricingMode: 'custom',
  // 第三方渠道单价（人民币/1M tokens），按用户提供的价目表固定；未在表中的模型 ID 一律 PRICING_NOT_FOUND，不猜测默认价格。
  customPricing: {
    'claude-opus-5': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
    'claude-opus-4-8': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
    'claude-opus-4-7': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
    'claude-opus-4-6': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
    'claude-sonnet-5': { inputPerMTokens: 1.40, outputPerMTokens: 7.00, cacheCreationPerMTokens: 1.75, cacheReadPerMTokens: 0.14 },
    'claude-sonnet-4-6': { inputPerMTokens: 2.10, outputPerMTokens: 10.50, cacheCreationPerMTokens: 2.63, cacheReadPerMTokens: 0.21 },
    'claude-haiku-4-5': { inputPerMTokens: 0.70, outputPerMTokens: 3.50, cacheCreationPerMTokens: 0.88, cacheReadPerMTokens: 0.07 },
  },
  /**
   * v0.2.0 Slice R0: 默认三级模型路由配置。
   * modelRouting.enabled=false 确保不引入任何新行为差异。
   * Flash/Pro profileId 只是引用，不代表 ProviderProfile 已配置。
   * 生产配置加载（从 .cc-auto/config.json 读取）将在后续切片完成。
   */
  modelRouting: {
    enabled: false,
    fastModel: { provider: 'deepseek', profileId: 'deepseek-v4-flash', modelLogicalName: 'deepseek-flash' },
    strongModel: { provider: 'deepseek', profileId: 'deepseek-v4-pro', modelLogicalName: 'deepseek-pro' },
    arbiterModel: { provider: 'anthropic', profileId: 'opus-5', modelLogicalName: 'opus-5' },
    allowStrongEscalation: true,
    allowArbiterEscalation: true,
  },
  /**
   * v0.2.0 Slice R0: 任务预算策略——BALANCED 模式，无硬限制，不阻断旧行为。
   */
  budgetPolicy: {
    mode: 'BALANCED',
    softLimitRmb: 10,
    hardLimitRmb: 50,
    requireConfirmationAboveSoftLimit: false,
    stopBeforeHardLimit: false,
  },
  /**
   * v0.2.0 Slice R0: 默认上下文预算。
   */
  contextBudget: {
    flash: { maxInputCharacters: 40_000, maxHistoryMessages: 12, maxEvidenceCharacters: 12_000 },
    strong: { maxInputCharacters: 120_000, maxHistoryMessages: 30, maxEvidenceCharacters: 40_000 },
    arbiter: { maxInputCharacters: 24_000, maxHistoryMessages: 0, maxEvidenceCharacters: 20_000 },
  },
};

export function budgetForComplexity(config: CcAutoConfig, complexity: 'simple' | 'normal' | 'complex'): number {
  if (complexity === 'simple') return config.budget.simpleTaskRmb;
  if (complexity === 'normal') return config.budget.normalTaskRmb;
  return config.budget.complexTaskRmb;
}
