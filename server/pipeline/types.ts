/**
 * OfferFlow v0.9 — DailyPipeline 编排契约类型（纯类型，无实现）。
 *
 * 设计依据：Phase 5B Implementation Scope Lock FINAL v2。
 *
 * DailyPipeline 只做编排，不实现下层 domain logic：
 *   - 不写 SQL、不做 identity resolution、不做 material-change、不做 URL dedupe；
 *   - 不做 Source Policy allowlist、不做 evidence-upgrade persistence；
 *   - 不做 analysis task dedupe、不做 recommendation batch dedupe。
 *
 * 下层组件通过窄接口注入（便于单测替换为 fake/spy）。
 */

import type {
  SearchProviderConfig,
  SearchProviderRequest,
  SearchProviderResult,
} from '../search-provider/types';
import type { DiscoveryIngestionResult } from '../radar/searchEvidence/DiscoveryIngestionBridge';
import type { ContentFetchRequest, FetchResult } from '../content-acquisition/types';
import type { EvidenceUpgradeInput, EvidenceUpgradeResult } from '../radar/evidenceUpgrade/types';
import type { RadarCandidateVersion } from '../../src/domain/radar';
import type { CreateAnalysisTaskResult } from '../radar/analysis/analysisService';
import type { RunOutcome } from '../radar/analysis/executor';
import type { CreateBatchResult } from '../radar/recommendation/recommendationBatchService';

// ── 依赖注入（窄接口，编排层只看到它需要的方法）──────────────────────────────

export interface DailyPipelineDeps {
  /** SearchProviderAdapter.search —— 输入已展开 SearchQuery[]，正确传播 AbortSignal。 */
  search(request: SearchProviderRequest): Promise<SearchProviderResult>;
  /** DiscoveryIngestionBridge.ingestDiscoveryResults —— result.items[i] ↔ 返回 items[i] 一一对应。 */
  ingestDiscovery(result: SearchProviderResult): Promise<DiscoveryIngestionResult>;
  /** ContentFetcher.fetch —— 仅 SEARCH_EVIDENCE + fetchEligible 时调用。 */
  fetch(request: ContentFetchRequest): Promise<FetchResult>;
  /** EvidenceUpgradeService.upgrade —— validation PASS 后才调用。 */
  upgrade(input: EvidenceUpgradeInput): EvidenceUpgradeResult;
  /** RadarCandidateRepository.getVersion —— 精确读取返回版本的真实 evidenceLevel。 */
  getVersion(versionId: string): RadarCandidateVersion | null;
  /** AnalysisService.createTask —— 幂等，可能抛出 AnalysisInputError。 */
  createTask(candidateVersionId: string): CreateAnalysisTaskResult;
  /** AnalysisService.runTask —— 仅 queued 任务调用。 */
  runTask(taskId: string): Promise<RunOutcome>;
  /** RecommendationBatchService.createBatch —— 每次 run 至多调用一次。 */
  createBatch(scope: readonly string[]): CreateBatchResult;
}

export interface DailyPipelineRunOptions {
  config?: SearchProviderConfig;
  signal?: AbortSignal;
}

// ── PipelineItemOutcome ───────────────────────────────────────────────────────

/**
 * 终态结果 + milestones + reasonCode，不用单一 enum 表达整个生命周期。
 */
export type PipelineItemFinalOutcome =
  | 'analysisCompleted'
  | 'analysisFailed'
  | 'analysisBlocked'
  | 'analysisAlreadyRunning'
  | 'analysisCancelled'
  | 'manualReview'
  | 'discoveryOnly'
  | 'fetchFailed'
  | 'validationFailed'
  | 'upgradeBlocked'
  | 'upgradeFailed'
  | 'ingestFailed'
  | 'aborted';

export interface PipelineItemMilestones {
  ingested: boolean;
  fetchAttempted: boolean;
  upgraded: boolean;
  alreadyUpgraded: boolean;
  analysisTaskCreated: boolean;
  analysisCompleted: boolean;
  inRecommendationScope: boolean;
}

export interface PipelineItemOutcome {
  index: number;
  itemUrl: string;
  candidateId: string | null;
  /** 摄入返回的版本 ID（证据状态未解析前的 source version）。 */
  sourceVersionId: string | null;
  /** 进入统一分析流的最终版本 ID（FULL_EVIDENCE 或升级后的 FULL_EVIDENCE）。 */
  finalVersionId: string | null;
  finalOutcome: PipelineItemFinalOutcome;
  reasonCode: string | null;
  milestones: PipelineItemMilestones;
  /** 从 milestones 汇总的简短可读摘要。 */
  summary: string;
}

// ── 运行结果 ───────────────────────────────────────────────────────────────────

export interface DailyPipelineSummary {
  total: number;
  analysisCompleted: number;
  analysisFailed: number;
  analysisBlocked: number;
  analysisAlreadyRunning: number;
  analysisCancelled: number;
  manualReview: number;
  discoveryOnly: number;
  fetchFailed: number;
  validationFailed: number;
  upgradeBlocked: number;
  upgradeFailed: number;
  ingestFailed: number;
  aborted: number;
  recommendationBatchId: string | null;
  recommendationBatchCreated: boolean;
}

export interface DailyPipelineResult {
  items: PipelineItemOutcome[];
  /** analysisCompleted=true 的 finalVersionId[]（去重前按处理顺序）。 */
  recommendationScope: string[];
  recommendationBatchId: string | null;
  summary: DailyPipelineSummary;
}
