import { computeAllDecisionGates } from './decisionGate';
import { computeEvidenceSufficiency } from './evidenceSufficiency';
import {
  DECISION_GATE_TYPES,
  MARKET_POSITION_CITY_CODES,
  type EvidenceRawCounts,
  type MarketPositionCityCode,
  type MarketPositionDraft,
  type MarketPositionScope,
  type MarketPositionScopeProfile,
} from './types';

const insufficientCounts: EvidenceRawCounts = {
  applicationCount: 9,
  companyCount: 9,
  validReplyCount: 0,
  interviewCount: 0,
  terminalOutcomeCount: 0,
  exactCount: 6,
  dateLevelCount: 3,
  approximateCount: 0,
  recalledCount: 0,
  inferredCount: 0,
  firstObservedAt: Date.parse('2026-06-01T00:00:00Z'),
  lastObservedAt: Date.parse('2026-07-10T00:00:00Z'),
};

function scopeProfileFixture(scope: MarketPositionScope, counts: EvidenceRawCounts): MarketPositionScopeProfile {
  const evidenceSufficiency = computeEvidenceSufficiency(scope, counts);
  return {
    scope,
    headline: '当前样本不足，暂不形成正式市场位置判断。',
    positioning: '已投递 9 次、覆盖 9 家公司，尚无正式回复，无法判断当前定位是否被市场接受。',
    targetRoleFamilies: ['frontend', 'ai_applications'],
    observedStrengths: [],
    observedWeaknesses: [],
    marketSignals: [],
    counterSignals: [],
    uncertainties: ['样本量不足以支持任何城市或薪资结论'],
    evidenceSufficiency,
    decisionGates: computeAllDecisionGates(DECISION_GATE_TYPES, evidenceSufficiency),
    nextEvidenceActions: evidenceSufficiency.missingEvidence,
    borrowedEvidence: [],
  };
}

/** 对应真实场景：9 条投递、零回复，用于验证 insufficient 等级与受限文案。 */
export function makeMarketPositionDraftFixture(): MarketPositionDraft {
  return {
    global: scopeProfileFixture({ scopeType: 'global', city: null, jobFamily: null }, insufficientCounts),
    cityProfiles: MARKET_POSITION_CITY_CODES.map((city: MarketPositionCityCode) =>
      scopeProfileFixture({ scopeType: 'city', city, jobFamily: null }, {
        ...insufficientCounts,
        applicationCount: city === 'suzhou' ? 9 : 0,
        companyCount: city === 'suzhou' ? 9 : 0,
        exactCount: city === 'suzhou' ? 6 : 0,
        dateLevelCount: city === 'suzhou' ? 3 : 0,
        firstObservedAt: city === 'suzhou' ? insufficientCounts.firstObservedAt : null,
        lastObservedAt: city === 'suzhou' ? insufficientCounts.lastObservedAt : null,
      })),
    generatedFrom: {
      jobMatchProfileVersionId: 'job-match-version-fixture',
      capabilityBaselineVersionId: 'capability-baseline-version-fixture',
      funnelCutoffAt: Date.parse('2026-07-10T00:00:00Z'),
    },
    dataCutoffAt: Date.parse('2026-07-10T00:00:00Z'),
  };
}
