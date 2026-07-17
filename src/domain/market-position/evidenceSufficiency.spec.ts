import { describe, expect, it } from 'vitest';
import { EVIDENCE_SUFFICIENCY_DISCLAIMER, computeEvidenceSufficiency } from './evidenceSufficiency';
import type { EvidenceRawCounts, MarketPositionScope } from './types';

const globalScope: MarketPositionScope = { scopeType: 'global', city: null, jobFamily: null };

const zeroCounts: EvidenceRawCounts = {
  applicationCount: 0,
  companyCount: 0,
  validReplyCount: 0,
  interviewCount: 0,
  terminalOutcomeCount: 0,
  exactCount: 0,
  dateLevelCount: 0,
  approximateCount: 0,
  recalledCount: 0,
  inferredCount: 0,
  firstObservedAt: null,
  lastObservedAt: null,
};

describe('EvidenceSufficiency · 保守阈值', () => {
  it('9 条投递 / 0 回复的真实场景判定为 insufficient', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, {
      ...zeroCounts,
      applicationCount: 9,
      companyCount: 9,
      exactCount: 6,
      dateLevelCount: 3,
      firstObservedAt: Date.parse('2026-06-01T00:00:00Z'),
      lastObservedAt: Date.parse('2026-07-10T00:00:00Z'),
    });
    expect(sufficiency.evidenceLevel).toBe('insufficient');
    expect(sufficiency.missingEvidence.length).toBeGreaterThan(0);
    expect(sufficiency.blockedClaims).toContain('market_conclusion');
    expect(sufficiency.blockedClaims).toContain('success_rate_prediction');
    expect(sufficiency.allowedClaims).not.toContain('quantified_market_signal');
  });

  it('零样本判定为 insufficient 且不产生除以零错误', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, zeroCounts);
    expect(sufficiency.evidenceLevel).toBe('insufficient');
    expect(sufficiency.recalledOrInferredShare).toBeNull();
    expect(sufficiency.observationSpanDays).toBeNull();
  });

  it('恰好达到 directional 阈值时判定为 directional', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, {
      applicationCount: 15,
      companyCount: 8,
      validReplyCount: 2,
      interviewCount: 1,
      terminalOutcomeCount: 0,
      exactCount: 8,
      dateLevelCount: 2,
      approximateCount: 0,
      recalledCount: 0,
      inferredCount: 0,
      firstObservedAt: Date.parse('2026-01-01T00:00:00Z'),
      lastObservedAt: Date.parse('2026-01-15T00:00:00Z'),
    });
    expect(sufficiency.evidenceLevel).toBe('directional');
    expect(sufficiency.allowedClaims).toContain('directional_signal_mention');
    expect(sufficiency.allowedClaims).not.toContain('quantified_market_signal');
  });

  it('未达到 directional 观察窗口天数时仍判定为 insufficient', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, {
      applicationCount: 15,
      companyCount: 8,
      validReplyCount: 2,
      interviewCount: 1,
      terminalOutcomeCount: 0,
      exactCount: 10,
      dateLevelCount: 0,
      approximateCount: 0,
      recalledCount: 0,
      inferredCount: 0,
      firstObservedAt: Date.parse('2026-01-01T00:00:00Z'),
      lastObservedAt: Date.parse('2026-01-05T00:00:00Z'),
    });
    expect(sufficiency.evidenceLevel).toBe('insufficient');
    expect(sufficiency.failedGates).toContain('directional_observation_span_days');
  });

  it('回忆/推断占比过高时即使计数达标也不超过 directional', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, {
      applicationCount: 50,
      companyCount: 25,
      validReplyCount: 15,
      interviewCount: 10,
      terminalOutcomeCount: 5,
      exactCount: 15,
      dateLevelCount: 10,
      approximateCount: 5,
      recalledCount: 15,
      inferredCount: 5,
      firstObservedAt: Date.parse('2025-01-01T00:00:00Z'),
      lastObservedAt: Date.parse('2026-06-01T00:00:00Z'),
    });
    expect(sufficiency.evidenceLevel).toBe('directional');
    expect(sufficiency.failedGates).toContain('supported_recalled_or_inferred_share');
  });

  it('达到 supported 全部阈值时判定为 supported', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, {
      applicationCount: 40,
      companyCount: 20,
      validReplyCount: 15,
      interviewCount: 8,
      terminalOutcomeCount: 5,
      exactCount: 25,
      dateLevelCount: 10,
      approximateCount: 0,
      recalledCount: 3,
      inferredCount: 2,
      firstObservedAt: Date.parse('2025-01-01T00:00:00Z'),
      lastObservedAt: Date.parse('2026-06-01T00:00:00Z'),
    });
    expect(sufficiency.evidenceLevel).toBe('supported');
    expect(sufficiency.missingEvidence).toHaveLength(0);
    expect(sufficiency.allowedClaims).toContain('quantified_market_signal');
    expect(sufficiency.blockedClaims).toContain('market_conclusion');
  });

  it('禁止词汇/结论类型在任何证据等级下都被禁止', () => {
    for (const counts of [
      zeroCounts,
      { ...zeroCounts, applicationCount: 15, companyCount: 8, exactCount: 10, firstObservedAt: 0, lastObservedAt: 14 * 86400000 },
    ]) {
      const sufficiency = computeEvidenceSufficiency(globalScope, counts);
      expect(sufficiency.blockedClaims).toContain('city_unsuitability_declaration');
      expect(sufficiency.blockedClaims).toContain('offer_probability_claim');
      expect(sufficiency.blockedClaims).toContain('direction_failure_declaration');
      expect(sufficiency.blockedClaims).toContain('general_competitiveness_verdict');
    }
  });

  it('免责声明文案与规范原文一致', () => {
    expect(EVIDENCE_SUFFICIENCY_DISCLAIMER).toBe(
      '这是 OfferFlow 的保守决策门槛，用于防止根据少量投递记录过早改变薪资、城市或职业方向，不代表通用招聘统计标准。',
    );
  });
});
