import {
  computeAllDecisionGates,
  computeEvidenceSufficiency,
  DECISION_GATE_TYPES,
  type EvidenceRawCounts,
  type MarketPositionCityCode,
  type MarketPositionDraft,
  type MarketPositionScope,
  type MarketPositionScopeProfile,
} from '../../src/domain/market-position';
import type { MarketPositionAiInputSnapshot, MarketPositionAiOutput, MarketPositionAiScopeFacts } from './aiProvider';
import type { MarketPositionInputSnapshotResult } from './inputSnapshot';

const NO_DATA_HEADLINE = '当前没有该城市的正式市场反馈，不能判断该城市是否适合你。';

function scopeFacts(scope: MarketPositionScope, scopeLabel: string, counts: EvidenceRawCounts): MarketPositionAiScopeFacts {
  const sufficiency = computeEvidenceSufficiency(scope, counts);
  return {
    scopeLabel,
    city: scope.city,
    evidenceLevel: sufficiency.evidenceLevel,
    allowedClaims: sufficiency.allowedClaims,
    blockedClaims: sufficiency.blockedClaims,
    applicationCount: counts.applicationCount,
    companyCount: counts.companyCount,
    validReplyCount: counts.validReplyCount,
    interviewCount: counts.interviewCount,
    terminalOutcomeCount: counts.terminalOutcomeCount,
    hasAnyEvidence: counts.applicationCount > 0,
  };
}

/**
 * 只读事实快照，供 AI 撰写文案参考——不包含任何叙述文本，只有确定性统计口径与允许/禁止声明。
 */
export function buildMarketPositionAiFactsSnapshot(
  snapshot: MarketPositionInputSnapshotResult,
): MarketPositionAiInputSnapshot {
  const global = scopeFacts(
    { scopeType: 'global', city: null, jobFamily: null }, 'global', snapshot.countsByScope.global,
  );
  const cityProfiles = (Object.keys(snapshot.countsByScope.cities) as MarketPositionCityCode[]).map((city) => (
    scopeFacts({ scopeType: 'city', city, jobFamily: null }, city, snapshot.countsByScope.cities[city])
  ));
  return { acceptedEvidenceIds: snapshot.acceptedEvidenceIds, global, cityProfiles };
}

/**
 * 由确定性统计口径生成草稿骨架：EvidenceSufficiency、DecisionGate、计数、
 * allowedClaims/blockedClaims 全部来自纯函数计算，AI 绝不参与这一步。
 * 叙述字段先填充保守占位文案，等待后续与 AI 输出合并（合并前的骨架必须本身就是合法草稿）。
 */
export function buildDeterministicMarketPositionDraft(
  snapshot: MarketPositionInputSnapshotResult,
  generatedFrom: MarketPositionDraft['generatedFrom'],
  dataCutoffAt: number,
): MarketPositionDraft {
  const scopeProfile = (scope: MarketPositionScope, counts: EvidenceRawCounts): MarketPositionScopeProfile => {
    const evidenceSufficiency = computeEvidenceSufficiency(scope, counts);
    return {
      scope,
      headline: '证据不足，尚待验证。',
      positioning: '证据不足，尚待验证。',
      targetRoleFamilies: [],
      observedStrengths: [],
      observedWeaknesses: [],
      marketSignals: [],
      counterSignals: [],
      uncertainties: [],
      evidenceSufficiency,
      decisionGates: computeAllDecisionGates(DECISION_GATE_TYPES, evidenceSufficiency),
      nextEvidenceActions: evidenceSufficiency.missingEvidence,
      borrowedEvidence: [],
    };
  };
  const cityCodes = Object.keys(snapshot.countsByScope.cities) as MarketPositionCityCode[];
  return {
    global: scopeProfile({ scopeType: 'global', city: null, jobFamily: null }, snapshot.countsByScope.global),
    cityProfiles: cityCodes.map((city) => (
      scopeProfile({ scopeType: 'city', city, jobFamily: null }, snapshot.countsByScope.cities[city])
    )),
    generatedFrom,
    dataCutoffAt,
  };
}

function clampArray(values: string[], max: number): string[] {
  return values.slice(0, max);
}

/**
 * 把 AI 叙述文案合并进确定性草稿：只覆盖叙述字段（headline/positioning/
 * observedStrengths/observedWeaknesses/marketSignals/counterSignals/uncertainties/
 * nextEvidenceActions），EvidenceSufficiency、DecisionGate、计数、城市范围、
 * targetRoleFamilies、borrowedEvidence 全部保留确定性草稿中的原值，
 * 无论 AI 输出中是否携带这些字段的值都一律忽略。
 * 没有正式市场数据的城市，无论 AI 返回什么内容都强制改写为固定的"无数据"表述。
 */
export function mergeAiNarrativeIntoDraft(
  deterministicDraft: MarketPositionDraft,
  aiOutput: MarketPositionAiOutput,
): MarketPositionDraft {
  const applyNarrative = (
    profile: MarketPositionScopeProfile,
    narrative: MarketPositionAiOutput['global'],
  ): MarketPositionScopeProfile => {
    const hasAnyEvidence = profile.evidenceSufficiency.applicationCount > 0;
    if (!hasAnyEvidence) {
      return {
        ...profile,
        headline: NO_DATA_HEADLINE,
        positioning: NO_DATA_HEADLINE,
        observedStrengths: [],
        observedWeaknesses: [],
        marketSignals: [],
        counterSignals: [],
        uncertainties: [],
        nextEvidenceActions: profile.nextEvidenceActions,
      };
    }
    return {
      ...profile,
      headline: narrative.headline,
      positioning: narrative.positioning,
      observedStrengths: clampArray(narrative.observedStrengths, 6),
      observedWeaknesses: clampArray(narrative.observedWeaknesses, 6),
      marketSignals: clampArray(narrative.marketSignals, 6),
      counterSignals: clampArray(narrative.counterSignals, 6),
      uncertainties: clampArray(narrative.uncertainties, 6),
      nextEvidenceActions: clampArray(narrative.nextEvidenceActions, 6),
    };
  };

  const cityNarrativeByCity = new Map(aiOutput.cityProfiles.map((entry) => [entry.city, entry]));

  return {
    ...deterministicDraft,
    global: applyNarrative(deterministicDraft.global, aiOutput.global),
    cityProfiles: deterministicDraft.cityProfiles.map((profile) => {
      const city = profile.scope.city;
      const narrative = city === null ? undefined : cityNarrativeByCity.get(city);
      if (narrative === undefined) return profile;
      return applyNarrative(profile, narrative);
    }),
  };
}
