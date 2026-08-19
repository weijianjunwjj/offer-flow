/**
 * OfferFlow v0.9 — DailyPipeline 编排（Phase 5B + P0 公开来源自动证据获取）。
 *
 * 编排既有能力，不重实现下层 domain logic：
 *   search → ingest → optional cross-source enrichment → per-item resolve →
 *   optional content acquisition → optional evidence upgrade → analysis → recommendation。
 *
 * P0 扩展（相对 Phase 5B）：
 *   - unknown public domain 走受控 fetch（SourcePolicy 已改为 SEARCH_AND_FETCH）
 *   - per-run fetch budget（默认 50，超预算保留 discovery，不算 failure）
 *   - 招聘平台 cross-source enrichment（有界，默认 20 原始 item/run）
 *   - 阶段级观测计数（stageCounts），供 SourceRun.progressJson 持久化
 *
 * 硬不变量（不得破坏）：
 *   - fetch success != FULL_EVIDENCE
 *   - validation PASS != 自动字段覆写
 *   - FULL_EVIDENCE 只能由 EvidenceUpgradeService 产生
 *   - 招聘平台 URL 永不进入自动 fetch
 */

import type {
  SearchProviderConfig,
  SearchProviderRequest,
  SearchProviderResult,
  SearchEvidenceItem,
  SearchQuery,
} from '../search-provider/types';
import type { DiscoveryIngestionItemOutcome, DiscoveryIngestionResult } from '../radar/searchEvidence/DiscoveryIngestionBridge';
import type { ContentFetchRequest } from '../content-acquisition/types';
import type { AnalysisTask } from '../../src/domain/radar';
import { AnalysisInputError } from '../radar/analysis/inputErrors';
import { AnalysisContractError } from '../radar/analysis/contractErrors';
import type {
  DailyPipelineDeps,
  DailyPipelineResult,
  DailyPipelineRunOptions,
  DailyPipelineSummary,
  PipelineItemFinalOutcome,
  PipelineItemMilestones,
  PipelineItemOutcome,
  PipelineStageCounts,
} from './types';
import {
  buildCrossSourceQueries,
  extractCrossSourceIdentity,
  filterCrossSourceCandidates,
  isRecruitmentSource,
} from './crossSourceEnrichment';

export const DEFAULT_FETCH_BUDGET = 50;
export const DEFAULT_ENRICHMENT_BUDGET = 20;

export function emptyPipelineStageCounts(): PipelineStageCounts {
  return {
    discovered: 0,
    recruitmentBlocked: 0,
    unknownPublic: 0,
    fetchBudget: 0,
    fetchBudgetExhausted: 0,
    fetchAttempted: 0,
    fetchSucceeded: 0,
    fetchFailed: 0,
    validationPassed: 0,
    validationFailed: 0,
    evidenceUpgradeAttempted: 0,
    evidenceUpgraded: 0,
    evidenceUpgradeBlocked: 0,
    evidenceUpgradeFailed: 0,
    evidenceUpgradeBlockedBy: {},
    crossSourceEnrichmentAttempted: 0,
    crossSourceEnrichmentSucceeded: 0,
    analysisRequested: 0,
    analysisSucceeded: 0,
    analysisBlocked: 0,
    analysisFailed: 0,
    analysisAlreadyRunning: 0,
    analysisCancelled: 0,
    analysisAborted: 0,
    analysisBlockedBy: {},
    recommendationEligible: 0,
    selected: 0,
    manualReview: 0,
  };
}

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

/** run 内部共享的 fetch budget 状态（跨主搜索与 enrichment items 统一记账）。 */
interface FetchBudgetState {
  fetchAttempted: number;
}

export class DailyPipeline {
  constructor(private readonly deps: DailyPipelineDeps) {}

  /**
   * 执行一轮 Discovery Pipeline：search → ingest → enrichment → per-item resolve/upgrade/analysis → recommendation。
   * sequential orchestration：正确性优先，不做并发/worker/queue。
   */
  async run(
    queries: SearchQuery[],
    options: DailyPipelineRunOptions = {},
  ): Promise<DailyPipelineResult> {
    const signal = options.signal ?? neverAborted();
    const config = options.config ?? {};
    const fetchBudget = options.fetchBudget ?? DEFAULT_FETCH_BUDGET;
    const enrichmentBudget = options.enrichmentBudget ?? DEFAULT_ENRICHMENT_BUDGET;

    const request: SearchProviderRequest = { queries, config, signal };
    const searchResult = await this.deps.search(request);
    const ingestion = await this.deps.ingestDiscovery(searchResult);

    const stage = emptyPipelineStageCounts();
    stage.discovered = ingestion.items.length;
    stage.fetchBudget = fetchBudget;
    for (const bridge of ingestion.items) {
      if (bridge.skipped) continue;
      if (isRecruitmentSource(bridge.normalizedDomain)) stage.recruitmentBlocked++;
      else if (bridge.sourcePolicyDecision.reason === 'unknown_public_fetch_eligible') stage.unknownPublic++;
    }

    // Phase 3：招聘平台 cross-source enrichment（有界）
    const enrichment = await this.runCrossSourceEnrichment(
      searchResult, ingestion, config, signal, enrichmentBudget, stage,
    );

    const items: PipelineItemOutcome[] = [];
    const recommendationScope: string[] = [];
    const budget: FetchBudgetState = { fetchAttempted: 0 };
    // P0.1：run 内 candidate-level dedupe —— 同一 candidate 在一次 run 中
    // 最多进入一次 ContentFetcher / EvidenceUpgrade / Analysis。
    const processedCandidates = new Set<string>();

    const processBatch = async (
      searchItems: SearchEvidenceItem[],
      bridgeItems: DiscoveryIngestionItemOutcome[],
    ): Promise<void> => {
      for (let i = 0; i < bridgeItems.length; i += 1) {
        // 每个新 item 前检查 abort：已 abort 则不启动下一 item 的任何新阶段。
        if (signal.aborted) break;
        const outcome = await this.processItem(
          i, bridgeItems[i], searchItems[i], signal, stage, budget, fetchBudget, processedCandidates,
        );
        items.push(outcome);

        if (outcome.finalOutcome === 'analysisCompleted' && outcome.finalVersionId !== null) {
          recommendationScope.push(outcome.finalVersionId);
        }
      }
    };

    await processBatch(searchResult.items, ingestion.items);
    await processBatch(enrichment.searchItems, enrichment.bridgeItems);

    // Recommendation：整个 run 至多调用一次，scope 为空则跳过。
    let recommendationBatchId: string | null = null;
    let recommendationBatchCreated = false;
    if (!signal.aborted && recommendationScope.length > 0) {
      const batchResult = this.deps.createBatch(recommendationScope);
      recommendationBatchId = batchResult.batch.id;
      recommendationBatchCreated = batchResult.created;
    }

    stage.recommendationEligible = recommendationScope.length;
    stage.selected = recommendationScope.length;

    return {
      items,
      recommendationScope,
      recommendationBatchId,
      summary: buildSummary(items, recommendationBatchId, recommendationBatchCreated),
      coverage: searchResult.coverage,
      stageCounts: stage,
    };
  }

  // ── Cross-source enrichment（Phase 3）────────────────────────────────────────

  /**
   * 对已知招聘平台 item 做有界 public enrichment：构造查询 → search → 过滤公开替代源 →
   * ingest 为新的 SEARCH_EVIDENCE 候选，之后与主搜索 items 一样走 fetch/upgrade/analysis。
   *
   * 招聘平台 URL 本身永不进入 fetch；enrichment 只产出 public alternative 候选。
   */
  private async runCrossSourceEnrichment(
    searchResult: SearchProviderResult,
    ingestion: DiscoveryIngestionResult,
    config: SearchProviderConfig,
    signal: AbortSignal,
    budget: number,
    stage: PipelineStageCounts,
  ): Promise<{ searchItems: SearchEvidenceItem[]; bridgeItems: DiscoveryIngestionItemOutcome[] }> {
    const enrichedSearchItems: SearchEvidenceItem[] = [];
    const enrichedBridgeItems: DiscoveryIngestionItemOutcome[] = [];
    const seenUrls = new Set<string>(searchResult.items.map((i) => i.url));

    let attempted = 0;
    for (let i = 0; i < ingestion.items.length; i += 1) {
      if (signal.aborted) break;
      if (attempted >= budget) break;

      const bridge = ingestion.items[i];
      if (bridge.skipped || !isRecruitmentSource(bridge.normalizedDomain)) continue;

      const providerItem = searchResult.items[i];
      if (providerItem === undefined) continue;

      // identity-safe：缺结构化 company identity → fail closed，不做 enrichment（保持 manual review）。
      const identity = extractCrossSourceIdentity(providerItem);
      if (identity === null) continue;

      const queries = buildCrossSourceQueries(providerItem);
      if (queries.length === 0) continue;

      attempted += 1;
      stage.crossSourceEnrichmentAttempted += 1;

      const enrichResult = await this.deps.search({ queries, config, signal });
      const candidates = filterCrossSourceCandidates(enrichResult.items, identity, seenUrls);
      if (candidates.length === 0) continue;

      stage.crossSourceEnrichmentSucceeded += 1;
      const enrichIngestion = await this.deps.ingestDiscovery({ ...enrichResult, items: candidates });

      for (let j = 0; j < candidates.length; j += 1) {
        const candidate = candidates[j];
        const bridgeItem = enrichIngestion.items[j];
        if (bridgeItem === undefined) continue;
        seenUrls.add(candidate.url);
        enrichedSearchItems.push(candidate);
        enrichedBridgeItems.push(bridgeItem);
      }
    }

    return { searchItems: enrichedSearchItems, bridgeItems: enrichedBridgeItems };
  }

  // ── Per-item 主流程 ─────────────────────────────────────────────────────────

  private async processItem(
    index: number,
    bridge: DiscoveryIngestionItemOutcome,
    providerItem: SearchEvidenceItem | undefined,
    signal: AbortSignal,
    stage: PipelineStageCounts,
    budget: FetchBudgetState,
    fetchBudget: number,
    processedCandidates: Set<string>,
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

    // P0.1 active-version handoff gate：同一 candidate 在 batch ingest 后可能产生多个版本，
    // 只有引用当前 active version 的 outcome 才允许进入昂贵流程（fetch/upgrade/analysis）。
    // 已被新版本取代的 sourceVersionId 跳过，不 mark processed，让后续真正 active 的 outcome 有机会处理。
    if (candidateId !== null) {
      const candidate = this.deps.getCandidate(candidateId);
      if (candidate === null) {
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'analysisBlocked', 'CANDIDATE_NOT_FOUND', milestones);
      }
      if (candidate.activeVersionId !== sourceVersionId) {
        // sourceVersionId 已非 active（stale handoff）：不消耗 budget、不 mark processed、不进入昂贵流程。
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'discoveryOnly', 'candidate_version_not_active_for_processing', milestones);
      }
    }

    // 精确读取返回版本的真实 evidence state，不猜 active、不 find latest。
    const version = this.deps.getVersion(sourceVersionId);
    if (version === null) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'analysisBlocked', 'CANDIDATE_VERSION_NOT_FOUND', milestones);
    }

    const evidenceLevel = version.evidenceLevel;

    // P0.1：candidate-level dedupe。同一 candidate 在一次 run 中最多进入一次
    // ContentFetcher / EvidenceUpgrade / Analysis；重复命中仅保留 discovery（source provenance）。
    const markCandidateProcessed = (): boolean => {
      if (candidateId === null) return false;
      if (processedCandidates.has(candidateId)) return true;
      processedCandidates.add(candidateId);
      return false;
    };

    // B7：已有 FULL_EVIDENCE fast path —— 跳过 fetch + upgrade，直接分析。
    if (evidenceLevel === 'FULL_EVIDENCE') {
      if (markCandidateProcessed()) {
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'discoveryOnly', 'candidate_already_processed', milestones);
      }
      return this.analyzeFinalVersion(index, itemUrl, candidateId, sourceVersionId, sourceVersionId, milestones, signal, stage);
    }

    // B8：SEARCH_EVIDENCE fetch path。
    if (evidenceLevel === 'SEARCH_EVIDENCE') {
      if (bridge.fetchEligible !== true) {
        // B10：SEARCH_EVIDENCE + fetchEligible=false → 不 fetch、不分析。
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'discoveryOnly', 'fetch_not_eligible', milestones);
      }
      // Phase 2：per-run fetch budget。超预算保留 discovery，不算 failure。
      if (budget.fetchAttempted >= fetchBudget) {
        stage.fetchBudgetExhausted += 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'discoveryOnly', 'fetch_budget_exhausted', milestones);
      }
      if (markCandidateProcessed()) {
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'discoveryOnly', 'candidate_already_processed', milestones);
      }
      return this.fetchAndUpgrade(index, itemUrl, candidateId, sourceVersionId, bridge.normalizedDomain, milestones, signal, stage, budget);
    }

    // B10：MANUAL_REVIEW_REQUIRED → 不 fetch、不分析。
    stage.manualReview += 1;
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
    stage: PipelineStageCounts,
    budget: FetchBudgetState,
  ): Promise<PipelineItemOutcome> {
    if (signal.aborted) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'aborted', 'ABORTED', milestones);
    }
    milestones.fetchAttempted = true;
    budget.fetchAttempted += 1;
    stage.fetchAttempted += 1;

    const request: ContentFetchRequest = {
      url: itemUrl,
      normalizedDomain,
      sourcePolicy: 'SEARCH_AND_FETCH',
    };
    const fetchResult = await this.deps.fetch(request);

    // FetchResult 非 FETCHED → 当前 item terminal，按真实 status 记录。
    if (fetchResult.status !== 'FETCHED') {
      stage.fetchFailed += 1;
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'fetchFailed', fetchResult.status, milestones);
    }
    stage.fetchSucceeded += 1;

    // validation 不 eligible → validationFailed，不调用 EvidenceUpgrade。
    if (fetchResult.validation.status !== 'PASS') {
      stage.validationFailed += 1;
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'validationFailed', fetchResult.validation.reasonCode, milestones);
    }
    stage.validationPassed += 1;

    if (signal.aborted) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'aborted', 'ABORTED', milestones);
    }

    stage.evidenceUpgradeAttempted += 1;
    const upgradeResult = this.deps.upgrade({
      sourceVersionId,
      content: fetchResult.content,
      validation: fetchResult.validation,
    });

    switch (upgradeResult.status) {
      case 'UPGRADED':
        milestones.upgraded = true;
        stage.evidenceUpgraded += 1;
        return this.analyzeFinalVersion(index, itemUrl, candidateId, sourceVersionId, upgradeResult.versionId, milestones, signal, stage);
      case 'ALREADY_UPGRADED':
        milestones.alreadyUpgraded = true;
        stage.evidenceUpgraded += 1;
        return this.analyzeFinalVersion(index, itemUrl, candidateId, sourceVersionId, upgradeResult.existingVersionId, milestones, signal, stage);
      case 'BLOCKED':
        stage.evidenceUpgradeBlocked += 1;
        stage.evidenceUpgradeBlockedBy[upgradeResult.reasonCode] =
          (stage.evidenceUpgradeBlockedBy[upgradeResult.reasonCode] ?? 0) + 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, null, 'upgradeBlocked', upgradeResult.reasonCode, milestones);
      case 'FAILED':
        stage.evidenceUpgradeFailed += 1;
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
    stage: PipelineStageCounts,
  ): Promise<PipelineItemOutcome> {
    if (signal.aborted) {
      return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'aborted', 'ABORTED', milestones);
    }

    // analysisRequested 统计所有尝试分析的候选（不管是否被阻断）
    stage.analysisRequested += 1;

    let task: AnalysisTask;
    try {
      const result = this.deps.createTask(finalVersionId);
      task = result.task;
      milestones.analysisTaskCreated = true;
    } catch (error) {
      if (error instanceof AnalysisInputError) {
        stage.analysisBlocked += 1;
        stage.analysisBlockedBy[error.code] = (stage.analysisBlockedBy[error.code] ?? 0) + 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisBlocked', error.code, milestones);
      }
      if (error instanceof AnalysisContractError) {
        stage.analysisBlocked += 1;
        stage.analysisBlockedBy[error.code] = (stage.analysisBlockedBy[error.code] ?? 0) + 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisBlocked', error.code, milestones);
      }
      // 非 item-level 异常（DB fatal 等），向上抛出终止 run。
      throw error;
    }

    switch (task.status) {
      case 'queued': {
        if (signal.aborted) {
          stage.analysisAborted += 1;
          return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'aborted', 'ABORTED', milestones);
        }
        const runOutcome = await this.deps.runTask(task.id);
        if (runOutcome.kind === 'succeeded') {
          milestones.analysisCompleted = true;
          milestones.inRecommendationScope = true;
          stage.analysisSucceeded += 1;
          return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisCompleted', null, milestones);
        }
        const reason = runOutcome.kind === 'failed' ? runOutcome.errorCode : runOutcome.kind;
        stage.analysisFailed += 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisFailed', reason, milestones);
      }
      case 'succeeded': {
        // 幂等复用已有成功分析：不调用 runTask。
        milestones.analysisCompleted = true;
        milestones.inRecommendationScope = true;
        stage.analysisSucceeded += 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisCompleted', null, milestones);
      }
      case 'failed': {
        // 不 retry。
        stage.analysisFailed += 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisFailed', task.errorCode ?? 'failed', milestones);
      }
      case 'running': {
        // 不重复执行、不轮询。
        stage.analysisAlreadyRunning += 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisAlreadyRunning', null, milestones);
      }
      case 'cancelled': {
        // 不 resurrect。
        stage.analysisCancelled += 1;
        return terminal(index, itemUrl, candidateId, sourceVersionId, finalVersionId, 'analysisCancelled', null, milestones);
      }
    }
  }
}
