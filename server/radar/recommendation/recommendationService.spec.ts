import { describe, expect, it } from 'vitest';
import { MAX_RECOMMENDATIONS, RecommendationSetV1Schema } from './recommendationContract';
import { buildRecommendationSet, type RecommendationCandidateInput } from './recommendationService';

/** 全 current/apply_now/无门禁 的基线输入，按需覆盖字段验证单点行为。 */
function input(overrides: Partial<RecommendationCandidateInput> = {}): RecommendationCandidateInput {
  return {
    candidateId: 'cand-1', candidateVersionId: 'cv-1', analysisRecordId: 'rec-1',
    analysisRecommendation: 'apply_now', confidence: 'high', validity: 'current',
    hardConstraintHit: false, ignoredUnchanged: false, appliedPending: false,
    rationale: '匹配良好', evidenceRefs: [{ evidenceKey: 'candidate:requirement:1', polarity: 'support' }],
    hasCapabilityGap: false, missingBaseline: false, cityOrSalaryUnconfirmed: false, riskCount: 0,
    ...overrides,
  };
}

function n(i: number, over: Partial<RecommendationCandidateInput> = {}): RecommendationCandidateInput {
  return input({ candidateId: `cand-${i}`, candidateVersionId: `cv-${i}`, analysisRecordId: `rec-${i}`, ...over });
}

describe('buildRecommendationSet', () => {
  it('returns 0 recommendations with no_candidates_in_scope for empty input', () => {
    const set = buildRecommendationSet([]);
    expect(set.recommendations).toEqual([]);
    expect(set.emptyReason).toBe('no_candidates_in_scope');
    expect(RecommendationSetV1Schema.safeParse(set).success).toBe(true);
  });

  it('emits one recommendation per eligible candidate without padding', () => {
    const set = buildRecommendationSet([n(1), n(2), n(3)]);
    expect(set.recommendations).toHaveLength(3);
    expect(set.recommendations.map((r) => r.priority)).toEqual([1, 2, 3]);
    expect(set.emptyReason).toBeNull();
  });

  it('caps at 8 and blocks the overflow as capacity_exceeded (no padding beyond real analyses)', () => {
    const inputs = Array.from({ length: 11 }, (_v, i) => n(i + 1));
    const set = buildRecommendationSet(inputs);
    expect(set.recommendations).toHaveLength(MAX_RECOMMENDATIONS);
    expect(set.blocked.filter((b) => b.reason === 'capacity_exceeded')).toHaveLength(3);
  });

  it('excludes stale analyses from formal recommendations', () => {
    const set = buildRecommendationSet([n(1, { validity: 'stale' }), n(2)]);
    expect(set.recommendations.map((r) => r.candidateId)).toEqual(['cand-2']);
    expect(set.blocked).toContainEqual(
      expect.objectContaining({ candidateId: 'cand-1', reason: 'stale_analysis' }),
    );
  });

  it('suppresses ignored_unchanged and applied_pending candidates', () => {
    const set = buildRecommendationSet([
      n(1, { ignoredUnchanged: true }),
      n(2, { appliedPending: true }),
      n(3),
    ]);
    expect(set.recommendations.map((r) => r.candidateId)).toEqual(['cand-3']);
    expect(set.blocked.map((b) => b.reason).sort()).toEqual(['applied_pending', 'ignored_unchanged']);
  });

  it('blocks skip recommendations and hard-constraint hits', () => {
    const set = buildRecommendationSet([
      n(1, { analysisRecommendation: 'skip' }),
      n(2, { hardConstraintHit: true }),
    ]);
    expect(set.recommendations).toEqual([]);
    expect(set.emptyReason).toBe('all_candidates_excluded');
    expect(set.blocked.map((b) => b.reason).sort()).toEqual(['hard_constraint_hit', 'skip_recommended']);
  });

  it('reports no_current_successful_analysis when nothing analyzable exists', () => {
    const set = buildRecommendationSet([
      n(1, { analysisRecordId: null, analysisRecommendation: null, validity: 'none' }),
    ]);
    expect(set.emptyReason).toBe('no_current_successful_analysis');
    expect(set.blocked[0]?.reason).toBe('no_current_analysis');
  });

  it('orders by kind, then confidence, deterministically', () => {
    const set = buildRecommendationSet([
      n(1, { analysisRecommendation: 'verify', confidence: 'high' }),
      n(2, { analysisRecommendation: 'apply_now', confidence: 'low' }),
      n(3, { analysisRecommendation: 'apply_now', confidence: 'high' }),
      n(4, { analysisRecommendation: 'stretch', confidence: 'high' }),
    ]);
    expect(set.recommendations.map((r) => r.candidateId)).toEqual(['cand-3', 'cand-2', 'cand-4', 'cand-1']);
  });

  it('is deterministic regardless of input order', () => {
    const a = [n(1, { confidence: 'low' }), n(2, { confidence: 'high' }), n(3, { confidence: 'medium' })];
    const forward = buildRecommendationSet(a);
    const reversed = buildRecommendationSet([...a].reverse());
    expect(forward).toEqual(reversed);
  });

  it('dedupes by candidateId keeping the highest-priority version', () => {
    const set = buildRecommendationSet([
      input({ candidateId: 'c', candidateVersionId: 'cv-old', analysisRecordId: 'r1', confidence: 'low' }),
      input({ candidateId: 'c', candidateVersionId: 'cv-new', analysisRecordId: 'r2', confidence: 'high' }),
    ]);
    expect(set.recommendations).toHaveLength(1);
    expect(set.recommendations[0]?.candidateVersionId).toBe('cv-new');
    expect(set.blocked).toContainEqual(
      expect.objectContaining({ candidateVersionId: 'cv-old', reason: 'duplicate_candidate' }),
    );
  });

  it('derives applicable conditions from analysis facts', () => {
    const set = buildRecommendationSet([
      n(1, { analysisRecommendation: 'verify', hasCapabilityGap: true, missingBaseline: true, cityOrSalaryUnconfirmed: true }),
    ]);
    expect(set.recommendations[0]?.conditions).toEqual([
      'verify_before_apply', 'capability_gap_present', 'confidence_capped_missing_baseline', 'city_or_salary_unconfirmed',
    ]);
  });
});
