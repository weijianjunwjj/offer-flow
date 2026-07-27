import { describe, expect, it } from 'vitest';
import type { JobMatchAnalysisRecord, RadarRuleAssessment } from '../../../src/domain/radar';
import { validPayload } from '../analysis/contractFixtures';
import {
  collectEvidenceRefs,
  hasHardConstraintHit,
  projectRecommendationInput,
} from './recommendationProjection';
import { buildRecommendationSet } from './recommendationService';

function record(over: Partial<JobMatchAnalysisRecord> = {}): JobMatchAnalysisRecord {
  return {
    id: 'rec-1', candidateId: 'cand-1', candidateVersionId: 'cv-1', resumeVersionId: 'rv-1',
    jobMatchProfileVersionId: 'jmp-1', cityCode: 'suzhou', capabilityBaselineVersionId: 'cap-1',
    marketPositionVersionId: null, strategyVersionId: null, ruleVersion: 'rules-v1',
    promptVersion: 'prompt-v1', analysisPolicyVersion: 'policy-v1', modelProvider: 'deepseek',
    modelName: 'deepseek-chat', modelVersion: null, inputHash: 'h1',
    recommendation: 'apply_now', confidence: 'high', payload: {}, createdAt: 100, supersedesAnalysisId: null,
    ...over,
  };
}

function rule(over: Partial<RadarRuleAssessment>): RadarRuleAssessment {
  return {
    id: 'ra-1', candidateId: 'cand-1', candidateVersionId: 'cv-1', ruleVersion: 'rules-v1',
    ruleKey: 'k', category: 'risk', severity: 'medium', result: 'pass', matchedText: null,
    sourcePath: null, explanation: '', evidenceJson: null, createdAt: 100, ...over,
  };
}

describe('collectEvidenceRefs', () => {
  it('collects deduped support (positive) and counter keys, support first', () => {
    const refs = collectEvidenceRefs(validPayload());
    expect(refs.some((r) => r.polarity === 'support')).toBe(true);
    expect(refs.some((r) => r.polarity === 'counter')).toBe(true);
    const keys = refs.map((r) => r.evidenceKey);
    expect(new Set(keys.filter((k, i) => keys.indexOf(k) !== i && refs[i]!.polarity === refs[keys.indexOf(k)]!.polarity)).size).toBe(0);
  });
});

describe('hasHardConstraintHit', () => {
  it('is true only when a hard_constraint rule result is hit', () => {
    expect(hasHardConstraintHit([rule({ category: 'hard_constraint', result: 'hit' })])).toBe(true);
    expect(hasHardConstraintHit([rule({ category: 'hard_constraint', result: 'pass' })])).toBe(false);
    expect(hasHardConstraintHit([rule({ category: 'risk', result: 'hit' })])).toBe(false);
  });
});

describe('projectRecommendationInput → buildRecommendationSet', () => {
  it('projects a real current record into an eligible recommendation', () => {
    const input = projectRecommendationInput(record(), validPayload(), [], { ignoredUnchanged: false, appliedPending: false });
    expect(input.validity).toBe('current');
    expect(input.rationale).toBe('整体匹配良好。');
    const set = buildRecommendationSet([input]);
    expect(set.recommendations).toHaveLength(1);
    expect(set.recommendations[0]?.kind).toBe('apply_now');
    expect(set.recommendations[0]?.evidenceRefs.length).toBeGreaterThan(0);
  });

  it('marks missing baseline and city/salary uncertainty as conditions', () => {
    const payload = validPayload({
      dimensions: { ...validPayload().dimensions, cityAndSalaryFit: { summary: '城市证据不足', assessment: 'unknown', points: [] } },
    });
    const input = projectRecommendationInput(record({ capabilityBaselineVersionId: null }), payload, [], { ignoredUnchanged: false, appliedPending: false });
    expect(input.missingBaseline).toBe(true);
    expect(input.cityOrSalaryUnconfirmed).toBe(true);
    const set = buildRecommendationSet([input]);
    expect(set.recommendations[0]?.conditions).toEqual(
      expect.arrayContaining(['confidence_capped_missing_baseline', 'city_or_salary_unconfirmed']),
    );
  });
});
