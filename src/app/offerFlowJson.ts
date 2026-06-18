// Task 6：OFFER_FLOW_JSON 解析器（纯函数，无副作用，不接 storage / 页面）。
// 负责从外部 AI 原文中「尽力」提取并解析固定 JSON 数据块（DEC-016）。
// 硬约束：任何输入都不得抛未捕获异常；枚举非法归 unknown / 空；分数归一 0-100 整数；
// bossGreeting 为空时不伪造；返回 warnings 说明缺失 / 非法 / 归一化情况。
// 本文件不写 JobRecord、不展示雷达、不改 AI 原文保存逻辑（接入在 Task 7）。

import type {
  ApplyAdvice,
  CompanyAssessment,
  CompanySizeTier,
  GrowthPotential,
  OpportunityAnalysis,
  OpportunityRadar,
  RiskLevel,
  StabilityLevel,
} from '../storage';
import { calculateOpportunityScore, normalizeScore } from './opportunityScore';

export type OfferFlowJsonParseStatus = 'success' | 'not_found' | 'invalid_json' | 'partial';

export interface ParsedOfferFlowResult {
  status: OfferFlowJsonParseStatus;
  matchScore: string;
  companyAssessment: CompanyAssessment | null;
  opportunityAnalysis: OpportunityAnalysis | null;
  warnings: string[];
}

const START_MARKER = '---OFFER_FLOW_JSON_START---';
const END_MARKER = '---OFFER_FLOW_JSON_END---';

const SIZE_TIERS: CompanySizeTier[] = ['giant', 'large', 'medium', 'small', 'micro', 'unknown'];
const LEVELS: StabilityLevel[] = ['high', 'medium', 'low', 'unknown'];
const CONFIDENCES: CompanyAssessment['confidence'][] = ['high', 'medium', 'low'];
const APPLY_ADVICES: ApplyAdvice[] = ['strongly', 'ok', 'cautious', 'skip'];
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'unknown'];

/**
 * 从 AI 原文中提取 OFFER_FLOW_JSON 字符串。
 * 1) 优先取 START / END 标记之间的内容；
 * 2) 否则兜底取最后一个 ```json 代码块；
 * 3) 都没有 → null。
 */
export function extractOfferFlowJson(aiRawResult: string): string | null {
  if (typeof aiRawResult !== 'string' || aiRawResult.trim() === '') {
    return null;
  }

  const start = aiRawResult.indexOf(START_MARKER);
  const end = aiRawResult.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const inner = aiRawResult.slice(start + START_MARKER.length, end).trim();
    if (inner !== '') {
      return inner;
    }
  }

  // 兜底：最后一个 ```json ... ``` 代码块
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(aiRawResult)) !== null) {
    const body = match[1].trim();
    if (body !== '') {
      last = body;
    }
  }
  return last;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析提取出的 JSON 字符串。
 * - 空 / 空白输入 → not_found
 * - JSON 非法 → invalid_json
 * - 解析成功但缺字段 / 字段非法 → partial
 * - 完整且合法 → success
 * 永不抛异常。
 */
export function parseOfferFlowJson(jsonText: string): ParsedOfferFlowResult {
  const warnings: string[] = [];
  const base: ParsedOfferFlowResult = {
    status: 'not_found',
    matchScore: '',
    companyAssessment: null,
    opportunityAnalysis: null,
    warnings,
  };

  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    warnings.push('未找到 OFFER_FLOW_JSON 数据块');
    return base;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return {
      ...base,
      status: 'invalid_json',
      warnings: [`JSON 解析失败：${(error as Error).message}`],
    };
  }

  if (!isRecord(parsed)) {
    return { ...base, status: 'invalid_json', warnings: ['JSON 顶层不是对象'] };
  }

  // 用于区分 success / partial：缺字段、非法枚举、缺分数等「硬问题」会降级为 partial。
  let hardIssue = false;
  const flag = (msg: string): void => {
    hardIssue = true;
    warnings.push(msg);
  };

  // 读取并归一一个分数字段；缺失 / 非法记硬问题并按 0 处理；越界记软提示。
  const readScore = (value: unknown, label: string): number => {
    const n = normalizeScore(value);
    if (n === null) {
      flag(`${label} 缺失或非法，按 0 处理`);
      return 0;
    }
    const rawNum =
      typeof value === 'number'
        ? value
        : Number(String(value).replace(/%/g, '').trim());
    if (Number.isFinite(rawNum) && (rawNum < 0 || rawNum > 100)) {
      warnings.push(`${label}=${rawNum} 超出 0-100，已归一到 ${n}`);
    }
    return n;
  };

  // ---- companyAssessment ----
  let companyAssessment: CompanyAssessment | null = null;
  const ca = parsed.companyAssessment;
  if (!isRecord(ca)) {
    flag('缺少 companyAssessment 对象');
  } else {
    const sizeTier = ca.sizeTier;
    const stability = ca.stabilityLevel;
    const growth = ca.growthPotential;
    const confidence = ca.confidence;

    let sizeTierValue: CompanySizeTier = 'unknown';
    if (SIZE_TIERS.includes(sizeTier as CompanySizeTier)) {
      sizeTierValue = sizeTier as CompanySizeTier;
    } else if (sizeTier !== undefined) {
      flag(`companyAssessment.sizeTier 非法（${String(sizeTier)}），归为 unknown`);
    } else {
      flag('companyAssessment.sizeTier 缺失，归为 unknown');
    }

    let stabilityValue: StabilityLevel = 'unknown';
    if (LEVELS.includes(stability as StabilityLevel)) {
      stabilityValue = stability as StabilityLevel;
    } else {
      flag(`companyAssessment.stabilityLevel 缺失或非法，归为 unknown`);
    }

    let growthValue: GrowthPotential = 'unknown';
    if (LEVELS.includes(growth as GrowthPotential)) {
      growthValue = growth as GrowthPotential;
    } else {
      flag(`companyAssessment.growthPotential 缺失或非法，归为 unknown`);
    }

    let confidenceValue: CompanyAssessment['confidence'] = 'low';
    if (CONFIDENCES.includes(confidence as CompanyAssessment['confidence'])) {
      confidenceValue = confidence as CompanyAssessment['confidence'];
    } else {
      flag('companyAssessment.confidence 缺失或非法，归为 low');
    }

    companyAssessment = {
      sizeTier: sizeTierValue,
      staffRange: asString(ca.staffRange),
      companyType: asString(ca.companyType),
      financingStage: asString(ca.financingStage),
      stabilityLevel: stabilityValue,
      growthPotential: growthValue,
      summary: asString(ca.summary),
      confidence: confidenceValue,
    };
  }

  // ---- opportunityAnalysis ----
  let opportunityAnalysis: OpportunityAnalysis | null = null;
  const oa = parsed.opportunityAnalysis;
  if (!isRecord(oa)) {
    flag('缺少 opportunityAnalysis 对象');
  } else {
    const radarRaw = oa.opportunityRadar;
    let radar: OpportunityRadar;
    if (!isRecord(radarRaw)) {
      flag('缺少 opportunityRadar 对象，6 维按 0 处理');
      radar = {
        salaryScore: 0,
        stabilityScore: 0,
        growthScore: 0,
        matchScore: 0,
        commuteScore: 0,
        riskControlScore: 0,
      };
    } else {
      radar = {
        salaryScore: readScore(radarRaw.salaryScore, 'opportunityRadar.salaryScore'),
        stabilityScore: readScore(radarRaw.stabilityScore, 'opportunityRadar.stabilityScore'),
        growthScore: readScore(radarRaw.growthScore, 'opportunityRadar.growthScore'),
        matchScore: readScore(radarRaw.matchScore, 'opportunityRadar.matchScore'),
        commuteScore: readScore(radarRaw.commuteScore, 'opportunityRadar.commuteScore'),
        riskControlScore: readScore(
          radarRaw.riskControlScore,
          'opportunityRadar.riskControlScore',
        ),
      };
    }

    // opportunityScore：AI 给了就归一用；没给 / 非法则按 6 维加权计算（软提示，不算硬问题）。
    let opportunityScore = normalizeScore(oa.opportunityScore);
    if (opportunityScore === null) {
      opportunityScore = calculateOpportunityScore(radar);
      warnings.push(`AI 未提供 opportunityScore，按 6 维加权计算为 ${opportunityScore}`);
    }

    let applyAdvice: ApplyAdvice | '' = '';
    if (APPLY_ADVICES.includes(oa.applyAdvice as ApplyAdvice)) {
      applyAdvice = oa.applyAdvice as ApplyAdvice;
    } else if (oa.applyAdvice !== undefined && oa.applyAdvice !== '') {
      flag(`opportunityAnalysis.applyAdvice 非法（${String(oa.applyAdvice)}），置空`);
    } else {
      flag('opportunityAnalysis.applyAdvice 缺失，置空');
    }

    let riskLevel: RiskLevel = 'unknown';
    if (RISK_LEVELS.includes(oa.riskLevel as RiskLevel)) {
      riskLevel = oa.riskLevel as RiskLevel;
    } else {
      flag('opportunityAnalysis.riskLevel 缺失或非法，归为 unknown');
    }

    let interviewFocus: string[] = [];
    if (Array.isArray(oa.interviewFocus)) {
      interviewFocus = oa.interviewFocus
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    } else if (oa.interviewFocus !== undefined) {
      flag('opportunityAnalysis.interviewFocus 非数组，置空');
    } else {
      flag('opportunityAnalysis.interviewFocus 缺失，置空');
    }

    // bossGreeting 为空时不伪造，保持空字符串（接入层据此 no-clobber）。
    const bossGreeting = asString(oa.bossGreeting);

    opportunityAnalysis = {
      opportunityScore,
      opportunityRadar: radar,
      applyAdvice,
      riskLevel,
      decisionSummary: asString(oa.decisionSummary),
      interviewFocus,
      bossGreeting,
    };
  }

  // ---- matchScore（同步旧字段）----
  // 顶层 matchScore 优先；缺失时回退到 opportunityRadar.matchScore；都没有则空。
  let matchScore = '';
  const topMatch = normalizeScore(parsed.matchScore);
  if (topMatch !== null) {
    matchScore = `${topMatch}%`;
  } else if (opportunityAnalysis !== null) {
    matchScore = `${opportunityAnalysis.opportunityRadar.matchScore}%`;
    warnings.push('顶层 matchScore 缺失，回退使用 opportunityRadar.matchScore');
  } else {
    flag('缺少 matchScore，且无 opportunityRadar 可回退');
  }

  const bothMissing = companyAssessment === null && opportunityAnalysis === null;
  const status: OfferFlowJsonParseStatus = hardIssue || bothMissing ? 'partial' : 'success';

  return { status, matchScore, companyAssessment, opportunityAnalysis, warnings };
}
