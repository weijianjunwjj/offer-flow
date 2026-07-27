import { describe, expect, it } from 'vitest';
import {
  MAX_RECOMMENDATIONS,
  RecommendationSetV1Schema,
  parseRecommendationSet,
  type RecommendationItem,
  type RecommendationSetV1,
} from './recommendationContract';

function item(priority: number, over: Partial<RecommendationItem> = {}): RecommendationItem {
  return {
    candidateId: `cand-${priority}`, candidateVersionId: `cv-${priority}`, analysisRecordId: `rec-${priority}`,
    kind: 'apply_now', priority, confidence: 'high', rationale: '匹配良好',
    evidenceRefs: [{ evidenceKey: 'candidate:requirement:1', polarity: 'support' }], conditions: [],
    ...over,
  };
}

function set(over: Partial<RecommendationSetV1> = {}): RecommendationSetV1 {
  return { contractVersion: 1, recommendations: [item(1)], blocked: [], emptyReason: null, ...over };
}

describe('RecommendationSetV1 contract', () => {
  it('accepts a well-formed set with contiguous priorities', () => {
    expect(() => parseRecommendationSet(set({ recommendations: [item(1), item(2)] }))).not.toThrow();
  });

  it('rejects more than 8 recommendations', () => {
    const recs = Array.from({ length: MAX_RECOMMENDATIONS + 1 }, (_v, i) => item(i + 1));
    expect(RecommendationSetV1Schema.safeParse(set({ recommendations: recs })).success).toBe(false);
  });

  it('rejects non-contiguous priorities (gap or duplicate)', () => {
    expect(RecommendationSetV1Schema.safeParse(set({ recommendations: [item(1), item(3)] })).success).toBe(false);
    expect(RecommendationSetV1Schema.safeParse(set({ recommendations: [item(1), item(1, { candidateId: 'x' })] })).success).toBe(false);
  });

  it('requires emptyReason exactly when there are 0 recommendations', () => {
    expect(RecommendationSetV1Schema.safeParse(set({ recommendations: [], emptyReason: null })).success).toBe(false);
    expect(RecommendationSetV1Schema.safeParse(set({ recommendations: [], emptyReason: 'no_candidates_in_scope' })).success).toBe(true);
  });

  it('forbids emptyReason when recommendations exist', () => {
    expect(RecommendationSetV1Schema.safeParse(set({ emptyReason: 'all_candidates_excluded' })).success).toBe(false);
  });

  it('rejects unknown fields (strict) and empty rationale', () => {
    expect(RecommendationSetV1Schema.safeParse({ ...set(), extra: 1 }).success).toBe(false);
    expect(RecommendationSetV1Schema.safeParse(set({ recommendations: [item(1, { rationale: '' })] })).success).toBe(false);
  });
});
