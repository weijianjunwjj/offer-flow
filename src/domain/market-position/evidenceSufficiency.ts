import type { EvidenceLevel, EvidenceRawCounts, EvidenceSufficiency, MarketPositionScope } from './types';

/**
 * 保守决策门槛说明（必须原文展示给用户，不得改写或省略）：
 * "这是 OfferFlow 的保守决策门槛，用于防止根据少量投递记录过早改变薪资、城市或职业方向，
 * 不代表通用招聘统计标准。"
 */
export const EVIDENCE_SUFFICIENCY_DISCLAIMER =
  '这是 OfferFlow 的保守决策门槛，用于防止根据少量投递记录过早改变薪资、城市或职业方向，不代表通用招聘统计标准。';

/** 所有允许/禁止声明类型的枚举——文案生成层只能从 allowedClaims 中取用，不得使用 blockedClaims 中的类型。 */
export const CLAIM_KEYS = [
  'missing_evidence_statement',
  'fact_count_statement',
  'directional_signal_mention',
  'strength_observation',
  'weakness_observation',
  'quantified_market_signal',
] as const;
export type ClaimKey = (typeof CLAIM_KEYS)[number];

/**
 * 禁止词汇/结论类型，任何证据等级下都不允许出现（对应产品定义中"系统不能自动决策/
 * 自动降薪/放弃方向/触发搬迁"的边界，以及规范中明确列出的禁止措辞，如"市场结论"、
 * "样本充分"、"成功率预测"、"Offer 概率"、"科学证明"）。
 */
export const ALWAYS_BLOCKED_CLAIMS = [
  'success_rate_prediction',
  'market_conclusion',
  'scientific_proof_claim',
  'sample_sufficiency_claim',
  'offer_probability_claim',
  'direction_abandonment_directive',
  'relocation_directive',
  'salary_change_directive',
  'city_unsuitability_declaration',
  'city_ranking_declaration',
  'direction_failure_declaration',
  'general_competitiveness_verdict',
] as const;

interface DirectionalGateInputs {
  applicationCount: number;
  companyCount: number;
  reliableEvidenceCount: number;
  knownMarketOutcomeCount: number;
  recalledOrInferredShare: number | null;
  observationSpanDays: number | null;
}

const DIRECTIONAL_THRESHOLDS = {
  applicationCount: 15,
  companyCount: 8,
  reliableEvidenceCount: 10,
  knownMarketOutcomeCount: 3,
  maxRecalledOrInferredShare: 0.5,
  observationSpanDays: 14,
};

const SUPPORTED_THRESHOLDS = {
  applicationCount: 40,
  companyCount: 20,
  reliableEvidenceCount: 30,
  knownMarketOutcomeCount: 10,
  maxRecalledOrInferredShare: 0.3,
  observationSpanDays: 60,
};

function evaluateGates(
  inputs: DirectionalGateInputs,
  thresholds: typeof DIRECTIONAL_THRESHOLDS,
  prefix: 'directional' | 'supported',
): { passed: string[]; failed: string[] } {
  const checks: Array<[string, boolean]> = [
    [`${prefix}_application_count`, inputs.applicationCount >= thresholds.applicationCount],
    [`${prefix}_company_count`, inputs.companyCount >= thresholds.companyCount],
    [`${prefix}_reliable_evidence_count`, inputs.reliableEvidenceCount >= thresholds.reliableEvidenceCount],
    [`${prefix}_known_market_outcome_count`, inputs.knownMarketOutcomeCount >= thresholds.knownMarketOutcomeCount],
    [
      `${prefix}_recalled_or_inferred_share`,
      inputs.recalledOrInferredShare === null || inputs.recalledOrInferredShare <= thresholds.maxRecalledOrInferredShare,
    ],
    [
      `${prefix}_observation_span_days`,
      inputs.observationSpanDays !== null && inputs.observationSpanDays >= thresholds.observationSpanDays,
    ],
  ];
  const passed = checks.filter(([, ok]) => ok).map(([name]) => name);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { passed, failed };
}

function claimsForLevel(evidenceLevel: EvidenceLevel): { allowedClaims: string[]; blockedClaims: string[] } {
  const alwaysAllowed: ClaimKey[] = ['missing_evidence_statement', 'fact_count_statement'];
  const directionalAllowed: ClaimKey[] = ['directional_signal_mention', 'strength_observation', 'weakness_observation'];
  const supportedAllowed: ClaimKey[] = ['quantified_market_signal'];

  let allowed: ClaimKey[];
  if (evidenceLevel === 'insufficient') {
    allowed = alwaysAllowed;
  } else if (evidenceLevel === 'directional') {
    allowed = [...alwaysAllowed, ...directionalAllowed];
  } else {
    allowed = [...alwaysAllowed, ...directionalAllowed, ...supportedAllowed];
  }

  const blocked = [
    ...CLAIM_KEYS.filter((key) => !allowed.includes(key)),
    ...ALWAYS_BLOCKED_CLAIMS,
  ];

  return { allowedClaims: allowed, blockedClaims: blocked };
}

function missingEvidenceFor(evidenceLevel: EvidenceLevel, failed: string[]): string[] {
  if (evidenceLevel === 'supported') return [];
  const missing: string[] = [];
  if (failed.some((name) => name.includes('application_count'))) missing.push('更多真实投递记录');
  if (failed.some((name) => name.includes('company_count'))) missing.push('覆盖更多不同公司的投递');
  if (failed.some((name) => name.includes('reliable_evidence_count'))) missing.push('更多精确或日期级的可信证据');
  if (failed.some((name) => name.includes('known_market_outcome_count'))) missing.push('更多有效回复/面试/终态结果');
  if (failed.some((name) => name.includes('recalled_or_inferred_share'))) missing.push('降低回忆/推断数据占比');
  if (failed.some((name) => name.includes('observation_span_days'))) missing.push('更长的观察时间窗口');
  return missing;
}

export function computeEvidenceSufficiency(
  scope: MarketPositionScope,
  counts: EvidenceRawCounts,
): EvidenceSufficiency {
  const reliableEvidenceCount = counts.exactCount + counts.dateLevelCount + counts.approximateCount;
  const recalledOrInferredShare = counts.applicationCount === 0
    ? null
    : (counts.recalledCount + counts.inferredCount) / counts.applicationCount;
  const knownMarketOutcomeCount = counts.validReplyCount + counts.interviewCount + counts.terminalOutcomeCount;
  const observationSpanDays = counts.firstObservedAt === null || counts.lastObservedAt === null
    ? null
    : (counts.lastObservedAt - counts.firstObservedAt) / (1000 * 60 * 60 * 24);

  const gateInputs: DirectionalGateInputs = {
    applicationCount: counts.applicationCount,
    companyCount: counts.companyCount,
    reliableEvidenceCount,
    knownMarketOutcomeCount,
    recalledOrInferredShare,
    observationSpanDays,
  };

  const directionalResult = evaluateGates(gateInputs, DIRECTIONAL_THRESHOLDS, 'directional');
  const meetsDirectional = directionalResult.failed.length === 0;

  let evidenceLevel: EvidenceLevel;
  let passedGates: string[];
  let failedGates: string[];

  if (!meetsDirectional) {
    evidenceLevel = 'insufficient';
    passedGates = directionalResult.passed;
    failedGates = directionalResult.failed;
  } else {
    const supportedResult = evaluateGates(gateInputs, SUPPORTED_THRESHOLDS, 'supported');
    const meetsSupported = supportedResult.failed.length === 0;
    evidenceLevel = meetsSupported ? 'supported' : 'directional';
    passedGates = [...directionalResult.passed, ...supportedResult.passed];
    failedGates = meetsSupported ? [] : supportedResult.failed;
  }

  const missingEvidence = missingEvidenceFor(evidenceLevel, failedGates);
  const { allowedClaims, blockedClaims } = claimsForLevel(evidenceLevel);

  return {
    scopeType: scope.scopeType,
    city: scope.city,
    jobFamily: scope.jobFamily,
    applicationCount: counts.applicationCount,
    companyCount: counts.companyCount,
    validReplyCount: counts.validReplyCount,
    interviewCount: counts.interviewCount,
    terminalOutcomeCount: counts.terminalOutcomeCount,
    exactCount: counts.exactCount,
    dateLevelCount: counts.dateLevelCount,
    approximateCount: counts.approximateCount,
    recalledCount: counts.recalledCount,
    inferredCount: counts.inferredCount,
    reliableEvidenceCount,
    recalledOrInferredShare,
    firstObservedAt: counts.firstObservedAt,
    lastObservedAt: counts.lastObservedAt,
    observationSpanDays,
    evidenceLevel,
    passedGates,
    failedGates,
    missingEvidence,
    allowedClaims,
    blockedClaims,
  };
}
