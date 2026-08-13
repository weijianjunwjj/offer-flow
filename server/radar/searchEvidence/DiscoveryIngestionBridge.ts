/**
 * v0.9 Phase 4B — Discovery Ingestion Bridge.
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/tasks.md T033 / T034 / T034-bridge
 *   specs/001-daily-job-hunter/plan.md v3.0 §2.9
 *
 * 职责：将 SearchProviderResult 通过 SourcePolicyDecision 接入 SearchEvidenceIngestionService。
 *
 * 核心约束：
 *   - Bridge 不直接写 SQL、不直接访问 DB——持久化通过 SearchEvidenceIngestionService.ingest() 完成。
 *   - 写入 ingestion 的 evidenceLevel **只能**来自 getSourcePolicyDecision(domain).initialEvidenceLevel。
 *   - Provider item 自带的 evidenceLevel 字段被完全忽略。
 *   - 没有任何 item 以 FULL_EVIDENCE 调用 ingest()（SourcePolicy 不产生 FULL_EVIDENCE）。
 *   - 单个 item ingest 失败不阻断整批——记录 skipped=true + errorReason。
 *   - fetchEligible 只作为 transient outcome 记录，不持久化。
 *
 * Out-of-scope（本轮不实现）：
 *   - ContentFetcher / HTTP fetch
 *   - DailyPipeline 编排
 *   - AnalysisService / RecommendationBatch
 *   - fetch queue 持久化
 */

import type { SearchProviderResult, SearchEvidenceItem as ProviderSearchEvidenceItem } from '../../search-provider/types';
import type { SearchEvidenceItem } from './searchEvidenceTypes';
import { extractDomain } from './searchEvidenceTypes';
import { getSourcePolicyDecision, normalizeDomain, type SourcePolicyDecision } from '../sourcePolicy/sourcePolicy';
import type { SearchEvidenceIngestionService, SearchEvidenceIngestionOutcome } from './SearchEvidenceIngestionService';
import type { RadarEvidenceLevel } from '../../../src/domain/radar';

// ── Bridge outcome types ──────────────────────────────────────────────────────

export interface DiscoveryIngestionItemOutcome {
  /** 原始 item URL（用于追踪）。 */
  itemUrl: string;
  /** 原始 item domain（Provider 提供，可能为空）。 */
  providerDomain: string;
  /** 规范化后的 domain（用于 SourcePolicy 判定）。 */
  normalizedDomain: string;
  /** Source Policy 判定结果。 */
  sourcePolicyDecision: SourcePolicyDecision;
  /** 实际写入 ingestion 的 evidenceLevel（来自 SourcePolicyDecision.initialEvidenceLevel）。 */
  appliedEvidenceLevel: RadarEvidenceLevel;
  /** 本轮是否标记为 fetch eligible（transient，不持久化）。 */
  fetchEligible: boolean;
  /** Fetch 成功后可达到的 evidenceLevel（transient，不持久化）。 */
  targetEvidenceLevelAfterFetch: RadarEvidenceLevel | null;

  // ── Ingestion 结果（skipped=false 时有值）──────────────────────────────────
  snapshotId: string | null;
  candidateId: string | null;
  candidateVersionId: string | null;
  sourceRecordId: string | null;
  decisionType: string | null;
  analysisEligible: boolean;

  // ── Skip 追踪 ──────────────────────────────────────────────────────────────
  /** 该 item 是否被跳过（ingestion 抛出异常）。 */
  skipped: boolean;
  /** 跳过原因（仅 skipped=true 时有值）。 */
  errorReason: string | null;
}

export interface DiscoveryIngestionSummary {
  /** Provider 返回的总 item 数。 */
  total: number;
  /** 成功 ingest 的 item 数。 */
  ingested: number;
  /** 因异常跳过的 item 数。 */
  skipped: number;
  /** 按 evidenceLevel 分组计数。 */
  byEvidenceLevel: Record<string, number>;
  /** 按 SourcePolicy 分组计数。 */
  bySourcePolicy: Record<string, number>;
  /** fetchEligible=true 的 item 数（供 Phase 4C ContentFetcher 参考）。 */
  fetchEligibleCount: number;
}

export interface DiscoveryIngestionResult {
  /** 每个 item 的详细 outcome。 */
  items: DiscoveryIngestionItemOutcome[];
  /** 摘要统计。 */
  summary: DiscoveryIngestionSummary;
}

// ── Domain resolution ─────────────────────────────────────────────────────────

/**
 * 解析 item 的规范化 domain。
 *
 * 规则：
 *   1. item.domain 存在且非空 → normalizeDomain(item.domain)
 *   2. item.domain 缺失/为空但 url 有效 → 从 url 提取 domain
 *   3. domain 和 url 都无法解析 → 返回空字符串（走 UNKNOWN 保守路径）
 */
function resolveDomain(item: ProviderSearchEvidenceItem): string {
  if (item.domain && item.domain.trim() !== '') {
    return normalizeDomain(item.domain);
  }
  if (item.url && item.url.trim() !== '') {
    const extracted = extractDomain(item.url);
    if (extracted && extracted !== 'unknown') {
      return normalizeDomain(extracted);
    }
  }
  return '';
}

// ── Provider item → Domain item mapping ───────────────────────────────────────

/**
 * 将 Provider SearchEvidenceItem 映射为领域 SearchEvidenceItem。
 *
 * **明确排除 provider item 的 evidenceLevel 字段**——
 * 写入 ingestion 的 evidenceLevel 只能来自 SourcePolicyDecision。
 */
function toDomainItem(providerItem: ProviderSearchEvidenceItem): SearchEvidenceItem {
  return {
    provider: providerItem.provider,
    query: providerItem.query,
    providerRequestId: providerItem.providerRequestId,
    title: providerItem.title,
    url: providerItem.url,
    content: providerItem.content,
    domain: providerItem.domain,
    providerScore: providerItem.providerScore,
    publishedAt: providerItem.publishedAt,
    searchedAt: providerItem.searchedAt,
    providerMetadata: providerItem.providerMetadata,
  };
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(items: DiscoveryIngestionItemOutcome[]): DiscoveryIngestionSummary {
  const byEvidenceLevel: Record<string, number> = {};
  const bySourcePolicy: Record<string, number> = {};
  let ingested = 0;
  let skipped = 0;
  let fetchEligibleCount = 0;

  for (const item of items) {
    if (item.skipped) {
      skipped++;
      continue;
    }

    ingested++;

    const level = item.appliedEvidenceLevel;
    byEvidenceLevel[level] = (byEvidenceLevel[level] ?? 0) + 1;

    const policy = item.sourcePolicyDecision.policy;
    bySourcePolicy[policy] = (bySourcePolicy[policy] ?? 0) + 1;

    if (item.fetchEligible) {
      fetchEligibleCount++;
    }
  }

  return {
    total: items.length,
    ingested,
    skipped,
    byEvidenceLevel,
    bySourcePolicy,
    fetchEligibleCount,
  };
}

// ── Main bridge function ──────────────────────────────────────────────────────

/**
 * 将单次 SearchProviderResult 通过 SourcePolicy 判定后批量摄入 Radar。
 *
 * 流程（每个 item 独立）：
 *   providerItem → resolveDomain → getSourcePolicyDecision →
 *   toDomainItem → ingestionService.ingest(domainItem, decision.initialEvidenceLevel)
 *
 * 关键不变量：
 *   - Provider item 的 evidenceLevel 被**完全忽略**。
 *   - 没有任何 item 以 FULL_EVIDENCE 调用 ingest()。
 *   - 单个 item 失败 → skipped=true + errorReason，不阻断其他 item。
 *   - fetchEligible 仅记录在 outcome 中，不持久化。
 *
 * @param result — SearchProviderAdapter.search() 的返回结果
 * @param ingestionService — SearchEvidenceIngestionService 实例
 * @returns 每个 item 的详细 outcome + 摘要统计
 */
export async function ingestDiscoveryResults(
  result: SearchProviderResult,
  ingestionService: SearchEvidenceIngestionService,
): Promise<DiscoveryIngestionResult> {
  const outcomes: DiscoveryIngestionItemOutcome[] = [];

  for (const providerItem of result.items) {
    const itemUrl = providerItem.url;
    let outcome: DiscoveryIngestionItemOutcome;

    try {
      // Step 1: Resolve domain
      const normalizedDomain = resolveDomain(providerItem);

      // Step 2: Source Policy decision（evidenceLevel 只从这里来）
      const decision = getSourcePolicyDecision(normalizedDomain);

      // Step 3: Map to domain item（明确排除 provider evidenceLevel）
      const domainItem = toDomainItem(providerItem);

      // Step 4: Ingest with SourcePolicy-derived evidenceLevel
      const ingestionOutcome: SearchEvidenceIngestionOutcome = ingestionService.ingest(
        domainItem,
        decision.initialEvidenceLevel,
      );

      outcome = {
        itemUrl,
        providerDomain: providerItem.domain,
        normalizedDomain,
        sourcePolicyDecision: decision,
        appliedEvidenceLevel: decision.initialEvidenceLevel,
        fetchEligible: decision.fetchEligible,
        targetEvidenceLevelAfterFetch: decision.targetEvidenceLevelAfterFetch,
        snapshotId: ingestionOutcome.snapshotId,
        candidateId: ingestionOutcome.candidateId,
        candidateVersionId: ingestionOutcome.candidateVersionId,
        sourceRecordId: ingestionOutcome.sourceRecordId,
        decisionType: ingestionOutcome.decisionType,
        analysisEligible: ingestionOutcome.analysisEligible,
        skipped: false,
        errorReason: null,
      };
    } catch (err) {
      // 单个 item 失败不阻断整批
      const message = err instanceof Error ? err.message : String(err);
      const normalizedDomain = (() => {
        try { return resolveDomain(providerItem); } catch { return ''; }
      })();
      const decision = (() => {
        try { return getSourcePolicyDecision(normalizedDomain); } catch {
          return getSourcePolicyDecision('');
        }
      })();

      outcome = {
        itemUrl,
        providerDomain: providerItem.domain,
        normalizedDomain,
        sourcePolicyDecision: decision,
        appliedEvidenceLevel: decision.initialEvidenceLevel,
        fetchEligible: false,
        targetEvidenceLevelAfterFetch: null,
        snapshotId: null,
        candidateId: null,
        candidateVersionId: null,
        sourceRecordId: null,
        decisionType: null,
        analysisEligible: false,
        skipped: true,
        errorReason: message,
      };
    }

    outcomes.push(outcome);
  }

  return {
    items: outcomes,
    summary: buildSummary(outcomes),
  };
}
