/** cc-auto v0.2.0 Slice 1F — 任务前预算估算。
 *
 * 职责：
 * - 在发生任何真实 Provider 调用前生成 TaskBudgetEstimate
 * - 依据：初始模型选择、任务类型、影响文件数、是否 Tool Loop、prompt 大小、价格配置
 * - 不调用 LLM、不访问网络、不读取凭证、不读取环境变量
 * - 估算价格来自 ProviderProfile.pricing，不硬编码
 * - 预算计算与模型路由完全解耦：先路由后预算
 */

import type {
  TaskBudgetEstimate,
  EstimatedCall,
  ModelSelection,
  ExecutionModelRole,
  RoutingTaskType,
  ModelRoutingConfig,
  TaskBudgetPolicy,
} from './types';
import type { ModelPricing } from './types';
import { computeCostRmbFromPricing } from './cost';

// ============================================================================
// 公开接口
// ============================================================================

export interface BudgetEstimateInput {
  runId: string;
  taskId: string;
  initialSelection: ModelSelection;
  taskType: RoutingTaskType;
  affectedFileCount: number;
  usesToolLoop: boolean;
  maxToolLoopTurns: number;
  maxToolCalls: number;
  systemPromptChars: number;
  userPromptChars: number;
  routingConfig: ModelRoutingConfig;
  budgetPolicy: TaskBudgetPolicy;
  /** 按 modelLogicalName → ModelPricing 的定价映射 */
  pricingByModel: Record<string, ModelPricing>;
  /** 是否存在可用 Opus Provider */
  hasOpusProvider: boolean;
}

const ESTIMATE_ID_PREFIX = 'est';

let estimateSeq = 0;

export function resetEstimateSequence(): void {
  estimateSeq = 0;
}

function nextEstimateId(): string {
  estimateSeq++;
  return `${ESTIMATE_ID_PREFIX}-${Date.now()}-${estimateSeq}`;
}

/**
 * estimateTaskBudget —— 生成任务前预算预估。
 *
 * 不计入 UsageRecord。不混杂实际 Token。
 * 返回的金额全部以 estimatedCostRmb 标记。
 */
export function estimateTaskBudget(input: BudgetEstimateInput): TaskBudgetEstimate {
  const {
    runId, taskId, initialSelection, taskType, affectedFileCount,
    usesToolLoop, maxToolLoopTurns, maxToolCalls,
    systemPromptChars, userPromptChars,
    routingConfig, pricingByModel, hasOpusProvider,
  } = input;

  const estimateId = nextEstimateId();
  const assumptions: string[] = [];
  const estimatedCalls: EstimatedCall[] = [];

  // 主模型
  const primaryRole = initialSelection.role;
  const primaryModelConfig = roleToModelConfig(primaryRole, routingConfig);
  const primaryPricing = pricingByModel[primaryModelConfig.modelLogicalName] ?? null;

  const primaryTokens = estimateTokensForTask(
    taskType, affectedFileCount, usesToolLoop, maxToolLoopTurns, maxToolCalls,
    systemPromptChars, userPromptChars,
  );

  const primaryCallCount = estimateCallCount(taskType, usesToolLoop, maxToolLoopTurns, affectedFileCount);

  const primaryCostMin = primaryPricing
    ? computeCallCost(primaryTokens.min.input, primaryTokens.min.output, primaryPricing)
    : null;
  const primaryCostExp = primaryPricing
    ? computeCallCost(primaryTokens.expected.input, primaryTokens.expected.output, primaryPricing)
    : null;
  const primaryCostMax = primaryPricing
    ? computeCallCost(primaryTokens.max.input, primaryTokens.max.output, primaryPricing)
    : null;

  const primaryCostNullReason = primaryPricing === null
    ? `${primaryModelConfig.modelLogicalName} 缺少 pricing`
    : null;

  estimatedCalls.push({
    role: primaryRole,
    provider: primaryModelConfig.provider,
    modelLogicalName: primaryModelConfig.modelLogicalName,
    minCalls: primaryCallCount.min,
    expectedCalls: primaryCallCount.expected,
    maxCalls: primaryCallCount.max,
    estimatedInputTokens: primaryTokens.min.input > 0 ? { min: primaryTokens.min.input, expected: primaryTokens.expected.input, max: primaryTokens.max.input } : { min: 0, expected: 0, max: 0 },
    estimatedOutputTokens: primaryTokens.min.output > 0 ? { min: primaryTokens.min.output, expected: primaryTokens.expected.output, max: primaryTokens.max.output } : { min: 0, expected: 0, max: 0 },
    estimatedCostRmb: {
      min: primaryCostMin !== null ? primaryCostMin * primaryCallCount.min : null,
      expected: primaryCostExp !== null ? primaryCostExp * primaryCallCount.expected : null,
      max: primaryCostMax !== null ? primaryCostMax * primaryCallCount.max : null,
    },
    costNullReason: primaryCostNullReason,
  });

  if (primaryPricing === null) {
    assumptions.push('主模型价格配置缺失，成本无法估算');
  }

  // 升级链 —— 可执行预算（只计算当前程序真正能自动调用的 Provider 分支）
  // Flash ✅  Pro ✅  自动 Opus ❌
  // 自动 Opus 缺少 Provider/价格不计入 executableMaxCost，不得将其变成 null
  let totalMinCost = primaryCostMin !== null ? primaryCostMin * primaryCallCount.min : null;
  let totalExpectedCost = primaryCostExp !== null ? primaryCostExp * primaryCallCount.expected : null;
  let totalMaxCost = primaryCostMax !== null ? primaryCostMax * primaryCallCount.max : null;
  let maxNullReason: string | null = null;

  // Flash → Pro 升级
  if (primaryRole === 'FAST_EXECUTOR' && routingConfig.allowStrongEscalation) {
    const strongConfig = routingConfig.strongModel;
    const strongPricing = pricingByModel[strongConfig.modelLogicalName] ?? null;
    const strongCostMax = strongPricing ? computeCallCost(primaryTokens.max.input, primaryTokens.max.output, strongPricing) : null;
    const strongCostNullReason = strongCostMax === null
      ? `${strongConfig.modelLogicalName} 缺少 pricingByModel 中的 outputPerMTokens/inputPerMTokens`
      : null;

    estimatedCalls.push({
      role: 'STRONG_EXECUTOR',
      provider: strongConfig.provider,
      modelLogicalName: strongConfig.modelLogicalName,
      minCalls: 0,
      expectedCalls: 0,
      maxCalls: 1,
      estimatedInputTokens: { min: 0, expected: 0, max: primaryTokens.max.input },
      estimatedOutputTokens: { min: 0, expected: 0, max: primaryTokens.max.output },
      estimatedCostRmb: { min: null, expected: null, max: strongCostMax },
      costNullReason: strongCostNullReason,
    });

    if (strongCostMax !== null) {
      // Pro 价格完整 → 加入可执行最坏上限
      if (totalMaxCost !== null) {
        totalMaxCost += strongCostMax;
      }
    } else {
      // Pro 价格缺失 → 记录原因但不 null totalMaxCost
      // Flash 的 primaryCostMax 仍然有效
      maxNullReason = strongCostNullReason;
    }
    assumptions.push('Flash 失败时最多升级 Pro 1 次');
  }

  // Pro → Opus 升级：自动 Opus 关闭，不计入可执行预算
  if (routingConfig.allowArbiterEscalation && routingConfig.arbiterModel) {
    const arbiterConfig = routingConfig.arbiterModel;

    if (hasOpusProvider) {
      const arbiterPricing = pricingByModel[arbiterConfig.modelLogicalName] ?? null;
      const opusArbiterCostMax = arbiterPricing ? computeCallCost(15000, 8000, arbiterPricing) : null;
      const opusCostNullReason = opusArbiterCostMax === null
        ? `${arbiterConfig.modelLogicalName} 缺少 pricingByModel 中的 pricing 数据`
        : null;

      estimatedCalls.push({
        role: 'ARBITER',
        provider: arbiterConfig.provider,
        modelLogicalName: arbiterConfig.modelLogicalName,
        minCalls: 0,
        expectedCalls: 0,
        maxCalls: 1,
        estimatedInputTokens: { min: 0, expected: 0, max: 15000 },
        estimatedOutputTokens: { min: 0, expected: 0, max: 8000 },
        estimatedCostRmb: { min: null, expected: null, max: opusArbiterCostMax },
        costNullReason: opusCostNullReason,
      });

      if (opusArbiterCostMax !== null) {
        if (totalMaxCost !== null) {
          totalMaxCost += opusArbiterCostMax;
        }
      } else {
        if (maxNullReason === null) maxNullReason = opusCostNullReason;
      }
    } else {
      // 自动 Opus 关闭 → 不计入可执行预算，但单独记录
      estimatedCalls.push({
        role: 'ARBITER',
        provider: arbiterConfig.provider,
        modelLogicalName: arbiterConfig.modelLogicalName,
        minCalls: 0,
        expectedCalls: 0,
        maxCalls: 0,  // maxCalls=0 表示不会自动调用
        estimatedInputTokens: { min: 0, expected: 0, max: 0 },
        estimatedOutputTokens: { min: 0, expected: 0, max: 0 },
        estimatedCostRmb: { min: null, expected: null, max: null },
        costNullReason: '自动 Opus 关闭：缺少 Provider/Provider profile，不计入可执行预算',
      });
      assumptions.push('自动 Opus：关闭，不计入可执行预算（只会生成 ArbitrationCapsule）');
    }
  }

  // 汇总
  return {
    estimateId,
    runId,
    taskId,
    routingPolicyVersion: 'cc-auto-model-routing-v1',
    initialSelection,
    currency: 'CNY',
    estimatedCalls,
    totalEstimatedCostRmb: {
      min: totalMinCost !== null ? roundCost(totalMinCost) : null,
      expected: totalExpectedCost !== null ? roundCost(totalExpectedCost) : null,
      max: (totalMaxCost !== null) ? roundCost(totalMaxCost) : null,
    },
    maxNullReason,
    assumptions,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 检查是否超过预算限制。
 */
export function checkBudgetLimits(
  estimate: TaskBudgetEstimate,
  policy: TaskBudgetPolicy,
): { ok: true } | { ok: false; reason: 'SOFT_LIMIT' | 'HARD_LIMIT'; message: string } {
  const expectedCost = estimate.totalEstimatedCostRmb.expected;
  const maxCost = estimate.totalEstimatedCostRmb.max;

  // 硬上限检查
  if (policy.hardLimitRmb !== undefined && policy.stopBeforeHardLimit) {
    if (maxCost !== null && maxCost > policy.hardLimitRmb) {
      return {
        ok: false,
        reason: 'HARD_LIMIT',
        message: `预计最坏成本 ¥${maxCost.toFixed(4)} 超过硬上限 ¥${policy.hardLimitRmb}——BUDGET_LIMIT_EXCEEDED`,
      };
    }
  }

  // 软上限检查
  if (policy.softLimitRmb !== undefined && policy.requireConfirmationAboveSoftLimit) {
    if (expectedCost !== null && expectedCost > policy.softLimitRmb) {
      return {
        ok: false,
        reason: 'SOFT_LIMIT',
        message: `预计常规成本 ¥${expectedCost.toFixed(4)} 超过软上限 ¥${policy.softLimitRmb}——BUDGET_CONFIRMATION_REQUIRED`,
      };
    }
  }

  return { ok: true };
}

// ============================================================================
// Token 估算
// ============================================================================

export interface TokenEstimate {
  input: number;
  output: number;
}

/**
 * 保守的 Token 估算——使用字符数 × 系数。
 * 中文系数 0.5（约 2 字符/token），英文系数 0.25（约 4 字符/token）。
 * 结果明确标记为 estimated，不入 UsageRecord。
 */
export function estimateTokensFromCharacters(charCount: number): number {
  // 使用相对保守的系数：平均 ~3 chars/token
  // 英文约 4 chars/token，中文约 1.5-2 chars/token
  return Math.ceil(charCount / 3);
}

function estimateTokensForTask(
  taskType: RoutingTaskType,
  affectedFileCount: number,
  usesToolLoop: boolean,
  maxTurns: number,
  maxToolCalls: number,
  systemPromptChars: number,
  userPromptChars: number,
): {
  min: TokenEstimate;
  expected: TokenEstimate;
  max: TokenEstimate;
} {
  const baseInput = estimateTokensFromCharacters(systemPromptChars + userPromptChars);
  const filePerFileTokens = 3000;

  const minInput = baseInput + Math.min(affectedFileCount, 1) * filePerFileTokens;
  const expectedInput = baseInput + affectedFileCount * filePerFileTokens;
  const maxInput = baseInput + affectedFileCount * filePerFileTokens * 2 +
    (usesToolLoop ? maxTurns * maxToolCalls * 2000 : 0);

  let outputMultiplier = 1;
  if (taskType === 'CODE_IMPLEMENTATION' || taskType === 'REFACTOR') outputMultiplier = 2;
  if (taskType === 'ARCHITECTURE') outputMultiplier = 3;

  const baseOutput = 2000;
  const minOutput = baseOutput * outputMultiplier;
  const expectedOutput = baseOutput * outputMultiplier * (usesToolLoop ? 2 : 1);
  const maxOutput = baseOutput * outputMultiplier * (usesToolLoop ? maxTurns : 1);

  return {
    min: { input: minInput, output: minOutput },
    expected: { input: expectedInput, output: expectedOutput },
    max: { input: maxInput, output: maxOutput },
  };
}

function estimateCallCount(
  _taskType: RoutingTaskType,
  usesToolLoop: boolean,
  maxTurns: number,
  affectedFileCount: number,
): { min: number; expected: number; max: number } {
  if (usesToolLoop) {
    return { min: 1, expected: Math.min(maxTurns, 4), max: maxTurns };
  }
  const expected = Math.max(1, Math.ceil(affectedFileCount / 2));
  return { min: 1, expected, max: expected * 2 };
}

// ============================================================================
// 费用计算
// ============================================================================

function computeCallCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  const cost = computeCostRmbFromPricing({
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }, pricing);
  if (cost === null) throw new Error('PRICING_CONTEXT_TOKENS_UNAVAILABLE');
  return roundCost(cost);
}

function roundCost(cost: number): number {
  // 保留合理精度但不引入浮点噪声
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ============================================================================
// 辅助
// ============================================================================

function roleToModelConfig(
  role: ExecutionModelRole,
  config: ModelRoutingConfig,
): { provider: string; profileId: string; modelLogicalName: string } {
  switch (role) {
    case 'FAST_EXECUTOR': return config.fastModel;
    case 'STRONG_EXECUTOR': return config.strongModel;
    case 'ARBITER': return config.arbiterModel ?? { provider: 'anthropic', profileId: 'opus-5', modelLogicalName: 'opus-5' };
  }
}
