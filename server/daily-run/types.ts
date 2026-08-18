import type { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import type { SourceRunRepository } from '../source-run/sourceRunRepository';
import type { SourceRunStatus, SourceRunTriggerType } from '../source-run/types';
import type { DailyBriefRepository } from '../daily-brief/dailyBriefRepository';
import type { DailyPipeline } from '../pipeline/DailyPipeline';

/**
 * DailyRunCoordinator 一次运行生命周期契约。
 *
 * 边界（Architecture Decision）：
 *   DailyJobScheduler = WHEN；DailyRunCoordinator = ONE RUN LIFECYCLE；
 *   DailyPipeline = SEARCH → RECOMMENDATION（保持封板）。
 *
 * Coordinator 负责：PlanVersion → create SourceRun → expand query → Pipeline.run →
 * 更新 SourceRun progress/terminal → persist DailyJobBrief。不重新实现下层任何 domain 逻辑。
 */

export interface DailyRunCoordinatorInput {
  searchPlanVersionId: string;
  triggerType: SourceRunTriggerType;
  /** 该 occurrence 对应的绝对 UTC instant（不是实际开始时间）。 */
  scheduledFor: number;
  /** 该 occurrence 在 plan timezone 下的自然日 YYYY-MM-DD（SCHEDULED/CATCH_UP 必填，其余 null）。 */
  scheduledDay: string | null;
  signal?: AbortSignal;
}

export interface DailyRunCoordinatorDeps {
  planRepo: SearchPlanRepository;
  sourceRunRepo: SourceRunRepository;
  briefRepo: DailyBriefRepository;
  pipeline: DailyPipeline;
  providerKey: string;
  providerVersion: string;
  /** 返回一个幂等空批次 id（Pipeline 无推荐 scope 时 brief 仍需引用 batch）。 */
  createEmptyBatch: () => string;
  /**
   * 可选 runtime budget override（来自 env OFFERFLOW_DAILY_FETCH_BUDGET / OFFERFLOW_DAILY_ENRICHMENT_BUDGET）。
   * undefined → 沿用 DailyPipeline 默认值；设置后由 coordinator 传给 pipeline.run()。
   */
  fetchBudget?: number;
  enrichmentBudget?: number;
  /**
   * 读取一个推荐批次以判断 empty/non-empty（DailyBrief reconciliation 用）。
   * 返回 null 表示批次不存在（视为 empty）。只暴露 selectedCandidateVersionIds 最小契约，
   * 不把完整 RadarRecommendationBatch 耦合进 coordinator；是否含推荐以真实 domain data
   * （selectedCandidateVersionIds 非空）为准，不猜 id 命名或 emptyReason 字符串。
   */
  getBatch: (id: string) => { selectedCandidateVersionIds: string[] } | null;
  createId: () => string;
  now: () => number;
}

export type DailyRunCoordinatorResult =
  | { outcome: 'completed'; sourceRunId: string; status: SourceRunStatus; briefId: string | null }
  | { outcome: 'skipped' };
