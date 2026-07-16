import {
  STRATEGY_CITY_CODES,
  type StrategyAction,
  type StrategyActionType,
  type StrategyAllocationPlan,
  type StrategyExperiment,
  type StrategyProposalDraft,
  type StrategyWindow,
} from './types';
import { JOB_FAMILIES } from '../funnel/jobFamily';
import { ACTION_TYPE_GATE, STRATEGY_HORIZON_DAYS } from './strategyWindow';

const ACTION_TITLES: Record<StrategyActionType, string> = {
  collect_market_evidence: '补充真实市场证据',
  increase_reliable_applications: '增加可靠投递样本',
  complete_outcome_records: '补齐投递结果记录',
  city_sample_experiment: '开展城市样本试探',
  role_family_experiment: '开展岗位族小规模实验',
  resume_ab_test: '进行简历版本 A/B 实验',
  channel_ab_test: '进行投递渠道 A/B 实验',
  salary_probe: '进行薪资区间试探',
  portfolio_evidence_improvement: '完善项目与作品证据',
  interview_story_improvement: '打磨面试表达与项目叙事',
  follow_up_hygiene: '整理跟进与沟通卫生',
  stale_process_review: '复盘长期无进展流程',
  relocation_feasibility_research: '研究搬迁可行性（仅调研）',
  reduce_exposure: '有限减少低效样本投入',
  maintain_current_strategy: '维持当前策略并持续观察',
};

const ACTION_TARGET_COUNTS: Partial<Record<StrategyActionType, number>> = {
  increase_reliable_applications: 5,
  complete_outcome_records: 2,
  collect_market_evidence: 3,
};

const HIGH_IMPACT_PROHIBITIONS = [
  '不得直接降薪或给出降薪结论',
  '不得放弃任何城市或职业方向',
  '不得直接搬迁或辞职',
  '不得自动投递、联系或跟进招聘方',
  '不得预测 Offer 概率或成功率',
];

const WINDOW_NARRATIVE: Record<StrategyWindow['windowType'], { headline: string; objective: string; summary: string }> = {
  evidence_collection: {
    headline: '证据收集窗口：先把真实样本补足',
    objective: '在不做任何不可逆决定的前提下，补充真实投递与市场结果样本，降低回忆/推断占比。',
    summary: '当前证据不足以支持城市、薪资或职业方向的结论，本阶段只做可逆的证据收集与小规模探索性测试。',
  },
  controlled_experiment: {
    headline: '受控实验窗口：用单变量实验找方向',
    objective: '在证据出现方向性信号后，用单变量、可逆的受控实验验证简历、渠道、城市样本与薪资区间。',
    summary: '证据呈现方向性但仍有限，本阶段只做单变量受控实验，不做放弃方向、迁移或大幅降薪等不可逆决定。',
  },
  limited_optimization: {
    headline: '有限优化窗口：在门禁范围内优化投入',
    objective: '在证据较充分后，于决策门允许范围内有限优化城市、岗位族、渠道与简历投入比例。',
    summary: '证据已较充分，本阶段可在门禁范围内做有限、可撤销的投入优化，仍不自动替用户做不可逆决定。',
  },
};

function buildAction(
  actionType: StrategyActionType,
  window: StrategyWindow,
  createId: () => string,
): StrategyAction {
  return {
    id: createId(),
    actionType,
    title: ACTION_TITLES[actionType],
    rationale: '当前证据范围内的可逆行动，等待人工审核后执行。',
    scope: 'global',
    city: null,
    jobFamily: null,
    priority: 'medium',
    targetCount: ACTION_TARGET_COUNTS[actionType] ?? 0,
    allocationShare: 0,
    startAt: window.startsAt,
    reviewAt: window.reviewAt,
    successSignals: ['该行动积累到预期样本或出现可复核的正向信号'],
    failureSignals: ['样本长期无进展或出现与预期相反的信号'],
    stopConditions: window.stopConditions.slice(0, 2),
    evidenceTargets: window.requiredEvidenceTargets.slice(0, 3),
    reversible: true,
    expectedCost: 'low',
    prohibitedInterpretations: ['不得据此得出城市、薪资或方向的最终结论'],
    sourceDecisionGate: ACTION_TYPE_GATE[actionType],
    sourceEvidenceIds: [],
  };
}

function buildExperiments(window: StrategyWindow, createId: () => string): StrategyExperiment[] {
  const experiments: StrategyExperiment[] = [];
  if (window.allowedActionTypes.includes('resume_ab_test')) {
    experiments.push({
      id: createId(),
      actionType: 'resume_ab_test',
      title: '简历版本 A/B 实验',
      variable: '简历版本',
      variantA: '当前主用简历版本',
      variantB: '调整后的简历版本',
      sampleTarget: 10,
      observationMetric: '两个版本各自的后续有效回复数',
      endCondition: '任一版本达到样本目标或窗口到期',
      reversible: true,
    });
  }
  if (window.allowedActionTypes.includes('channel_ab_test')) {
    experiments.push({
      id: createId(),
      actionType: 'channel_ab_test',
      title: '投递渠道 A/B 实验',
      variable: '投递渠道',
      variantA: '渠道 A',
      variantB: '渠道 B',
      sampleTarget: 10,
      observationMetric: '两个渠道各自的后续有效回复数',
      endCondition: '任一渠道达到样本目标或窗口到期',
      reversible: true,
    });
  }
  return experiments;
}

function buildAllocationPlans(window: StrategyWindow): StrategyAllocationPlan[] {
  const exploratory = window.evidenceLevel !== 'supported';
  const cityShare = Math.round((100 / STRATEGY_CITY_CODES.length) * 100) / 100;
  const cityEntries = STRATEGY_CITY_CODES.map((city, index) => ({
    key: city,
    label: city,
    // 保证总和恰好为 100：最后一项吸收四舍五入误差。
    share: index === STRATEGY_CITY_CODES.length - 1
      ? Math.round((100 - cityShare * (STRATEGY_CITY_CODES.length - 1)) * 100) / 100
      : cityShare,
    exploratory,
  }));
  const familyShare = Math.round((100 / JOB_FAMILIES.length) * 100) / 100;
  const familyEntries = JOB_FAMILIES.map((family, index) => ({
    key: family,
    label: family,
    share: index === JOB_FAMILIES.length - 1
      ? Math.round((100 - familyShare * (JOB_FAMILIES.length - 1)) * 100) / 100
      : familyShare,
    exploratory,
  }));
  return [
    {
      dimension: 'city',
      title: '城市样本分配',
      note: exploratory ? '证据不足，仅为探索性均衡样本，不代表城市优先级结论' : '在门禁范围内的有限城市投入比例',
      entries: cityEntries,
    },
    {
      dimension: 'job_family',
      title: '岗位族样本分配',
      note: exploratory ? '证据不足，仅为探索性均衡样本，不代表岗位族优先级结论' : '在门禁范围内的有限岗位族投入比例',
      entries: familyEntries,
    },
  ];
}

/**
 * 由确定性 StrategyWindow 生成基础策略草稿骨架：动作、实验、分配计划、复盘/停止条件、
 * 禁止行动全部来自窗口规则，叙述字段先填保守占位文案，等待与 AI 叙事合并。
 * 合并前后本身都必须是通过门禁校验的合法草稿。
 */
export function buildDeterministicStrategyDraft(
  window: StrategyWindow,
  options: { createId?: () => string } = {},
): StrategyProposalDraft {
  const createId = options.createId ?? (() => `sa-${Math.random().toString(36).slice(2)}`);
  const actionTypes = [...window.allowedActionTypes, ...window.observeOnlyActionTypes];
  const narrative = WINDOW_NARRATIVE[window.windowType];
  return {
    headline: narrative.headline,
    objective: narrative.objective,
    summary: narrative.summary,
    horizonDays: STRATEGY_HORIZON_DAYS,
    allocationPlans: buildAllocationPlans(window),
    actions: actionTypes.map((actionType) => buildAction(actionType, window, createId)),
    experiments: buildExperiments(window, createId),
    evidenceTargets: [...window.requiredEvidenceTargets],
    reviewTriggers: [...window.reviewTriggers],
    stopConditions: [...window.stopConditions],
    reversibleActions: ['本策略窗口内的全部行动均设计为可逆，可随时回退'],
    prohibitedActions: [...HIGH_IMPACT_PROHIBITIONS],
    uncertainties: ['当前判断均为阶段性，可能随新增真实证据变化'],
  };
}
