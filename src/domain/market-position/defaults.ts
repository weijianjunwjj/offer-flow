import { computeAllDecisionGates } from './decisionGate';
import { computeEvidenceSufficiency } from './evidenceSufficiency';
import {
  DECISION_GATE_TYPES,
  MARKET_POSITION_CITY_CODES,
  type MarketPositionCityCode,
  type MarketPositionDraft,
  type MarketPositionScope,
  type MarketPositionScopeProfile,
  type MarketPositionState,
} from './types';

function emptyScopeProfile(scope: MarketPositionScope): MarketPositionScopeProfile {
  const evidenceSufficiency = computeEvidenceSufficiency(scope, {
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
  });
  return {
    scope,
    headline: '当前样本不足，暂不形成正式市场位置判断。',
    positioning: '尚待补充真实投递、回复与面试记录。',
    targetRoleFamilies: [],
    observedStrengths: [],
    observedWeaknesses: [],
    marketSignals: [],
    counterSignals: [],
    uncertainties: ['当前尚无足够证据形成正式市场位置结论'],
    evidenceSufficiency,
    decisionGates: computeAllDecisionGates(DECISION_GATE_TYPES, evidenceSufficiency),
    nextEvidenceActions: evidenceSufficiency.missingEvidence,
    borrowedEvidence: [],
  };
}

export function createEmptyMarketPositionDraft(): MarketPositionDraft {
  return {
    global: emptyScopeProfile({ scopeType: 'global', city: null, jobFamily: null }),
    cityProfiles: MARKET_POSITION_CITY_CODES.map((city: MarketPositionCityCode) =>
      emptyScopeProfile({ scopeType: 'city', city, jobFamily: null })),
    generatedFrom: {
      jobMatchProfileVersionId: null,
      capabilityBaselineVersionId: null,
      funnelCutoffAt: 0,
    },
    dataCutoffAt: 0,
  };
}

export function createEmptyMarketPositionState(): MarketPositionState {
  return {
    stateVersion: 0,
    activeVersionId: null,
    versions: [],
    proposals: [],
    commandReceipts: [],
  };
}
