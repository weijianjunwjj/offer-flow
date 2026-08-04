/** 费用预测引擎：本地确定性规则 + 历史滚动统计。禁止额外调用模型。 */

import type { CostEstimate, TaskComplexity } from './types';
import type { GatewayConfig } from './gatewayConfig';
import type { SessionTracker } from './sessionTracker';

/**
 * 估算当前请求的输入 Token（粗略字符数 ÷ 3.5 估算，中英文混合场景）。
 * 仅用于预测，不用于计费。
 */
function estimateInputTokens(bodyText: string): number {
  return Math.max(100, Math.ceil(bodyText.length / 3.5));
}

/**
 * 生成费用预测。输入包括：当前请求估算 token、system/context 规模、可用工具数、模型、历史数据。
 * 第一版使用本地确定性规则 + 历史滚动统计。
 */
export function estimateCost(
  bodyText: string,
  modelId: string,
  toolCount: number,
  sessionTracker: SessionTracker,
  config: GatewayConfig,
): CostEstimate {
  const turn = sessionTracker.getActiveTurn();
  const complexity: TaskComplexity = turn?.complexity ?? 'simple';

  // 冷启动静态估计
  const cold = config.coldStartEstimates[complexity];

  // 历史平均（同复杂度）
  const histAvg = sessionTracker.getHistoricalAvgCostRmb(complexity);

  // 估算输入 token
  const estimatedInputTokens = estimateInputTokens(bodyText);

  // 基于输入规模调整
  let scaleFactor = 1;
  if (estimatedInputTokens > 10000) scaleFactor = 2;
  else if (estimatedInputTokens > 5000) scaleFactor = 1.5;
  else if (estimatedInputTokens > 2000) scaleFactor = 1.2;

  // 工具数量影响
  const toolFactor = toolCount > 5 ? 1.3 : toolCount > 0 ? 1.1 : 1;

  // P50 中心预测
  let centerRmb: number;
  let confidence: CostEstimate['confidence'] = 'low';

  if (histAvg !== null) {
    // 有历史数据：加权平均（历史 0.6 + 冷启动 0.4）
    centerRmb = histAvg * 0.6 + cold.centerRmb * scaleFactor * toolFactor * 0.4;
    confidence = 'medium';
    if (turn && turn.calls.length > 0) {
      // 任务进行中且有调用记录：高置信度
      const currentCost = turn.calls.reduce((s, c) => s + c.tokenEstimatedCostRmb, 0);
      centerRmb = currentCost * 1.2; // 基于当前已花费微上调
      confidence = 'high';
    }
  } else {
    centerRmb = cold.centerRmb * scaleFactor * toolFactor;
  }

  // P90 上界
  const upperRmb = Math.max(centerRmb * 1.8, cold.p90Rmb * scaleFactor);

  // 硬上限 = min(绝对上限, cold.maxRmb * scaleFactor)
  const hardLimitRmb = Math.min(config.budget.absoluteTaskMaxRmb, cold.maxRmb * scaleFactor);

  return {
    centerRmb: Math.round(centerRmb * 100) / 100,
    upperRmb: Math.round(upperRmb * 100) / 100,
    hardLimitRmb: Math.round(hardLimitRmb * 100) / 100,
    modelId,
    confidence,
    complexity,
  };
}
