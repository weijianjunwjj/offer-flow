/**
 * v0.9 — Daily Job Hunter budget env override（纯函数，无 IO / 不打印 secret）。
 *
 * 两个可选 env override：
 *   - OFFERFLOW_DAILY_FETCH_BUDGET
 *   - OFFERFLOW_DAILY_ENRICHMENT_BUDGET
 *
 * 解析规则：
 *   - env 缺失 / 空字符串 → undefined（沿用 DailyPipeline 默认 50 / 20）
 *   - 必须是十进制非负整数；0 合法（完全关闭对应真实调用）
 *   - 非数字 / 小数 / 负数 / 科学计数 / 超安全整数 → 忽略并回退 undefined（仅记录非敏感 warning）
 *   - fetchBudget 超上限 clamp 到 50；enrichmentBudget 超上限 clamp 到 20
 *
 * 本模块只解析、不决定业务语义；是否覆盖默认值由 DailyRunCoordinator 传入
 * DailyPipeline.run() 的 options 决定（options 未传时 DailyPipeline 用自身默认）。
 */

export const ENV_FETCH_BUDGET = 'OFFERFLOW_DAILY_FETCH_BUDGET';
export const ENV_ENRICHMENT_BUDGET = 'OFFERFLOW_DAILY_ENRICHMENT_BUDGET';

export const DAILY_FETCH_BUDGET_MAX = 50;
export const DAILY_ENRICHMENT_BUDGET_MAX = 20;

export interface DailyBudgetOverrides {
  fetchBudget?: number;
  enrichmentBudget?: number;
}

/**
 * 解析单个预算 env 值。
 * 返回 undefined（沿用默认）或 [0, max] 内的非负整数。
 * 非法值只记录非敏感 warning（含 key，不含原始 value），不抛错。
 */
export function parseBudgetEnv(
  raw: string | undefined,
  key: string,
  max: number,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const trimmed = raw.trim();
  // 仅接受纯十进制非负整数；禁止小数 / 负数 / 前导符号 / 科学计数 / 空白夹杂。
  if (!/^\d+$/.test(trimmed)) {
    console.warn(`[daily-run] budget env ${key} 无效（须为非负十进制整数），已回退默认值`);
    return undefined;
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    console.warn(`[daily-run] budget env ${key} 超出安全整数范围，已回退默认值`);
    return undefined;
  }

  if (value > max) {
    console.warn(`[daily-run] budget env ${key} 超过上限 ${max}，已 clamp 到 ${max}`);
    return max;
  }

  return value;
}

/**
 * 从环境变量解析两个预算 override（未设置时不含对应 key）。
 */
export function resolveDailyBudgetOverrides(
  env: NodeJS.ProcessEnv = process.env,
): DailyBudgetOverrides {
  const overrides: DailyBudgetOverrides = {};
  const fetchBudget = parseBudgetEnv(env[ENV_FETCH_BUDGET], ENV_FETCH_BUDGET, DAILY_FETCH_BUDGET_MAX);
  if (fetchBudget !== undefined) overrides.fetchBudget = fetchBudget;
  const enrichmentBudget = parseBudgetEnv(
    env[ENV_ENRICHMENT_BUDGET],
    ENV_ENRICHMENT_BUDGET,
    DAILY_ENRICHMENT_BUDGET_MAX,
  );
  if (enrichmentBudget !== undefined) overrides.enrichmentBudget = enrichmentBudget;
  return overrides;
}
