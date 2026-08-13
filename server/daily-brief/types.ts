/**
 * OfferFlow v0.9 — DailyJobBrief 领域类型。
 *
 * Task: T040
 * 设计依据：specs/001-daily-job-hunter/data-model.md §1.4、plan.md §2.16
 *
 * DailyJobBrief = 每日岗位简报（下游 projection / persistence），不是第二个 Pipeline：
 *   - recommendationBatchId 是正式推荐的唯一权威引用（FULL_EVIDENCE，0～8 条）；
 *   - discoveryItemIds 是 supplementary 发现条目（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED），
 *     不是第二套推荐；
 *   - coverage 复用 SearchCoverage，不新建第二套 coverage domain（见 T040 Coverage 决策）；
 *   - costSummaryJson 可空（T043 依赖延后）：null = cost summary 尚未计算。
 *
 * 本文件只定义类型，不含 DB 映射或持久化逻辑（见 dailyBriefRepository.ts）。
 */

import type { SearchCoverage } from '../search-provider/types';

/** 简报状态。 */
export type DailyJobBriefStatus = 'GENERATING' | 'READY' | 'IN_REVIEW' | 'COMPLETED' | 'FAILED';

export const DAILY_JOB_BRIEF_STATUSES: readonly DailyJobBriefStatus[] = [
  'GENERATING',
  'READY',
  'IN_REVIEW',
  'COMPLETED',
  'FAILED',
];

/**
 * CostSummary 最小占位（plan.md §2.21）。T043 负责计算与写入；
 * 本 task 只定义可空语义与字段形状，不实现任何成本计算。
 */
export interface CostSummary {
  estimatedSearchCredits?: number;
  actualSearchCredits?: number;
  analysisCount?: number;
  modelUsage?: string;
  tokenCount?: number;
  actualCost?: number;
}

export interface DailyJobBrief {
  id: string;
  briefDate: string;
  searchPlanVersionId: string;
  /** 当日主动发现运行 ID 列表（provenance 主链）。 */
  sourceRunIds: string[];
  /** 正式推荐批次引用（唯一权威推荐集合）。 */
  recommendationBatchId: string;
  /** SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 候选版本 ID（supplementary）。 */
  discoveryItemIds: string[];
  status: DailyJobBriefStatus;
  coverage: SearchCoverage;
  /** null = cost summary 尚未计算（T043 再补充）。 */
  costSummaryJson: CostSummary | null;
  /** 无推荐且无发现时填写。 */
  emptyReason: string | null;
  generatedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
