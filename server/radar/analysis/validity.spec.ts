import { describe, expect, it } from 'vitest';
import type { JobMatchAnalysisRecord } from '../../../src/domain/radar';
import {
  deriveAnalysisValidity,
  type AnalysisStaleReason,
  type CurrentAnalysisVersions,
} from './validity';

/** 记录冻结版本与当前对照面在"全一致"基线上仅按需覆盖，逐项验证 stale 判定。 */
function record(overrides: Partial<JobMatchAnalysisRecord> = {}): JobMatchAnalysisRecord {
  return {
    id: 'rec-1', candidateId: 'cand-1', candidateVersionId: 'cv-1', resumeVersionId: 'rv-1',
    jobMatchProfileVersionId: 'jmp-1', cityCode: 'suzhou',
    capabilityBaselineVersionId: 'cap-1', marketPositionVersionId: 'mkt-1', strategyVersionId: 'str-1',
    ruleVersion: 'rule:v1', promptVersion: 'prompt:v1', analysisPolicyVersion: 'policy:v1',
    modelProvider: 'deepseek', modelName: 'deepseek-chat', modelVersion: null,
    inputHash: 'hash-1', recommendation: 'verify', confidence: 'low', payload: {},
    createdAt: 100, supersedesAnalysisId: null,
    ...overrides,
  };
}

function current(overrides: Partial<CurrentAnalysisVersions> = {}): CurrentAnalysisVersions {
  return {
    candidateActiveVersionId: 'cv-1', activeResumeVersionId: 'rv-1',
    activeJobMatchProfileVersionId: 'jmp-1', activeCapabilityBaselineVersionId: 'cap-1',
    activeMarketPositionVersionId: 'mkt-1', activeStrategyVersionId: 'str-1',
    ruleVersion: 'rule:v1', promptVersion: 'prompt:v1', analysisPolicyVersion: 'policy:v1',
    modelPolicyInvalidated: false,
    ...overrides,
  };
}

describe('deriveAnalysisValidity', () => {
  it('is current when every frozen version matches the active version', () => {
    expect(deriveAnalysisValidity(record(), current())).toEqual({ state: 'current', reasons: [] });
  });

  const cases: Array<[string, Partial<CurrentAnalysisVersions>, AnalysisStaleReason]> = [
    ['candidate active version', { candidateActiveVersionId: 'cv-2' }, 'candidate_version_changed'],
    ['resume version', { activeResumeVersionId: 'rv-2' }, 'resume_version_changed'],
    ['job match profile', { activeJobMatchProfileVersionId: 'jmp-2' }, 'job_match_profile_changed'],
    ['capability baseline', { activeCapabilityBaselineVersionId: 'cap-2' }, 'capability_baseline_changed'],
    ['market position', { activeMarketPositionVersionId: 'mkt-2' }, 'market_position_changed'],
    ['strategy', { activeStrategyVersionId: 'str-2' }, 'strategy_changed'],
    ['rule version', { ruleVersion: 'rule:v2' }, 'rule_version_changed'],
    ['prompt version', { promptVersion: 'prompt:v2' }, 'prompt_version_changed'],
    ['analysis policy', { analysisPolicyVersion: 'policy:v2' }, 'analysis_policy_changed'],
    ['model policy', { modelPolicyInvalidated: true }, 'model_policy_invalidated'],
  ];
  it.each(cases)('flags stale when %s changed', (_label, patch, reason) => {
    const result = deriveAnalysisValidity(record(), current(patch));
    expect(result.state).toBe('stale');
    expect(result.reasons).toEqual([reason]);
  });

  it('flags stale when a nullable domain gains an active version (record had none)', () => {
    const result = deriveAnalysisValidity(
      record({ capabilityBaselineVersionId: null }),
      current({ activeCapabilityBaselineVersionId: 'cap-1' }),
    );
    expect(result.reasons).toEqual(['capability_baseline_changed']);
  });

  it('flags stale when a nullable domain lost its active version (record had one)', () => {
    const result = deriveAnalysisValidity(
      record({ marketPositionVersionId: 'mkt-1' }),
      current({ activeMarketPositionVersionId: null }),
    );
    expect(result.reasons).toEqual(['market_position_changed']);
  });

  it('stays current when nullable domains are absent on both sides', () => {
    const result = deriveAnalysisValidity(
      record({ capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null }),
      current({ activeCapabilityBaselineVersionId: null, activeMarketPositionVersionId: null, activeStrategyVersionId: null }),
    );
    expect(result).toEqual({ state: 'current', reasons: [] });
  });

  it('does NOT flag stale on model name change alone (only explicit model policy invalidation)', () => {
    // modelName 差异不参与比较；对照面无 modelName 字段，Model Policy 未失效 → current。
    const result = deriveAnalysisValidity(
      record({ modelName: 'deepseek-chat' }),
      current({ modelPolicyInvalidated: false }),
    );
    expect(result).toEqual({ state: 'current', reasons: [] });
  });

  it('accumulates multiple reasons in the fixed §11.2 order', () => {
    const result = deriveAnalysisValidity(
      record(),
      current({ activeResumeVersionId: 'rv-9', ruleVersion: 'rule:v9', promptVersion: 'prompt:v9', modelPolicyInvalidated: true }),
    );
    expect(result.state).toBe('stale');
    expect(result.reasons).toEqual([
      'resume_version_changed', 'rule_version_changed', 'prompt_version_changed', 'model_policy_invalidated',
    ]);
  });
});
