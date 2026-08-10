/** cc-auto v0.2.0 Slice 1F — 任务成本复盘。
 *
 * 职责：
 * - 从真实 UsageRecord 中累计 RunningCostSnapshot
 * - 任务结束后生成 TaskCostSummary
 * - 计算 vs 预算偏差、vs 全程 Pro 节省、升级浪费
 * - 不访问网络、不读取凭证、不读取环境变量
 * - NaN/Infinity 防控：所有除法运算前检查分母
 */

import type {
  UsageRecord,
  ExecutionModelRole,
  RunningCostSnapshot,
  TaskCostSummary,
  TaskBudgetEstimate,
  CostByRoleEntry,
  EstimateComparison,
  RoutingEffect,
  ModelAttemptFailure,
  ModelSelection,
} from './types';
import type { ModelPricing } from './types';
import { computeAllProCostPerCall } from './costCalculator';

// ============================================================================
// RunningCostSnapshot
// ============================================================================

export interface SnapshotInput {
  runId: string;
  taskId: string;
  usageRecords: Array<{
    usage: UsageRecord;
    role: ExecutionModelRole;
    provider: string;
    modelLogicalName: string;
    /** 真实 callId，用于升级成本精确归因；缺失时降级为 role 匹配 */
    callId?: string;
  }>;
  estimate: TaskBudgetEstimate;
}

/**
 * 从累计 UsageRecord 生成运行中成本快照。
 */
export function buildRunningCostSnapshot(input: SnapshotInput): RunningCostSnapshot {
  const { runId, taskId, usageRecords, estimate } = input;

  let actualInputTokens = 0;
  let actualOutputTokens = 0;
  let actualCachedTokens = 0;
  let actualCostRmb = 0;
  let allCostsKnown = true;
  let allInputKnown = true;
  let allOutputKnown = true;
  let allCacheKnown = true;

  const byRole: RunningCostSnapshot['costByRole'] = {};

  for (const rec of usageRecords) {
    const inputT = rec.usage.inputTokens;
    const outputT = rec.usage.outputTokens;
    const cachedT = (rec.usage.cacheCreationInputTokens ?? 0) + (rec.usage.cacheReadInputTokens ?? 0);

    if (inputT === null || inputT === undefined) { allInputKnown = false; } else { actualInputTokens += inputT; }
    if (outputT === null || outputT === undefined) { allOutputKnown = false; } else { actualOutputTokens += outputT; }
    if (rec.usage.cacheCreationInputTokens === null || rec.usage.cacheCreationInputTokens === undefined
        || rec.usage.cacheReadInputTokens === null || rec.usage.cacheReadInputTokens === undefined) {
      allCacheKnown = false;
    }
    actualCachedTokens += cachedT;

    if (rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined) {
      actualCostRmb += rec.usage.costRmbCustom;
    } else {
      allCostsKnown = false;
    }

    const entry = byRole[rec.role];
    if (entry) {
      entry.calls++;
      if (inputT !== null && inputT !== undefined) entry.inputTokens = (entry.inputTokens ?? 0) + inputT;
      if (outputT !== null && outputT !== undefined) entry.outputTokens = (entry.outputTokens ?? 0) + outputT;
      entry.cachedTokens = (entry.cachedTokens ?? 0) + cachedT;
      if (rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined) {
        entry.costRmb = (entry.costRmb ?? 0) + rec.usage.costRmbCustom;
      }
    } else {
      byRole[rec.role] = {
        calls: 1,
        inputTokens: (inputT !== null && inputT !== undefined) ? inputT : null,
        outputTokens: (outputT !== null && outputT !== undefined) ? outputT : null,
        cachedTokens: cachedT,
        costRmb: (rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined) ? rec.usage.costRmbCustom : null,
      };
    }
  }

  // 比例计算（防 NaN/Infinity）
  const expectedCost = estimate.totalEstimatedCostRmb.expected;
  const maxCost = estimate.totalEstimatedCostRmb.max;
  const actualTotalCost = allCostsKnown ? actualCostRmb : null;

  const expectedBudgetUsedRatio = safeRatio(actualTotalCost, expectedCost);
  const maximumBudgetUsedRatio = safeRatio(actualTotalCost, maxCost);

  return {
    runId,
    taskId,
    completedCallCount: usageRecords.length,
    actualInputTokens: allInputKnown && usageRecords.length > 0 ? actualInputTokens : null,
    actualOutputTokens: allOutputKnown && usageRecords.length > 0 ? actualOutputTokens : null,
    actualCachedTokens: allCacheKnown && usageRecords.length > 0 ? actualCachedTokens : null,
    actualCostRmb: allCostsKnown && usageRecords.length > 0 ? actualCostRmb : null,
    expectedBudgetUsedRatio,
    maximumBudgetUsedRatio,
    costByRole: byRole,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// TaskCostSummary
// ============================================================================

export interface SummaryInput {
  runId: string;
  taskId: string;
  estimate: TaskBudgetEstimate;
  usageRecords: Array<{
    usage: UsageRecord;
    role: ExecutionModelRole;
    provider: string;
    modelLogicalName: string;
    /** 真实 callId，用于升级成本精确归因；缺失时降级为 role 匹配 */
    callId?: string;
  }>;
  selections: ModelSelection[];
  attempts: Array<{
    role: ExecutionModelRole;
    failure?: ModelAttemptFailure;
  }>;
  completed: boolean;
  /** 按 modelLogicalName → ModelPricing 的强模型定价，用于计算"全部 Pro"基准 */
  strongModelPricing: ModelPricing | null;
  strongModelLogicalName: string;
}

/**
 * 任务结束后生成 TaskCostSummary。
 * completed=false 时仍生成总结（标记未完成）。
 */
export function buildTaskCostSummary(input: SummaryInput): TaskCostSummary {
  const {
    runId, taskId, estimate, usageRecords, selections, attempts,
    completed, strongModelPricing,
  } = input;

  // --- actual totals ---
  // 分别跟踪四类 Token 的完整性（不合并后猜测）
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let allInputKnown = true;
  let allOutputKnown = true;
  let allCacheCreationKnown = true;
  let allCacheReadKnown = true;
  let totalCostRmb = 0;
  let allCostsKnown = true;

  for (const rec of usageRecords) {
    const inputT = rec.usage.inputTokens;
    const outputT = rec.usage.outputTokens;
    const cacheCreateT = rec.usage.cacheCreationInputTokens;
    const cacheReadT = rec.usage.cacheReadInputTokens;

    if (inputT === null || inputT === undefined) { allInputKnown = false; } else { totalInputTokens += inputT; }
    if (outputT === null || outputT === undefined) { allOutputKnown = false; } else { totalOutputTokens += outputT; }
    if (cacheCreateT === null || cacheCreateT === undefined) { allCacheCreationKnown = false; } else { totalCacheCreationTokens += cacheCreateT; }
    if (cacheReadT === null || cacheReadT === undefined) { allCacheReadKnown = false; } else { totalCacheReadTokens += cacheReadT; }

    if (rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined) {
      totalCostRmb += rec.usage.costRmbCustom;
    } else {
      allCostsKnown = false;
    }
  }

  const totalCachedTokens = totalCacheCreationTokens + totalCacheReadTokens;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const allCacheKnown = allCacheCreationKnown && allCacheReadKnown;

  // --- by role ---
  const roleMap = new Map<ExecutionModelRole, {
    provider: string;
    modelLogicalName: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costRmb: number | null;
    allCostsKnown: boolean;
  }>();

  for (const rec of usageRecords) {
    const existing = roleMap.get(rec.role);
    const inputT = rec.usage.inputTokens;
    const outputT = rec.usage.outputTokens;
    const cacheCreateT = rec.usage.cacheCreationInputTokens;
    const cacheReadT = rec.usage.cacheReadInputTokens;
    const cachedT = (cacheCreateT ?? 0) + (cacheReadT ?? 0);

    if (existing) {
      existing.calls++;
      if (inputT !== null && inputT !== undefined) existing.inputTokens += inputT;
      if (outputT !== null && outputT !== undefined) existing.outputTokens += outputT;
      existing.cachedTokens += cachedT;
      if (rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined) {
        existing.costRmb = (existing.costRmb ?? 0) + rec.usage.costRmbCustom;
      } else {
        existing.allCostsKnown = false;
      }
    } else {
      roleMap.set(rec.role, {
        provider: rec.provider,
        modelLogicalName: rec.modelLogicalName,
        calls: 1,
        inputTokens: (inputT !== null && inputT !== undefined) ? inputT : 0,
        outputTokens: (outputT !== null && outputT !== undefined) ? outputT : 0,
        cachedTokens: cachedT,
        costRmb: (rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined) ? rec.usage.costRmbCustom : null,
        allCostsKnown: rec.usage.costRmbCustom !== null && rec.usage.costRmbCustom !== undefined,
      });
    }
  }

  const byRole: CostByRoleEntry[] = [];
  for (const [role, data] of roleMap) {
    const roleTokens = data.inputTokens + data.outputTokens;
    // 各 Token 字段：有任何一条记录缺失对应类型即为 null
    const roleHasInput = !usageRecords.some((r) => r.role === role && (r.usage.inputTokens === null || r.usage.inputTokens === undefined));
    const roleHasOutput = !usageRecords.some((r) => r.role === role && (r.usage.outputTokens === null || r.usage.outputTokens === undefined));
    const roleHasCache = !usageRecords.some((r) => r.role === role && (r.usage.cacheCreationInputTokens === null || r.usage.cacheCreationInputTokens === undefined) && (r.usage.cacheReadInputTokens === null || r.usage.cacheReadInputTokens === undefined));
    byRole.push({
      role,
      provider: data.provider,
      modelLogicalName: data.modelLogicalName,
      calls: data.calls,
      inputTokens: roleHasInput ? data.inputTokens : null,
      outputTokens: roleHasOutput ? data.outputTokens : null,
      cachedTokens: roleHasCache ? data.cachedTokens : null,
      totalTokens: roleHasInput && roleHasOutput ? roleTokens : null,
      costRmb: data.allCostsKnown ? data.costRmb : null,
      tokenShare: safeRatio(roleHasInput && roleHasOutput ? roleTokens : null, totalTokens > 0 ? totalTokens : null),
      costShare: safeRatio(data.allCostsKnown ? data.costRmb ?? null : null, allCostsKnown ? totalCostRmb : null),
    });
  }

  // --- estimate comparison ---
  const expectedCost = estimate.totalEstimatedCostRmb.expected;
  const maxCost = estimate.totalEstimatedCostRmb.max;
  const actualCost = allCostsKnown ? totalCostRmb : null;

  const actualVsExpected = safeRatio(actualCost, expectedCost);
  const actualVsMax = safeRatio(actualCost, maxCost);
  const absoluteVariance = (actualCost !== null && expectedCost !== null)
    ? roundCost(actualCost - expectedCost) : null;
  const variancePercent = safeRatio((actualCost !== null && expectedCost !== null)
    ? Math.abs(actualCost - expectedCost) : null, expectedCost);

  const estimateComparison: EstimateComparison = {
    actualVsExpectedRatio: actualVsExpected,
    actualVsMaximumRatio: actualVsMax,
    absoluteVarianceRmb: absoluteVariance,
    variancePercent,
  };

  // --- routing effect ---
  const totalCalls = usageRecords.length;
  const flashCalls = roleMap.get('FAST_EXECUTOR')?.calls ?? 0;
  const proCalls = roleMap.get('STRONG_EXECUTOR')?.calls ?? 0;
  const opusCalls = roleMap.get('ARBITER')?.calls ?? 0;

  const flashCostRmb = roleMap.get('FAST_EXECUTOR')?.costRmb;
  const proCostRmb = roleMap.get('STRONG_EXECUTOR')?.costRmb;
  const opusCostRmb = roleMap.get('ARBITER')?.costRmb;

  const flashCallShare = safeRatio(flashCalls, totalCalls);
  const proCallShare = safeRatio(proCalls, totalCalls);
  const opusCallShare = safeRatio(opusCalls, totalCalls);
  const flashCostShare = safeRatio(flashCostRmb ?? null, allCostsKnown ? totalCostRmb : null);
  const proCostShare = safeRatio(proCostRmb ?? null, allCostsKnown ? totalCostRmb : null);
  const opusCostShare = safeRatio(opusCostRmb ?? null, allCostsKnown ? totalCostRmb : null);

  // escalation count + 升级浪费成本：按 selections → attempts 遍历，通过 escalatedFromCallId 精确查询 UsageRecord
  let escalationCount = 0;
  let escalationCostRmb = 0;
  let allEscalationCostsKnown = true;
  let lastRole: ExecutionModelRole | null = null;
  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    if (lastRole !== null && sel.role !== lastRole) {
      escalationCount++;
      // 升级发生：前一次尝试的失败成本计入升级浪费
      const prevAttempt = attempts[i - 1];
      if (prevAttempt?.failure && !prevAttempt.failure.contributedToFinalResult) {
        // 通过 escalatedFromCallId 精确查询 UsageRecord（生产路径必需）
        let matchedUsage: (typeof usageRecords)[number] | undefined;
        if (sel.escalatedFromCallId) {
          matchedUsage = usageRecords.find((r) => r.callId === sel.escalatedFromCallId);
        }
        // 1F-RUN fail closed: 缺 escalatedFromCallId → escalationCost = null（不可核验）
        // 不再通过 role 猜测——旧数据兼容仅适用于明确标记为 legacy 的运行。
        if (matchedUsage) {
          const cost = matchedUsage.usage.costRmbCustom;
          if (cost !== null && cost !== undefined) {
            escalationCostRmb += cost;
          } else {
            allEscalationCostsKnown = false;
          }
        } else if (!sel.escalatedFromCallId) {
          // escalatedFromCallId 缺失 → 无法精确归因 → escalation waste = null
          allEscalationCostsKnown = false;
        }
      }
    }
    lastRole = sel.role;
  }

  // 全程 Pro 基准：逐条 UsageRecord 使用 Pro PricingConfig 重算，不合并 Token、不取平均单价
  let hypotheticalAllProCostRmb: number | null = null;
  if (strongModelPricing && usageRecords.length > 0) {
    const usageRecordsOnly = usageRecords.map((r) => r.usage);
    const { sumCostRmb, completeness } = computeAllProCostPerCall(usageRecordsOnly, strongModelPricing);
    // 任一 UsageRecord Token 不完整或 Pro Pricing 缺失 → null
    if (completeness.allInputTokensKnown && completeness.allOutputTokensKnown
        && completeness.allCacheCreationTokensKnown && completeness.allCacheReadTokensKnown) {
      hypotheticalAllProCostRmb = sumCostRmb !== null ? roundCost(sumCostRmb) : null;
    } else {
      hypotheticalAllProCostRmb = null;
    }
  }

  let savedVsAllProRmb: number | null = null;
  let savedVsAllProPercent: number | null = null;
  if (hypotheticalAllProCostRmb !== null && actualCost !== null) {
    savedVsAllProRmb = roundCost(hypotheticalAllProCostRmb - actualCost);
    savedVsAllProPercent = safeRatio(
      savedVsAllProRmb > 0 ? savedVsAllProRmb : null,
      hypotheticalAllProCostRmb,
    );
  } else {
    // 全 Pro 基准不可计算时，节省为 null（不估猜）
    savedVsAllProRmb = null;
    savedVsAllProPercent = null;
  }

  const routingEffect: RoutingEffect = {
    flashCallShare,
    proCallShare,
    opusCallShare,
    flashCostShare,
    proCostShare,
    opusCostShare,
    escalationCount,
    escalationCostRmb: (allEscalationCostsKnown && escalationCount > 0 && escalationCostRmb > 0) ? escalationCostRmb : null,
    hypotheticalAllProCostRmb,
    savedVsAllProRmb,
    savedVsAllProPercent,
  };

  return {
    runId,
    taskId,
    currency: 'CNY',
    estimate,
    actual: {
      totalCalls,
      // 任一类型不完整时对应汇总字段为 null（不显示 0）
      inputTokens: allInputKnown && totalCalls > 0 ? totalInputTokens : null,
      outputTokens: allOutputKnown && totalCalls > 0 ? totalOutputTokens : null,
      cachedTokens: allCacheKnown && totalCalls > 0 ? totalCachedTokens : null,
      totalTokens: allInputKnown && allOutputKnown && totalCalls > 0 ? totalTokens : null,
      costRmb: allCostsKnown && totalCalls > 0 ? totalCostRmb : null,
    },
    byRole,
    estimateComparison,
    routingEffect,
    completed,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 辅助
// ============================================================================

/** 安全除法——分母为 0、null、NaN 时返回 null */
function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const result = numerator / denominator;
  if (!Number.isFinite(result)) return null;
  return result;
}

function roundCost(cost: number): number {
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ============================================================================
// 成本报告格式化（供 CLI / 报告使用）
// ============================================================================

/** 安全格式化人民币金额——null 时显示「无法计算」 */
export function formatCostRmbOrUnknown(cost: number | null): string {
  if (cost === null) return '无法计算';
  return `¥${cost.toFixed(4)}`;
}

/** 安全格式化百分比——null 时显示 N/A。
 *  @param ratio 0-1 比例值（如 0.262 表示 26.2%） */
export function formatPercentOrNA(ratio: number | null): string {
  if (ratio === null) return 'N/A';
  const pct = ratio * 100;
  return `${pct.toFixed(1)}%`;
}

/** 格式化角色显示名 */
export function formatRoleName(role: ExecutionModelRole): string {
  switch (role) {
    case 'FAST_EXECUTOR': return 'V4 Flash';
    case 'STRONG_EXECUTOR': return 'V4 Pro';
    case 'ARBITER': return 'Opus 5';
  }
}
