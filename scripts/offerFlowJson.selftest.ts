// Task 6 self-test for the OFFER_FLOW_JSON parser. Runs in Node via tsx.
// No test framework. Verifies extract + parse + score helpers, per docs/v0.2/requirements.md.

import {
  extractOfferFlowJson,
  parseOfferFlowJson,
} from '../src/app/offerFlowJson';
import {
  normalizeScore,
  calculateOpportunityScore,
  getOpportunityScoreLevel,
} from '../src/app/opportunityScore';
import type { OpportunityRadar } from '../src/storage';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const fullRadar: OpportunityRadar = {
  salaryScore: 80,
  stabilityScore: 72,
  growthScore: 86,
  matchScore: 82,
  commuteScore: 70,
  riskControlScore: 75,
};

function fullObject(): Record<string, unknown> {
  return {
    version: '0.2.0',
    matchScore: 82,
    companyAssessment: {
      sizeTier: 'medium',
      staffRange: '100-499人',
      companyType: '自研业务',
      financingStage: '未明确',
      stabilityLevel: 'medium',
      growthPotential: 'medium',
      summary: '规模中等，自研业务，稳定性尚可。',
      confidence: 'medium',
    },
    opportunityAnalysis: {
      opportunityScore: 78,
      opportunityRadar: { ...fullRadar },
      applyAdvice: 'ok',
      riskLevel: 'medium',
      decisionSummary: '可以重点沟通，但需确认稳定性。',
      interviewFocus: ['准备中后台案例', '强调 Vue3 + TS'],
      bossGreeting: '你好，我有 7 年 Vue 前端经验……',
    },
  };
}

function wrap(jsonText: string): string {
  return `这是给人看的报告。\n\n---OFFER_FLOW_JSON_START---\n${jsonText}\n---OFFER_FLOW_JSON_END---\n报告结束。`;
}

// --------------------------------------------------------------------------
section('normalizeScore / calculateOpportunityScore');

check('normalizeScore number in range', normalizeScore(82) === 82);
check('normalizeScore string with %', normalizeScore('82%') === 82);
check('normalizeScore clamps >100', normalizeScore(120) === 100);
check('normalizeScore clamps <0', normalizeScore(-5) === 0);
check('normalizeScore rounds', normalizeScore(82.6) === 83);
check('normalizeScore empty -> null', normalizeScore('') === null);
check('normalizeScore non-numeric -> null', normalizeScore('abc') === null);
check('normalizeScore null -> null', normalizeScore(null) === null);
check('normalizeScore NaN -> null', normalizeScore(NaN) === null);
check(
  'calculateOpportunityScore weighted',
  calculateOpportunityScore({
    salaryScore: 100,
    stabilityScore: 0,
    growthScore: 0,
    matchScore: 0,
    commuteScore: 0,
    riskControlScore: 0,
  }) === 20,
);
check('calculateOpportunityScore all 80 = 80', calculateOpportunityScore({
  salaryScore: 80, stabilityScore: 80, growthScore: 80, matchScore: 80, commuteScore: 80, riskControlScore: 80,
}) === 80);
check('getOpportunityScoreLevel 82 -> 优质机会', getOpportunityScoreLevel(82) === '优质机会');
check('getOpportunityScoreLevel 90 -> 高价值机会', getOpportunityScoreLevel(90) === '高价值机会');

// --------------------------------------------------------------------------
section('extractOfferFlowJson');

const stdRaw = wrap(JSON.stringify(fullObject()));
const extracted = extractOfferFlowJson(stdRaw);
check('extract returns inner json from markers', extracted !== null && extracted.includes('"version"'));

const fenceRaw = '报告……\n\n```json\n' + JSON.stringify(fullObject()) + '\n```\n结束';
const fenceExtract = extractOfferFlowJson(fenceRaw);
check('extract falls back to last ```json block', fenceExtract !== null && fenceExtract.includes('opportunityAnalysis'));

check('extract returns null when no json at all', extractOfferFlowJson('就是一段普通文字，没有 JSON。') === null);
check('extract returns null on empty', extractOfferFlowJson('') === null);

// --------------------------------------------------------------------------
section('parseOfferFlowJson — happy path');

const ok = parseOfferFlowJson(extractOfferFlowJson(stdRaw) ?? '');
check('standard parse status success', ok.status === 'success');
check('standard parse matchScore 82%', ok.matchScore === '82%');
check('standard parse companyAssessment present', ok.companyAssessment?.sizeTier === 'medium');
check('standard parse opportunityAnalysis present', ok.opportunityAnalysis?.applyAdvice === 'ok');
check('standard parse opportunityScore kept', ok.opportunityAnalysis?.opportunityScore === 78);
check('standard parse interviewFocus length', ok.opportunityAnalysis?.interviewFocus.length === 2);
check('standard parse no warnings', ok.warnings.length === 0);

// fence fallback also parses
const okFence = parseOfferFlowJson(extractOfferFlowJson(fenceRaw) ?? '');
check('fence fallback parses success', okFence.status === 'success');

// --------------------------------------------------------------------------
section('parseOfferFlowJson — not_found / invalid_json');

check('empty input -> not_found', parseOfferFlowJson('').status === 'not_found');
check(
  'no-json raw -> not_found via extract',
  parseOfferFlowJson(extractOfferFlowJson('没有 JSON 的文字') ?? '').status === 'not_found',
);
check('broken json -> invalid_json', parseOfferFlowJson('{ "a": ').status === 'invalid_json');
check('non-object json -> invalid_json', parseOfferFlowJson('123').status === 'invalid_json');
check('invalid_json does not throw / no crash', (() => {
  try {
    const r = parseOfferFlowJson('{ totally broken ]');
    return r.status === 'invalid_json';
  } catch {
    return false;
  }
})());

// --------------------------------------------------------------------------
section('parseOfferFlowJson — partial / normalization / enums');

// 缺 companyAssessment → partial
const noCa = fullObject();
delete noCa.companyAssessment;
const partialRes = parseOfferFlowJson(JSON.stringify(noCa));
check('missing companyAssessment -> partial', partialRes.status === 'partial');
check('missing companyAssessment -> null', partialRes.companyAssessment === null);
check('partial still parses opportunityAnalysis', partialRes.opportunityAnalysis !== null);

// 分数越界归一
const outRange = fullObject();
(outRange.opportunityAnalysis as any).opportunityRadar.salaryScore = 120;
(outRange.opportunityAnalysis as any).opportunityRadar.riskControlScore = -10;
const outRes = parseOfferFlowJson(JSON.stringify(outRange));
check('score >100 normalized to 100', outRes.opportunityAnalysis?.opportunityRadar.salaryScore === 100);
check('score <0 normalized to 0', outRes.opportunityAnalysis?.opportunityRadar.riskControlScore === 0);

// 枚举非法归 unknown
const badEnum = fullObject();
(badEnum.companyAssessment as any).sizeTier = 'huge';
(badEnum.opportunityAnalysis as any).riskLevel = 'extreme';
const badEnumRes = parseOfferFlowJson(JSON.stringify(badEnum));
check('illegal sizeTier -> unknown', badEnumRes.companyAssessment?.sizeTier === 'unknown');
check('illegal riskLevel -> unknown', badEnumRes.opportunityAnalysis?.riskLevel === 'unknown');
check('illegal enum -> partial', badEnumRes.status === 'partial');

// 未给 opportunityScore → 自动计算
const noScore = fullObject();
delete (noScore.opportunityAnalysis as any).opportunityScore;
const noScoreRes = parseOfferFlowJson(JSON.stringify(noScore));
check(
  'missing opportunityScore -> computed from radar',
  noScoreRes.opportunityAnalysis?.opportunityScore === calculateOpportunityScore(fullRadar),
);
check(
  'missing opportunityScore adds a warning',
  noScoreRes.warnings.some((w) => w.includes('opportunityScore')),
);
check('missing opportunityScore still success (soft)', noScoreRes.status === 'success');

// bossGreeting 为空 → 不伪造
const emptyGreeting = fullObject();
(emptyGreeting.opportunityAnalysis as any).bossGreeting = '';
const egRes = parseOfferFlowJson(JSON.stringify(emptyGreeting));
check('empty bossGreeting stays empty (no fabrication)', egRes.opportunityAnalysis?.bossGreeting === '');

// 顶层 matchScore 缺失 → 回退 radar.matchScore
const noTopMatch = fullObject();
delete noTopMatch.matchScore;
const noTopRes = parseOfferFlowJson(JSON.stringify(noTopMatch));
check('missing top matchScore falls back to radar', noTopRes.matchScore === '82%');

// --------------------------------------------------------------------------
section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
