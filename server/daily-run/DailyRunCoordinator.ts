import type { SearchProviderConfig, SearchCoverage } from '../search-provider/types';
import type { SourceRun } from '../source-run/types';
import type { DailyJobBrief } from '../daily-brief/types';
import type { DailyPipelineResult } from '../pipeline/types';
import { expandQueries } from '../pipeline/taskExpansion';
import { parseDailySearchSchedule, todayInTimeZone } from './schedule';
import type {
  DailyRunCoordinatorDeps,
  DailyRunCoordinatorInput,
  DailyRunCoordinatorResult,
} from './types';

/**
 * DailyRunCoordinator —— 一次 Daily Discovery run 的生命周期（T028 闭环核心）。
 *
 * 只做外围生命周期，不重新实现 Search / SourcePolicy / Identity / Fetch / Upgrade /
 * Analysis / Recommendation / Brief identity：
 *   PlanVersion → create SourceRun → expand query → DailyPipeline.run →
 *   update SourceRun progress/terminal → persist DailyJobBrief。
 */

const EMPTY_COVERAGE: SearchCoverage = {
  queriesCompleted: 0,
  queriesFailed: 0,
  failedScopes: [],
  queryResults: [],
};

function emptySourceRun(
  id: string,
  searchPlanId: string,
  versionId: string,
  scheduledDay: string | null,
  triggerType: SourceRun['triggerType'],
  scheduledFor: number,
  providerKey: string,
  providerVersion: string,
  createdAt: number,
): SourceRun {
  return {
    id,
    searchPlanId,
    searchPlanVersionId: versionId,
    scheduledDay,
    sourceKey: providerKey,
    sourceVersion: providerVersion,
    triggerType,
    retryOfRunId: null,
    status: 'PENDING',
    phase: 'PREPARING',
    scheduledFor,
    startedAt: null,
    finishedAt: null,
    queriesAttempted: 0,
    queriesSucceeded: 0,
    queriesFailed: 0,
    resultsDiscovered: 0,
    relevantResults: 0,
    newCount: 0,
    changedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    blockedCount: 0,
    searchEvidencePersisted: 0,
    manualReviewRequired: 0,
    fullEvidenceCount: 0,
    analysisEligibleCount: 0,
    analysisRequestedCount: 0,
    analysisSucceededCount: 0,
    selectedCount: 0,
    alertedCount: 0,
    failedCount: 0,
    estimatedSearchCredits: null,
    actualSearchCredits: null,
    coverage: EMPTY_COVERAGE,
    progressJson: {},
    costSummaryJson: {},
    errorCode: null,
    errorMessage: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function buildProviderConfig(version: { scanBudget: Record<string, unknown> }): SearchProviderConfig {
  const budget = version.scanBudget;
  const maxResults = typeof budget.maxResults === 'number' ? budget.maxResults : undefined;
  return { maxResults };
}

/** 识别 better-sqlite3 的 UNIQUE 冲突（occurrence dedupe / FR-007 active concurrency）。 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  return /UNIQUE constraint failed/i.test(error.message);
}

export class DailyRunCoordinator {
  constructor(private readonly deps: DailyRunCoordinatorDeps) {}

  async run(input: DailyRunCoordinatorInput): Promise<DailyRunCoordinatorResult> {
    const { planRepo, sourceRunRepo, pipeline } = this.deps;
    const version = planRepo.getVersion(input.searchPlanVersionId);
    if (version === null) {
      throw new Error(`search plan version 不存在: ${input.searchPlanVersionId}`);
    }

    // 1) 在 Pipeline 前同步创建 SourceRun（partial UNIQUE 在 INSERT 时即防重）。
    const now = this.deps.now();
    const runId = this.deps.createId();
    const sourceRun = emptySourceRun(
      runId,
      version.searchPlanId,
      version.id,
      input.scheduledDay,
      input.triggerType,
      input.scheduledFor,
      this.deps.providerKey,
      this.deps.providerVersion,
      now,
    );
    try {
      sourceRunRepo.insert(sourceRun);
    } catch (error) {
      // 同 occurrence 已存在（occurrence dedupe）或同 plan 有 active run（FR-007）→ skip，不重复跑。
      if (isUniqueViolation(error)) return { outcome: 'skipped' };
      throw error;
    }
    sourceRunRepo.transitionStatus(runId, { toStatus: 'RUNNING' });
    sourceRunRepo.updateProgress(runId, { phase: 'DISCOVERING' });
    // 2) Query expansion（复用 taskExpansion，不重新实现）。
    const budget = version.scanBudget;
    const queries = expandQueries({
      cities: version.cities.map((c) => c.name),
      roleDirections: version.roleDirections,
      baseKeywords: version.baseKeywords,
      expandedKeywords: version.expandedKeywords,
      maxQueriesPerRun: typeof budget.maxQueriesPerRun === 'number' ? budget.maxQueriesPerRun : 30,
      maxExpandedKeywords: typeof budget.maxExpandedKeywords === 'number' ? budget.maxExpandedKeywords : 5,
    });

    // 3) DailyPipeline.run（真实编排，不重实现）。
    let pipelineResult: DailyPipelineResult;
    try {
      pipelineResult = await pipeline.run(queries, {
        config: buildProviderConfig(version),
        signal: input.signal,
      });
    } catch (error) {
      sourceRunRepo.updateProgress(runId, {
        errorCode: 'PIPELINE_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      sourceRunRepo.transitionStatus(runId, { toStatus: 'FAILED' });
      return { outcome: 'completed', sourceRunId: runId, status: 'FAILED', briefId: null };
    }

    // 4) 从 pipeline summary 近似投影 SourceRun 计数（query 级 coverage 由 pipeline 内部消费不暴露）。
    const summary = pipelineResult.summary;
    sourceRunRepo.updateProgress(runId, {
      phase: 'BUILDING_BRIEF',
      queriesAttempted: queries.length,
      resultsDiscovered: summary.total,
      searchEvidencePersisted: summary.discoveryOnly + summary.manualReview,
      manualReviewRequired: summary.manualReview,
      fullEvidenceCount: summary.analysisCompleted + summary.analysisFailed + summary.analysisBlocked,
      analysisRequestedCount: summary.analysisCompleted + summary.analysisFailed + summary.analysisAlreadyRunning + summary.analysisCancelled,
      analysisSucceededCount: summary.analysisCompleted,
      selectedCount: pipelineResult.recommendationScope.length,
      failedCount: summary.fetchFailed + summary.validationFailed + summary.upgradeFailed + summary.ingestFailed,
    });
    sourceRunRepo.transitionStatus(runId, { toStatus: 'SUCCEEDED' });

    // 5) DailyJobBrief 投影（identity = brief_date + search_plan_version_id，v13 唯一约束）。
    const briefId = this.persistBrief(runId, version.id, input.scheduledDay, pipelineResult);

    return { outcome: 'completed', sourceRunId: runId, status: 'SUCCEEDED', briefId };
  }

  private persistBrief(
    runId: string,
    versionId: string,
    scheduledDay: string | null,
    pipelineResult: DailyPipelineResult,
  ): string {
    const { planRepo, briefRepo } = this.deps;
    const version = planRepo.getVersion(versionId);
    const schedule = parseDailySearchSchedule(version?.schedule ?? {});
    const briefDate = scheduledDay ?? todayInTimeZone(this.deps.now(), schedule.timezone);

    const discoveryItemIds = pipelineResult.items
      .filter((item) => item.finalOutcome === 'manualReview' || item.finalOutcome === 'discoveryOnly')
      .map((item) => item.sourceVersionId)
      .filter((id): id is string => id !== null);

    // Pipeline 无推荐 scope → 幂等空批次；否则用本次真实 batch。
    const incomingBatchId = pipelineResult.recommendationBatchId ?? this.deps.createEmptyBatch();

    const existing = briefRepo.findByLogicalIdentity(briefDate, versionId);
    if (existing !== null) {
      // MONOTONIC USEFULNESS reconciliation（v0.9 DailyBrief contract）：
      //   空结果可被非空结果升级；非空结果不得被后续空结果降级。
      //   仅当「已有非空 + 本次空」时保留已有非空批次；其余（空→空 / 空→非空 / 非空→非空）
      //   都取本次批次（空→空 保持空、非空→非空 取最新成功非空）。
      const existingNonEmpty = this.isNonEmptyBatch(existing.recommendationBatchId);
      const incomingNonEmpty = this.isNonEmptyBatch(incomingBatchId);
      const selectedBatchId = existingNonEmpty && !incomingNonEmpty
        ? existing.recommendationBatchId
        : incomingBatchId;
      briefRepo.updateProjection(existing.id, {
        sourceRunIds: [...new Set([...existing.sourceRunIds, runId])],
        coverage: EMPTY_COVERAGE,
        recommendationBatchId: selectedBatchId,
        discoveryItemIds,
        emptyReason: this.emptyReasonFor(selectedBatchId, discoveryItemIds),
      });
      return existing.id;
    }

    const brief: DailyJobBrief = {
      id: this.deps.createId(),
      briefDate,
      searchPlanVersionId: versionId,
      sourceRunIds: [runId],
      recommendationBatchId: incomingBatchId,
      discoveryItemIds,
      status: 'READY',
      coverage: EMPTY_COVERAGE,
      costSummaryJson: null,
      emptyReason: this.emptyReasonFor(incomingBatchId, discoveryItemIds),
      generatedAt: this.deps.now(),
      completedAt: null,
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
    };
    briefRepo.insert(brief);
    return brief.id;
  }

  /** 读真实批次判断是否含推荐（selectedCandidateVersionIds 非空），不猜 id/emptyReason。 */
  private isNonEmptyBatch(batchId: string): boolean {
    const batch = this.deps.getBatch(batchId);
    return batch !== null && batch.selectedCandidateVersionIds.length > 0;
  }

  /** emptyReason 与最终 selected batch 保持一致：有推荐 → 永远 null（不得自相矛盾）。 */
  private emptyReasonFor(batchId: string, discoveryItemIds: string[]): string | null {
    if (this.isNonEmptyBatch(batchId)) return null;
    return discoveryItemIds.length === 0 ? '今日未发现值得处理的新岗位' : null;
  }
}
