/** 网关默认配置与加载逻辑。 */

import * as path from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import type { GatewayConfig, ModelPricingRmb } from './types';

export type { GatewayConfig, ModelPricingRmb };

/** DeepSeek 平台 + 渠道价格（RMB/1M tokens）。 */
const DEEPSEEK_PRICING: Record<string, ModelPricingRmb> = {
  'deepseek-v4-pro': {
    inputPerMTokens: 1.40,
    outputPerMTokens: 7.00,
    cacheCreationPerMTokens: 1.75,
    cacheReadPerMTokens: 0.14,
  },
  'deepseek-v4-flash': {
    inputPerMTokens: 0.70,
    outputPerMTokens: 3.50,
    cacheCreationPerMTokens: 0.88,
    cacheReadPerMTokens: 0.07,
  },
};

/** 原第三方渠道价格（RMB/1M tokens），与 config.ts 中保持一致。 */
const THIRD_PARTY_PRICING: Record<string, ModelPricingRmb> = {
  'claude-opus-5': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-opus-4-8': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-opus-4-7': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-opus-4-6': { inputPerMTokens: 3.50, outputPerMTokens: 17.50, cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35 },
  'claude-sonnet-5': { inputPerMTokens: 1.40, outputPerMTokens: 7.00, cacheCreationPerMTokens: 1.75, cacheReadPerMTokens: 0.14 },
  'claude-sonnet-4-6': { inputPerMTokens: 2.10, outputPerMTokens: 10.50, cacheCreationPerMTokens: 2.63, cacheReadPerMTokens: 0.21 },
  'claude-haiku-4-5': { inputPerMTokens: 0.70, outputPerMTokens: 3.50, cacheCreationPerMTokens: 0.88, cacheReadPerMTokens: 0.07 },
  'claude-fable-5': { inputPerMTokens: 2.10, outputPerMTokens: 10.50, cacheCreationPerMTokens: 2.63, cacheReadPerMTokens: 0.21 },
};

/** 合并所有已知渠道价格（DeepSeek 优先，因为 CC Switch 下它是最常用的真实模型）。 */
const ALL_PRICING: Record<string, ModelPricingRmb> = {
  ...THIRD_PARTY_PRICING,
  ...DEEPSEEK_PRICING,
};

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  host: '127.0.0.1',
  port: 15722,
  // 以下字段仅用于 CC Switch passthrough 模式（当前不使用 Provider 下游模式）
  upstreamHost: '127.0.0.1',
  upstreamPort: 15721,
  upstreamPathPrefix: '/claude-desktop',

  /** Provider 路由：/upstream/<routeId>/* → upstreamUrl */
  routes: {
    deepseek: { name: 'DeepSeek', upstreamUrl: 'https://api.deepseek.com/anthropic' },
    apikeyfun: { name: '原第三方', upstreamUrl: 'https://api.apikey.fun' },
  },
  budget: {
    simpleTaskRmb: 3,
    normalTaskRmb: 10,
    complexTaskRmb: 25,
    absoluteTaskMaxRmb: 30,
    dailyMaxRmb: 50,
  },
  coldStartEstimates: {
    simple: { centerRmb: 0.50, p90Rmb: 1.50, maxRmb: 3 },
    normal: { centerRmb: 3.00, p90Rmb: 7.00, maxRmb: 10 },
    complex: { centerRmb: 8.00, p90Rmb: 18.00, maxRmb: 25 },
  },
  modelPricing: ALL_PRICING,
  dataDir: path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'cc-auto-gateway'),
};

/** 从文件中加载用户覆盖配置（可选）。 */
export function loadGatewayConfig(configPath?: string): GatewayConfig {
  const defaults = { ...DEFAULT_GATEWAY_CONFIG };
  const resolvedPath = configPath || path.join(defaults.dataDir, 'config.json');
  if (!existsSync(resolvedPath)) {
    mkdirSync(defaults.dataDir, { recursive: true });
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(resolvedPath, 'utf8'));
    return { ...defaults, ...raw, budget: { ...defaults.budget, ...(raw.budget || {}) } };
  } catch {
    return defaults;
  }
}

/** 从自然语言任务中解析用户预算覆盖，格式：「预算上限：0.50 元」或「预算上限：0.50」。 */
export function parseUserBudgetOverride(taskText: string): { amountRmb: number } | undefined {
  const pattern = /预算上限[：:]\s*(\d+\.?\d*)\s*元?/;
  const match = taskText.match(pattern);
  if (!match) return undefined;
  const amount = parseFloat(match[1]);
  if (isNaN(amount) || amount <= 0) return undefined;
  return { amountRmb: Math.round(amount * 100) / 100 };
}
