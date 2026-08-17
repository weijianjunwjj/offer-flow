/** cc-auto v0.2.0 Slice 1B — Usage 标准化与 null 语义。
 *
 * 规则：
 * - Provider 明确返回 0 → 保存 0
 * - 未返回 → null
 * - 所有 usage 字段都缺失 → MISSING
 * - 部分字段缺失 → PARTIAL
 * - 所有必要字段完整 → AVAILABLE
 * - 不得将 null 转为 0
 * - 不得将未知费用显示为 ¥0.00
 *
 * 费用安全计算所需字段（保守规则）：
 * - 只要 usageStatus !== AVAILABLE，costStatus = UNAVAILABLE（fail closed）
 */
import type { RawProviderUsage, UsageStatus, CostStatus, UsageRecord, ModelIdentityStatus } from './types';

/** Usage 分类结果——仅关注字段可用性，不包含计算 */
export interface UsageClassification {
  usageStatus: UsageStatus;
  /** 哪些 token 字段为 null（用于报告） */
  missingTokenFields: string[];
}

/**
 * 对 RawProviderUsage 执行 null 语义分类。
 */
export function classifyUsage(raw: RawProviderUsage): UsageClassification {
  const fields = [
    { name: 'inputTokens', value: raw.inputTokens },
    { name: 'outputTokens', value: raw.outputTokens },
    { name: 'cacheCreationInputTokens', value: raw.cacheCreationInputTokens },
    { name: 'cacheReadInputTokens', value: raw.cacheReadInputTokens },
  ];

  const missingTokenFields = fields.filter((f) => f.value === null).map((f) => f.name);
  const nullCount = missingTokenFields.length;
  const totalCount = fields.length;

  let usageStatus: UsageStatus;
  if (nullCount === 0) {
    usageStatus = 'AVAILABLE';
  } else if (nullCount === totalCount) {
    usageStatus = 'MISSING';
  } else {
    usageStatus = 'PARTIAL';
  }

  return { usageStatus, missingTokenFields };
}

/**
 * 判定 costStatus：保守 fail-closed 规则。
 * 只要 usageStatus 不是 AVAILABLE，costStatus 即为 UNAVAILABLE。
 */
export function determineCostStatus(usageStatus: UsageStatus): CostStatus {
  return usageStatus === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE';
}

export interface BuildUsageRecordInput {
  model: 'builder' | 'arbiter';
  requestedModelId: string;
  reportedModel: string | null;
  providerId: string;
  modelIdentityStatus: ModelIdentityStatus;
  rawUsage: RawProviderUsage;
  pricingStatus: 'PRICED' | 'UNPRICED';
  costRmbCustom: number | null;
  costRmbOfficial: number | null;
  durationMs: number | null;
  numTurns: number;
  subtype: string;
  isError: boolean;
  toolUseCounts?: Record<string, number> | null;
  toolErrorCounts?: Record<string, number> | null;
  permissionDenialsCount?: number;
  /** 本次调用的运行时执行角色；legacy 为 null，不得伪装成 FAST */
  executionRole?: import('./types').RuntimeExecutionRole | null;
}

/**
 * 从原始数据构造标准化的 UsageRecord。
 * 保留 null 语义，不将 null 转为 0。
 *
 * costStatus 判定同时考虑：
 * - usageStatus（token 字段完整性）
 * - modelIdentityStatus（UNVERIFIED → 无法确认实际计费模型 → costStatus=UNAVAILABLE）
 * - pricingStatus（UNPRICED → 价格不可用 → costStatus=UNAVAILABLE）
 */
export function buildUsageRecord(input: BuildUsageRecordInput): UsageRecord {
  const { usageStatus } = classifyUsage(input.rawUsage);
  let costStatus: CostStatus = determineCostStatus(usageStatus);

  // UNVERIFIED：实际计费模型无法确认，即使 usage 完整也不能确认成本
  if (input.modelIdentityStatus === 'UNVERIFIED') {
    costStatus = 'UNAVAILABLE';
  }
  // PRICING_NOT_FOUND / UNPRICED：定价不可用
  if (input.pricingStatus === 'UNPRICED') {
    costStatus = 'UNAVAILABLE';
  }

  return {
    model: input.model,
    requestedModelId: input.requestedModelId,
    reportedModel: input.reportedModel,
    providerId: input.providerId,
    modelIdentityStatus: input.modelIdentityStatus,
    pricingStatus: input.pricingStatus,
    usageStatus,
    costStatus,
    inputTokens: input.rawUsage.inputTokens,
    outputTokens: input.rawUsage.outputTokens,
    cacheCreationInputTokens: input.rawUsage.cacheCreationInputTokens,
    cacheReadInputTokens: input.rawUsage.cacheReadInputTokens,
    costRmbCustom: input.costRmbCustom,
    costRmbOfficial: input.costRmbOfficial,
    durationMs: input.durationMs,
    numTurns: input.numTurns,
    subtype: input.subtype,
    isError: input.isError,
    toolUseCounts: input.toolUseCounts ?? null,
    toolErrorCounts: input.toolErrorCounts ?? null,
    permissionDenialsCount: input.permissionDenialsCount ?? 0,
    executionRole: input.executionRole ?? null,
  };
}

/**
 * 安全格式化人民币费用——null 时返回明确提示，绝不显示 ¥0.00。
 */
export function formatCostRmb(cost: number | null): string {
  if (cost === null) return '(无法计算)';
  return `¥${cost.toFixed(6)}`;
}
