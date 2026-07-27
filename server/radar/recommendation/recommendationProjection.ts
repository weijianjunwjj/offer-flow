/**
 * V8-5 第一波 · 推荐输入投影（现有 AnalysisRecord + 分析 Payload + 规则评估 + 处理状态 → 输入投影）。
 *
 * 纯函数、无 IO：把"已经存在"的 current 分析事实与规则证据确定性地投影为 RecommendationCandidateInput，
 * 交给 buildRecommendationSet 收敛。证据引用直接复用 Payload 内的 evidenceKey（稳定语义键，非内部 ID）。
 */
import type { JobMatchAnalysisRecord, RadarRuleAssessment } from '../../../src/domain/radar';
import type { JobMatchAnalysisPayloadV1 } from '../analysis/analysisPayload';
import type { RecommendationEvidenceRef } from './recommendationContract';
import type { RecommendationCandidateInput } from './recommendationService';

const EVIDENCE_REFS_MAX = 12;

/** 候选当前处理状态（由 RadarAction 流水在服务层派生后注入；本层只消费布尔事实）。 */
export interface CandidateHandledState {
  ignoredUnchanged: boolean;
  appliedPending: boolean;
}

/** 从 Payload 收集去重后的证据引用（支持在前、反证在后，稳定排序，限量）。 */
export function collectEvidenceRefs(payload: JobMatchAnalysisPayloadV1): RecommendationEvidenceRef[] {
  const support = new Set<string>();
  const counter = new Set<string>();
  const pushPositive = (points: { evidenceKeys: string[]; impact: string }[]) => {
    for (const p of points) if (p.impact === 'positive') for (const k of p.evidenceKeys) support.add(k);
  };
  pushPositive(payload.transferableEvidence);
  for (const dim of Object.values(payload.dimensions)) pushPositive(dim.points);
  for (const point of payload.counterEvidence) for (const k of point.evidenceKeys) counter.add(k);

  const refs: RecommendationEvidenceRef[] = [
    ...[...support].sort().map((evidenceKey): RecommendationEvidenceRef => ({ evidenceKey, polarity: 'support' })),
    ...[...counter].sort().map((evidenceKey): RecommendationEvidenceRef => ({ evidenceKey, polarity: 'counter' })),
  ];
  return refs.slice(0, EVIDENCE_REFS_MAX);
}

/** 硬约束命中：category=hard_constraint 且 result=hit（override 由服务层在投影前解决，此处只读结果）。 */
export function hasHardConstraintHit(assessments: readonly RadarRuleAssessment[]): boolean {
  return assessments.some((a) => a.category === 'hard_constraint' && a.result === 'hit');
}

/**
 * 从现有 current 分析记录 + 已解析 Payload + 规则评估 + 处理状态，确定性地构建 RecommendationCandidateInput。
 * 调用方应只在 validity=current 时传入 record/payload（stale 直接构建 validity='stale' 的 no-payload 投影）。
 */
export function projectRecommendationInput(
  record: JobMatchAnalysisRecord,
  payload: JobMatchAnalysisPayloadV1,
  assessments: readonly RadarRuleAssessment[],
  handledState: CandidateHandledState,
): RecommendationCandidateInput {
  const hasCapabilityGap = payload.gaps.length > 0;
  // 能力基线缺失时置信度被压制（对齐 contracts.ts readiness.confidenceCeiling）
  const missingBaseline = record.capabilityBaselineVersionId === null;
  // 城市/薪资不确定：payload dimensions cityAndSalaryFit assessment 为 unknown/weak
  const cityFit = payload.dimensions.cityAndSalaryFit.assessment;
  const cityOrSalaryUnconfirmed = cityFit === 'unknown' || cityFit === 'weak';
  const riskCount = payload.risks.filter((r) => r.impact === 'negative').length;

  return {
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    analysisRecordId: record.id,
    analysisRecommendation: record.recommendation,
    confidence: record.confidence,
    validity: 'current',
    hardConstraintHit: hasHardConstraintHit(assessments),
    ignoredUnchanged: handledState.ignoredUnchanged,
    appliedPending: handledState.appliedPending,
    rationale: payload.summary,
    evidenceRefs: collectEvidenceRefs(payload),
    hasCapabilityGap,
    missingBaseline,
    cityOrSalaryUnconfirmed,
    riskCount,
  };
}

/** 无 current 分析的候选投影（analysis 缺失/stale）。 */
export function projectMissingInput(
  candidateId: string,
  candidateVersionId: string,
  analysisRecordId: string | null,
  validity: 'stale' | 'none',
  handledState: CandidateHandledState,
): RecommendationCandidateInput {
  return {
    candidateId, candidateVersionId, analysisRecordId,
    analysisRecommendation: null, confidence: null, validity,
    hardConstraintHit: false, ignoredUnchanged: handledState.ignoredUnchanged,
    appliedPending: handledState.appliedPending,
    rationale: '', evidenceRefs: [],
    hasCapabilityGap: false, missingBaseline: false,
    cityOrSalaryUnconfirmed: false, riskCount: 0,
  };
}
