/**
 * V8-5 第一波 · 0～8 条建议确定性生成服务（纯函数，无 IO、无 Provider、无副作用）。
 *
 * 输入是**已从现有 AnalysisRecord + rule evidence + RadarAction 派生状态投影**的候选清单
 * （投影由 projectRecommendationInput 负责，可单测），buildRecommendationSet 只做确定性收敛：
 * 门禁排除 → 稳定排序 → 按 candidateId 去重 → 上限 8 → 赋优先级。绝不为凑数放宽标准。
 *
 * 边界：不读数据库、不落库、不调模型、不改任何正式对象；相同输入必得相同输出（可断言）。
 */
import {
  MAX_RECOMMENDATIONS,
  RECOMMENDATION_CONTRACT_VERSION,
  parseRecommendationSet,
  type BlockedCandidate,
  type RecommendationBlockReason,
  type RecommendationCondition,
  type RecommendationConfidence,
  type RecommendationEvidenceRef,
  type RecommendationItem,
  type RecommendationKind,
  type RecommendationSetV1,
} from './recommendationContract';

/** 单个候选的推荐输入投影（从 current 分析事实 + 处理状态派生的有限事实）。 */
export interface RecommendationCandidateInput {
  candidateId: string;
  candidateVersionId: string;
  /** 来源分析记录 ID；无成功分析时为 null（将以 no_current_analysis 排除）。 */
  analysisRecordId: string | null;
  /** 分析给出的四档结论（apply_now/stretch/verify/skip）；无分析为 null。 */
  analysisRecommendation: 'apply_now' | 'stretch' | 'verify' | 'skip' | null;
  confidence: RecommendationConfidence | null;
  /** 有效性：只有 current 能进入正式推荐；stale 一律排除。 */
  validity: 'current' | 'stale' | 'none';
  /** 是否命中未被覆盖的硬约束（hit 且未 override_pass）。 */
  hardConstraintHit: boolean;
  /** 处理状态派生：已忽略且内容未变化 / 已投递待反馈（均抑制）。 */
  ignoredUnchanged: boolean;
  appliedPending: boolean;
  /** 分析摘要（作为建议 rationale；空则回退占位，schema 要求非空）。 */
  rationale: string;
  /** 证据引用（支持/反证），已在投影层去重限量。 */
  evidenceRefs: RecommendationEvidenceRef[];
  /** 派生适用条件的确定性事实。 */
  hasCapabilityGap: boolean;
  missingBaseline: boolean;
  cityOrSalaryUnconfirmed: boolean;
  /** 排序次级键：风险条目数（少者优先）。 */
  riskCount: number;
}

const KIND_RANK: Record<RecommendationKind, number> = { apply_now: 0, stretch: 1, verify: 2 };
const CONFIDENCE_RANK: Record<RecommendationConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * 门禁：返回该候选的阻断原因，null 表示可进入建议候选池。
 * 优先级固定（先分析可用性，再门禁抑制），保证同输入得同一原因。
 */
function blockReasonFor(input: RecommendationCandidateInput): RecommendationBlockReason | null {
  if (input.validity === 'stale') return 'stale_analysis';
  if (input.analysisRecordId === null || input.analysisRecommendation === null || input.validity === 'none') {
    return 'no_current_analysis';
  }
  if (input.analysisRecommendation === 'skip') return 'skip_recommended';
  if (input.hardConstraintHit) return 'hard_constraint_hit';
  if (input.ignoredUnchanged) return 'ignored_unchanged';
  if (input.appliedPending) return 'applied_pending';
  return null;
}

/** 适用条件：由确定性事实派生（顺序固定，便于断言）。 */
function conditionsFor(input: RecommendationCandidateInput, kind: RecommendationKind): RecommendationCondition[] {
  const conditions: RecommendationCondition[] = [];
  if (kind === 'verify') conditions.push('verify_before_apply');
  if (kind === 'stretch') conditions.push('stretch_reach');
  if (input.hasCapabilityGap) conditions.push('capability_gap_present');
  if (input.missingBaseline) conditions.push('confidence_capped_missing_baseline');
  if (input.cityOrSalaryUnconfirmed) conditions.push('city_or_salary_unconfirmed');
  return conditions;
}

/** 稳定确定性排序：kind → confidence → 风险少 → 证据多 → candidateVersionId 字典序。 */
function compareEligible(a: RecommendationCandidateInput, b: RecommendationCandidateInput): number {
  const kindA = KIND_RANK[a.analysisRecommendation as RecommendationKind];
  const kindB = KIND_RANK[b.analysisRecommendation as RecommendationKind];
  if (kindA !== kindB) return kindA - kindB;
  const confA = CONFIDENCE_RANK[a.confidence ?? 'low'];
  const confB = CONFIDENCE_RANK[b.confidence ?? 'low'];
  if (confA !== confB) return confA - confB;
  if (a.riskCount !== b.riskCount) return a.riskCount - b.riskCount;
  if (a.evidenceRefs.length !== b.evidenceRefs.length) return b.evidenceRefs.length - a.evidenceRefs.length;
  return a.candidateVersionId < b.candidateVersionId ? -1 : a.candidateVersionId > b.candidateVersionId ? 1 : 0;
}

function toItem(input: RecommendationCandidateInput, priority: number): RecommendationItem {
  const kind = input.analysisRecommendation as RecommendationKind;
  return {
    candidateId: input.candidateId,
    candidateVersionId: input.candidateVersionId,
    analysisRecordId: input.analysisRecordId as string,
    kind,
    priority,
    confidence: input.confidence ?? 'low',
    // schema 要求 rationale 非空：投影摘要为空时给稳定占位（不编造结论内容）。
    rationale: input.rationale.trim().length > 0 ? input.rationale : '（无分析摘要）',
    evidenceRefs: input.evidenceRefs,
    conditions: conditionsFor(input, kind),
  };
}

function emptyReasonFor(inputs: readonly RecommendationCandidateInput[]): RecommendationSetV1['emptyReason'] {
  if (inputs.length === 0) return 'no_candidates_in_scope';
  const anyCurrent = inputs.some((i) => i.validity === 'current' && i.analysisRecommendation !== null);
  return anyCurrent ? 'all_candidates_excluded' : 'no_current_successful_analysis';
}

/**
 * 确定性收敛为 0～8 条建议。流程：门禁排除 → 稳定排序 → 按 candidateId 去重（保留最高优先版本）→
 * 上限 8（溢出记 capacity_exceeded）→ 赋连续优先级。**绝不为凑数放宽门禁或复制建议。**
 * 相同输入必得相同输出；结果通过 RecommendationSetV1 严格校验后返回。
 */
export function buildRecommendationSet(
  inputs: readonly RecommendationCandidateInput[],
): RecommendationSetV1 {
  const blocked: BlockedCandidate[] = [];
  const eligible: RecommendationCandidateInput[] = [];

  for (const input of inputs) {
    const reason = blockReasonFor(input);
    if (reason !== null) {
      blocked.push({
        candidateId: input.candidateId,
        candidateVersionId: input.candidateVersionId,
        analysisRecordId: input.analysisRecordId,
        reason,
      });
    } else {
      eligible.push(input);
    }
  }

  eligible.sort(compareEligible);

  // 按 candidateId 去重：保留排序后首次出现（最高优先）的版本，其余记 duplicate_candidate。
  const seenCandidates = new Set<string>();
  const deduped: RecommendationCandidateInput[] = [];
  for (const input of eligible) {
    if (seenCandidates.has(input.candidateId)) {
      blocked.push({
        candidateId: input.candidateId,
        candidateVersionId: input.candidateVersionId,
        analysisRecordId: input.analysisRecordId,
        reason: 'duplicate_candidate',
      });
      continue;
    }
    seenCandidates.add(input.candidateId);
    deduped.push(input);
  }

  const chosen = deduped.slice(0, MAX_RECOMMENDATIONS);
  for (const overflow of deduped.slice(MAX_RECOMMENDATIONS)) {
    blocked.push({
      candidateId: overflow.candidateId,
      candidateVersionId: overflow.candidateVersionId,
      analysisRecordId: overflow.analysisRecordId,
      reason: 'capacity_exceeded',
    });
  }

  const recommendations = chosen.map((input, index) => toItem(input, index + 1));
  const set: RecommendationSetV1 = {
    contractVersion: RECOMMENDATION_CONTRACT_VERSION,
    recommendations,
    blocked,
    emptyReason: recommendations.length === 0 ? emptyReasonFor(inputs) : null,
  };
  return parseRecommendationSet(set);
}
