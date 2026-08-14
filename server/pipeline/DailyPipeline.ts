/**
 * OfferFlow v0.9 — DailyPipeline 编排（Phase 5B 核心）。
 *
 * 设计依据：Phase 5B Implementation Scope Lock FINAL v2。
 *
 * DailyPipeline 只做 sequential orchestration，严格复用下层现有组件：
 *   SearchProviderAdapter → DiscoveryIngestionBridge → ContentFetcher →
 *   EvidenceUpgradeService → AnalysisService → RecommendationBatchService。
 *
 * 硬边界（本文件绝不越界）：
 *   - 不写 SQL、不做 identity resolution / material-change / URL dedupe；
 *   - 不做 Source Policy allowlist、不做 evidence-upgrade persistence；
 *   - 不做 analysis task dedupe、不做 recommendation batch dedupe；
 *   - 不实现 DailyJobBrief / Scheduler / Email / SourceRun / worker daemon / retry / queue；
 *   - 不修改下层任何契约或状态机。
 */

import type {
  DailyPipelineDeps,
  DailyPipelineResult,
  DailyPipelineRunOptions,
  DailyPipelineSummary,
  PipelineItemFinalOutcome,
  PipelineItemMilestones,
  PipelineItemOutcome,
} from './types';
import type { SearchEvidenceItem, SearchProviderRequest, SearchQuery } from '../search-provider/types';
import type { ContentFetchRequest } from '../content-acquisition/types';
import type { DiscoveryIngestionItemOutcome } from '../radar/searchEvidence/DiscoveryIngestionBridge';
import type { AnalysisTask } from '../../src/domain/radar';
import { AnalysisInputError } from '../radar/analysis/inputErrors';

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function emptyMilestones(): PipelineItemMilestones {
  return {
    ingested: false,
    fetchAttempted: false,
    upgraded: false,
    alreadyUpgraded: false,
    analysisTaskCreated: false,
    analysisCompleted: false,
    inRecommendationScope: false,
  };
}

/** summary 从 milestones 汇总，不引入第二套状态。 */
function summarize(milestones: PipelineItemMilestones): string {
  const parts: string[] = [];
  if (milestones.ingested) parts.push('ingested');
  if (milestones.fetchAttempted) parts.push('fetchAttempted');
  if (milestones.upgraded) parts.push('upgraded');
  if (milestones.alreadyUpgraded) parts.push('alreadyUpgraded');
  if (milestones.analysisTaskCreated) parts.push('analysisTaskCreated');
  if (milestones.analysisCompleted) parts.push('analysisCompleted');
  if (milestones.inRecommendationScope) parts.push('inRecommendationScope');
  return parts.join('→') || 'none';
}

function terminal(
  index: number,
  itemUrl: string,
  candidateId: string | null,
  sourceVersionId: string | null,
  finalVersionId: string | null,
  finalOutcome: PipelineItemFinalOutcome,
  reasonCode: string | null,
  milestones: PipelineItemMilestones,
): PipelineItemOutcome {
  return {
    index,
    itemUrl,
    candidateId,
    sourceVersionId,
    finalVersionId,
    finalOutcome,
    reasonCode,
    milestones,
    summary: summarize(milestones),
  };
}

function buildSummary(
  items: PipelineItemOutcome[],
  recommendationBatchId: string | null,
  recommendationBatchCreated: boolean,
): DailyPipelineSummary {
  const counts: Record<PipelineItemFinalOutcome, number> = {
    analysisCompleted: 0,
    analysisFailed: 0,
    analysisBlocked: 0,
    analysisAlreadyRunning: 0,
    analysisCancelled: 0,
    manualReview: 0,
    discoveryOnly: 0,
    fetchFailed: 0,
    validationFailed: 0,
    upgradeBlocked: 0,
    upgradeFailed: 0,
    ingestFailed: 0,
    aborted: 0,
  };
  for (const item of items) counts[item.finalOutcome] += 1;
  return {
    total: items.length,
    ...counts,
    recommendationBatchId,
    recommendationBatchCreated,
  };
}

export class DailyPipeline {
  constructor(private readonly deps: DailyPipelineDeps) {}

  /**
   * 执行一轮 Discovery Pipeline：search → ingest → per-item resolve/upgrade/analysis → recommendation。
   * sequential orchestration：正确性优先，不做并发/worker/queue。
   */
  async run(
    queries: SearchQuery[],
    options: DailyPipelineRunOptions = {},
  ): Promise<DailyPipelineResult> {
    const signal = options.signal ?? neverAborted();
    const config = options.config ?? {};

    const request: SearchProviderRequest = { queries, config, signal };
    const searchResult = await this.deps.search(request);
    const ingestion = await this.deps.ingestDiscovery(searchResult);

    const items: PipelineItemOutcome[] = [];
    const recommendationScope: string[] = [];

    for (let i = 0; i < ingestion.items.length; i += 1) {
      // 每个新 item 前检查 abort：已 abort 则不启动下一 item 的任何新阶段。
      if (signal.aborted) break;

      const providerItem: SearchEvidenceItem | undefined = searchResult.items[i];
      const bridge: DiscoveryIngestionItemOutcome = ingestion.items[i];
      const outcome = await this.processItem(i, bridge, providerItem, signal);
      items.push(outcome);

      if (outcome.finalOutcome === 'analysisCompleted' && outcome.finalVersionId !== null) {
        recommendationScope.push(outcome.finalVersionId);
      }
    }

    // Recommendation：整个 run 至多调用一次，scope 为空则跳过。
    let recommendationBatchId: string | null = null;
    let recommendationBatchCreated = false;
    if (!signal.aborted && recommendationScope.length > 0) {
      const batchResult = this.deps.createBatch(recommendationScope);
      recommendationBatchId = batchResult.batch.id;
      recommendationBatchCreated = batchResult.created;
    }

    return {
      items,
      recommendationScope,
      recommendationBatchId,
      summary: buildSummary(items, recommendationBatchId, recommendationBatchCreated),
      coverage: searchResult.coverage,
    };
  }

  // ── Per-item 主流程 ─────────────────────────────────────────────────────────

  private async processItem(
    index: number,
    bridge: DiscoveryIngestionItemOutcome,
    providerItem: SearchEvidenceItem | undefined,
    signal: AbortSignal,
  ): Promise<PipelineItemOutcome> {
    const milestones = emptyMilestones();
    const itemUrl = bridge.itemUrl;

    // Defensive consistency：bridge 结果必须与 provider item 按 index + itemUrl 对齐。
    if (providerItem === undefined || providerItem.url !== itemUrl) {
      return terminal(index, itemUrl, null, null, null, 'ingestFailed', 'CONSISTENCY_MISMATCH', milestones);
    }

    if (bridge.skipped) {
      return terminal(index, itemUrl, bridge.candidateId, null, null, 'ingestFailed', bridge.errorReason, milestones);
    }
    milestones.ingested = true;

    const candidateId = bridge.candidateId;
    const sourceVersionId = bridge.candidateVersionId;

    if (sourceVersionId === null) {
      return terminal(index, itemUrl, candidateId, null, null, 'discoveryOnly', bridge.decisionType ?? 'no_version', milestones);
    }

    // 精确读取返回版本的真实 evidence state，不猜 active、不 find latest。
    const version = this.deps.getVersion(sourceVersionId);
    if (version === null) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'analysisBlocked', 'CANDIDATE_VERSION_NOT_FOUND', milestones);
    }

    const evidenceLevel = version.evidenceLevel;

    // B7：已有 FULL_EVIDENCE fast path —— 跳过 fetch + upgrade，直接分析。
    if (evidenceLevel === 'FULL_EVIDENCE') {
      return this.analyzeFinalVersion(index, itemUrl, candidateId, sourceVersionId, sourceVersionId, milestones, signal);
    }

    // B8：SEARCH_EVIDENCE fetch path。
    if (evidenceLevel === 'SEARCH_EVIDENCE') {
      if (bridge.fetchEligible !== true) {
        // B10：SEARCH_EVIDENCE + fetchEligible=false → 不 fetch、不分析。
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'discoveryOnly', 'fetch_not_eligible', milestones);
      }
      return this.fetchAndUpgrade(index, itemUrl, candidateId, sourceVersionId, bridge.normalizedDomain, milestones, signal);
    }

    // B10：MANUAL_REVIEW_REQUIRED → 不 fetch、不分析。
    return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'manualReview', 'manual_review_required', milestones);
  }

  // ── Content Acquisition + Evidence Upgrade ─────────────────────────────────

  private async fetchAndUpgrade(
    index: number,
    itemUrl: string,
    candidateId: string | null,
    sourceVersionId: string,
    normalizedDomain: string,
    milestones: PipelineItemMilestones,
    signal: AbortSignal,
  ): Promise<PipelineItemOutcome> {
    if (signal.aborted) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'aborted', 'ABORTED', milestones);
    }
    milestones.fetchAttempted = true;

    const request: ContentFetchRequest = {
      url: itemUrl,
      normalizedDomain,
      sourcePolicy: 'SEARCH_AND_FETCH',
    };
    const fetchResult = await this.deps.fetch(request);

    // FetchResult 非 FETCHED → 当前 item terminal，按真实 status 记录。
    if (fetchResult.status !== 'FETCHED') {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'fetchFailed', fetchResult.status, milestones);
    }

    // validation 不 eligible → validationFailed，不调用 EvidenceUpgrade。
    if (fetchResult.validation.status !== 'PASS') {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'validationFailed', fetchResult.validation.reasonCode, milestones);
    }

    if (signal.aborted) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'aborted', 'ABORTED', milestones);
    }

    const upgradeResult = this.deps.upgrade({
      sourceVersionId,
      content: fetchResult.content,
      validation: fetchResult.validation,
    });

    switch (upgradeResult.status) {
      case 'UPGRADED':
        milestones.upgraded = true;
        return this.analyzeFinalVersion(index, itemUrl, candidateId, sourceVersionId, upgradeResult.versionId, milestones, signal);
      case 'ALREADY_UPGRADED':
        milestones.alreadyUpgraded = true;
        return this.analyzeFinalVersion(index, itemUrl, candidateId, sourceVersionId, upgradeResult.existingVersionId, milestones, signal);
      case 'BLOCKED':
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'upgradeBlocked', upgradeResult.reasonCode, milestones);
      case 'FAILED':
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'upgradeFailed', upgradeResult.reasonCode, milestones);
    }
  }

  // ── 统一分析流：Existing FULL 与 Newly Upgraded FULL 汇合于此 ────────────────

  private async analyzeFinalVersion(
    index: number,
    itemUrl: string,
    candidateId: string | null,
    sourceVersionId: string,
    finalVersionId: string,
    milestones: PipelineItemMilestones,
    signal: AbortSignal,
  ): Promise<PipelineItemOutcome> {
    if (signal.aborted) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'aborted', 'ABORTED', milestones);
    }

    let task: AnalysisTask;
    try {
      const result = this.deps.createTask(finalVersionId);
      task = result.task;
      milestones.analysisTaskCreated = true;
    } catch (error) {
      if (error instanceof AnalysisInputError) {
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisBlocked', error.code, milestones);
      }
      // 非 AnalysisInputError 视为 run-level 异常（DB fatal 等），向上抛出终止 run。
      throw error;
    }

    switch (task.status) {
      case 'queued': {
        if (signal.aborted) {
          return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'aborted', 'ABORTED', milestones);
        }
        const runOutcome = await this.deps.runTask(task.id);
        if (runOutcome.kind === 'succeeded') {
          milestones.analysisCompleted = true;
          milestones.inRecommendationScope = true;
          return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisCompleted', null, milestones);
        }
        const reason = runOutcome.kind === 'failed' ? runOutcome.errorCode : runOutcome.kind;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisFailed', reason, milestones);
      }
      case 'succeeded': {
        // 幂等复用已有成功分析：不调用 runTask。
        milestones.analysisCompleted = true;
        milestones.inRecommendationScope = true;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisCompleted', null, milestones);
      }
      case 'failed': {
        // 不 retry。
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisFailed', task.errorCode ?? 'failed', milestones);
      }
      case 'running': {
        // 不重复执行、不轮询。
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisAlreadyRunning', null, milestones);
      }
      case 'cancelled': {
        // 不 resurrect。
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisCancelled', null, milestones);
      }
    }
  }
}
