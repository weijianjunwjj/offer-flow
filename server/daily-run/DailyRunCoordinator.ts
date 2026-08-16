import type { SearchProviderConfig, SearchCoverage } from '../search-provider/types';
import type { SourceRun, SourceRunStatus } from '../source-run/types';
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

    // 4) 从真实 provider coverage 投影 query 计数（不再用 queries.length 近似、不再丢失 coverage）。
    const summary = pipelineResult.summary;
    const coverage = pipelineResult.coverage;
    const queriesSucceeded = coverage.queriesCompleted;
    const queriesFailed = coverage.queriesFailed;
    const queriesAttempted = queriesSucceeded + queriesFailed;

    // 终态语义（FR-015 / SC-012 / User Story 5）：
    //   all queries failed → FAILED（绝不 SUCCEEDED，绝不伪装业务 empty）
    //   partial（部分成功部分失败）→ PARTIALLY_SUCCEEDED
    //   无失败 → SUCCEEDED（含合法 VALID_EMPTY 空结果）
    const terminalStatus: SourceRunStatus =
      queriesFailed > 0
        ? (queriesSucceeded > 0 ? 'PARTIALLY_SUCCEEDED' : 'FAILED')
        : 'SUCCEEDED';

    sourceRunRepo.updateProgress(runId, {
      phase: 'BUILDING_BRIEF',
      queriesAttempted,
      queriesSucceeded,
      queriesFailed,
      coverage,
      resultsDiscovered: summary.total,
      searchEvidencePersisted: summary.discoveryOnly + summary.manualReview,
      manualReviewRequired: summary.manualReview,
      fullEvidenceCount: summary.analysisCompleted + summary.analysisFailed + summary.analysisBlocked,
      analysisRequestedCount: summary.analysisCompleted + summary.analysisFailed + summary.analysisAlreadyRunning + summary.analysisCancelled,
      analysisSucceededCount: summary.analysisCompleted,
      selectedCount: pipelineResult.recommendationScope.length,
      failedCount: summary.fetchFailed + summary.validationFailed + summary.upgradeFailed + summary.ingestFailed,
    });

    // 全部查询失败 → 明确失败终态 + 来源失败错误码；绝不生成业务意义上的空 Brief。
    if (terminalStatus === 'FAILED') {
      sourceRunRepo.transitionStatus(runId, {
        toStatus: 'FAILED',
        errorCode: 'ALL_QUERIES_FAILED',
        errorMessage: this.failureSummary(coverage),
      });
      return { outcome: 'completed', sourceRunId: runId, status: 'FAILED', briefId: null };
    }

    sourceRunRepo.transitionStatus(runId, { toStatus: terminalStatus });

    // 5) DailyJobBrief 投影（identity = brief_date + search_plan_version_id，v13 唯一约束）。
    const briefId = this.persistBrief(runId, version.id, input.scheduledDay, pipelineResult);

    return { outcome: 'completed', sourceRunId: runId, status: terminalStatus, briefId };
  }

  /** 来源失败摘要：只取 failedScopes 的 queryKey + errorCode（绝不落 raw body / secret）。 */
  private failureSummary(coverage: SearchCoverage): string {
    const parts = coverage.failedScopes
      .slice(0, 5)
      .map((f) => `${f.queryKey}:${f.errorCode}`);
    const extra = coverage.failedScopes.length - parts.length;
    const suffix = extra > 0 ? ` +${extra}` : '';
    return `来源搜索失败: ${parts.join(', ')}${suffix}`;
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

    // Discovery 成立于 Initial Ingestion 成功（sourceVersionId 非空）。
    // 因此除 manualReview / discoveryOnly 外，enrichment 失败的终态
    // （fetchFailed / validationFailed / upgradeBlocked / upgradeFailed）也必须保留其
    // SEARCH_EVIDENCE discovery，不得因 fetch/validation/upgrade 失败反向抹掉「发现过该岗位」。
    // 同 CandidateVersion 可能被多个 query 命中，按 identity 去重，保证 Brief 内只出现一次。
    const incomingDiscoveryItemIds = [...new Set(
      pipelineResult.items
        .filter((item) => (
          item.finalOutcome === 'manualReview'
          || item.finalOutcome === 'discoveryOnly'
          || item.finalOutcome === 'fetchFailed'
          || item.finalOutcome === 'validationFailed'
          || item.finalOutcome === 'upgradeBlocked'
          || item.finalOutcome === 'upgradeFailed'
        ))
        .map((item) => item.sourceVersionId)
        .filter((id): id is string => id !== null),
    )];

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
      // discovery 采用 day-level monotonic union（DailyBrief 是日级 projection）：
      //   既有顺序优先 + 本次新增的 ids 追加，去重且稳定排序；
      //   本次空结果不删除既有发现，也不让 emptyReason 误判为「今日无发现」。
      const mergedDiscoveryItemIds = [...new Set([
        ...existing.discoveryItemIds,
        ...incomingDiscoveryItemIds,
      ])];
      briefRepo.updateProjection(existing.id, {
        sourceRunIds: [...new Set([...existing.sourceRunIds, runId])],
        coverage: this.mergeCoverage(existing.coverage, pipelineResult.coverage),
        recommendationBatchId: selectedBatchId,
        discoveryItemIds: mergedDiscoveryItemIds,
        emptyReason: this.emptyReasonFor(selectedBatchId, mergedDiscoveryItemIds),
      });
      return existing.id;
    }

    const brief: DailyJobBrief = {
      id: this.deps.createId(),
      briefDate,
      searchPlanVersionId: versionId,
      sourceRunIds: [runId],
      recommendationBatchId: incomingBatchId,
      discoveryItemIds: incomingDiscoveryItemIds,
      status: 'READY',
      coverage: pipelineResult.coverage,
      costSummaryJson: null,
      emptyReason: this.emptyReasonFor(incomingBatchId, incomingDiscoveryItemIds),
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

  /**
   * 日级 coverage 累积合并（多 run 追加同一 logical brief 时）。
   *
   * 语义冻结（GATE 1）：SearchCoverage 的 counters 与列表本就是两套语义——
   *   queriesCompleted / queriesFailed = 查询「执行次数」计数，跨 run 直接累计（30 + 30 = 60 是 intentional）；
   *   failedScopes / queryResults = 按 queryKey 的「逻辑覆盖」记录，跨 run 按 queryKey 去重后追加（同一查询只保留一条）。
   * 与前端「完成查询 N 次 / 覆盖 M 个查询」两个不同维度一致，不是无意的双语义。
   */
  private mergeCoverage(existing: SearchCoverage, incoming: SearchCoverage): SearchCoverage {
    const failedKeys = new Set(existing.failedScopes.map((f) => f.queryKey));
    const resultKeys = new Set(existing.queryResults.map((r) => r.queryKey));
    return {
      queriesCompleted: existing.queriesCompleted + incoming.queriesCompleted,
      queriesFailed: existing.queriesFailed + incoming.queriesFailed,
      failedScopes: [
        ...existing.failedScopes,
        ...incoming.failedScopes.filter((f) => !failedKeys.has(f.queryKey)),
      ],
      queryResults: [
        ...existing.queryResults,
        ...incoming.queryResults.filter((r) => !resultKeys.has(r.queryKey)),
      ],
    };
  }
}
