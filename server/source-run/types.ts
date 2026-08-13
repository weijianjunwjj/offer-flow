/**
 * OfferFlow v0.9 — SourceRun 领域类型（Provider-neutral）。
 *
 * Task: T029
 * 设计依据：specs/001-daily-job-hunter/data-model.md §1.3、plan.md §2.8
 *
 * SourceRun = 一次真实 Daily Discovery execution 的稳定运行身份（A 语义）：
 *   - 包裹整个 DailyPipeline run，而非单次 Search Provider 调用；
 *   - 承载搜索计数 / Ingestion 计数 / Evidence 计数 / Analysis 计数与 coverage 快照，
 *     作为 DailyJobBrief 的来源身份链之一（sourceRunIds）。
 *
 * 本文件只定义类型，不含 DB 映射或持久化逻辑（见 sourceRunRepository.ts）。
 */

import type { SearchCoverage } from '../search-provider/types';

/** 触发类型。 */
export type SourceRunTriggerType = 'SCHEDULED' | 'CATCH_UP' | 'MANUAL' | 'RETRY';

export const SOURCE_RUN_TRIGGER_TYPES: readonly SourceRunTriggerType[] = [
  'SCHEDULED',
  'CATCH_UP',
  'MANUAL',
  'RETRY',
];

/** 运行状态。 */
export type SourceRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_FOR_USER'
  | 'PARTIALLY_SUCCEEDED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export const SOURCE_RUN_STATUSES: readonly SourceRunStatus[] = [
  'PENDING',
  'RUNNING',
  'WAITING_FOR_USER',
  'PARTIALLY_SUCCEEDED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
];

/** 运行阶段（对应 DailyPipeline canonical 阶段顺序）。 */
export type SourceRunPhase =
  | 'PREPARING'
  | 'DISCOVERING'
  | 'INGESTING'
  | 'ANALYZING'
  | 'RECOMMENDING'
  | 'BUILDING_BRIEF';

export const SOURCE_RUN_PHASES: readonly SourceRunPhase[] = [
  'PREPARING',
  'DISCOVERING',
  'INGESTING',
  'ANALYZING',
  'RECOMMENDING',
  'BUILDING_BRIEF',
];

/** 终态状态集合：终态不可再转移。 */
export const SOURCE_RUN_TERMINAL_STATUSES: readonly SourceRunStatus[] = [
  'PARTIALLY_SUCCEEDED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
];

/**
 * 一次主动发现运行。JSON 字段（coverage / progressJson / costSummaryJson）
 * 在 DB 层以 TEXT 存储，读取时反序列化。coverage 复用 SearchCoverage，
 * 不新建第二套 coverage domain（见 T040 Coverage 决策）。
 */
export interface SourceRun {
  id: string;
  searchPlanVersionId: string;
  sourceKey: string;
  sourceVersion: string;
  triggerType: SourceRunTriggerType;
  retryOfRunId: string | null;
  status: SourceRunStatus;
  phase: SourceRunPhase;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  queriesAttempted: number;
  queriesSucceeded: number;
  queriesFailed: number;
  resultsDiscovered: number;
  relevantResults: number;
  newCount: number;
  changedCount: number;
  duplicateCount: number;
  conflictCount: number;
  blockedCount: number;
  searchEvidencePersisted: number;
  manualReviewRequired: number;
  fullEvidenceCount: number;
  analysisEligibleCount: number;
  analysisRequestedCount: number;
  analysisSucceededCount: number;
  selectedCount: number;
  alertedCount: number;
  failedCount: number;
  estimatedSearchCredits: number | null;
  actualSearchCredits: number | null;
  coverage: SearchCoverage;
  progressJson: Record<string, unknown>;
  costSummaryJson: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}
