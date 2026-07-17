import {
  STRATEGY_ACTION_TYPES,
  type DecisionGateType,
  type EvidenceLevel,
  type StrategyActionType,
  type StrategyDecisionGateSnapshotEntry,
  type StrategySourceVersionIds,
  type StrategyWindow,
  type StrategyWindowType,
} from './types';

export const STRATEGY_RULE_VERSION = 'strategy-window-deterministic-v1';
export const STRATEGY_WINDOW_DISCLAIMER =
  '这是 OfferFlow 的保守策略窗口，只在已验证证据范围内给出可逆行动建议，不代表任何城市、薪资或职业方向的最终结论，也不会自动执行投递、联系、降薪、迁移或放弃方向。';

const MS_PER_DAY = 86_400_000;
export const STRATEGY_REVIEW_DAYS = 14;
export const STRATEGY_EXPIRY_DAYS = 21;
export const STRATEGY_HORIZON_DAYS = 14;

/** evidenceLevel → windowType 的唯一确定性映射。 */
export function windowTypeForEvidenceLevel(evidenceLevel: EvidenceLevel): StrategyWindowType {
  if (evidenceLevel === 'insufficient') return 'evidence_collection';
  if (evidenceLevel === 'directional') return 'controlled_experiment';
  return 'limited_optimization';
}

/** 证据收集与流程卫生类动作在任何窗口都允许（只补样本，不产生结论）。 */
const ALWAYS_ALLOWED: readonly StrategyActionType[] = [
  'collect_market_evidence',
  'increase_reliable_applications',
  'complete_outcome_records',
  'portfolio_evidence_improvement',
  'interview_story_improvement',
  'follow_up_hygiene',
  'stale_process_review',
  'maintain_current_strategy',
];

/** 每种窗口新增允许的探索/实验/优化类动作（叠加在 ALWAYS_ALLOWED 之上）。 */
const WINDOW_EXTRA_ALLOWED: Record<StrategyWindowType, readonly StrategyActionType[]> = {
  evidence_collection: ['city_sample_experiment', 'role_family_experiment', 'resume_ab_test', 'channel_ab_test'],
  controlled_experiment: ['city_sample_experiment', 'role_family_experiment', 'resume_ab_test', 'channel_ab_test', 'salary_probe'],
  limited_optimization: ['city_sample_experiment', 'role_family_experiment', 'resume_ab_test', 'channel_ab_test', 'salary_probe', 'reduce_exposure'],
};

/** 仅供观察/研究、不构成可执行结论的动作。 */
const WINDOW_OBSERVE_ONLY: Record<StrategyWindowType, readonly StrategyActionType[]> = {
  evidence_collection: [],
  controlled_experiment: [],
  limited_optimization: ['relocation_feasibility_research'],
};

/** 动作类型 → 治理它的决策门（用于展示证据来源，null 表示纯证据/卫生动作）。 */
export const ACTION_TYPE_GATE: Record<StrategyActionType, DecisionGateType | null> = {
  collect_market_evidence: null,
  increase_reliable_applications: null,
  complete_outcome_records: null,
  city_sample_experiment: 'city_priority',
  role_family_experiment: 'role_positioning',
  resume_ab_test: 'resume_effectiveness',
  channel_ab_test: 'channel_effectiveness',
  salary_probe: 'salary_positioning',
  portfolio_evidence_improvement: null,
  interview_story_improvement: null,
  follow_up_hygiene: null,
  stale_process_review: null,
  relocation_feasibility_research: 'relocation_decision',
  reduce_exposure: 'abandon_direction',
  maintain_current_strategy: null,
};

export interface StrategyActionPartition {
  allowedActionTypes: StrategyActionType[];
  observeOnlyActionTypes: StrategyActionType[];
  blockedActionTypes: StrategyActionType[];
}

/**
 * 依据 windowType 确定性地把全部动作类型划分为 允许 / 仅观察 / 当前禁止 三档。
 * 高风险方向（降薪试探、搬迁研究、减少投入）随证据等级逐级解锁，永不允许直接
 * 放弃方向、直接搬迁、辞职或自动投递（这些不属于任何允许的 actionType）。
 */
export function partitionActionTypes(windowType: StrategyWindowType): StrategyActionPartition {
  const allowed = new Set<StrategyActionType>([...ALWAYS_ALLOWED, ...WINDOW_EXTRA_ALLOWED[windowType]]);
  const observeOnly = new Set<StrategyActionType>(WINDOW_OBSERVE_ONLY[windowType]);
  const allowedActionTypes = STRATEGY_ACTION_TYPES.filter((type) => allowed.has(type));
  const observeOnlyActionTypes = STRATEGY_ACTION_TYPES.filter((type) => !allowed.has(type) && observeOnly.has(type));
  const blockedActionTypes = STRATEGY_ACTION_TYPES.filter((type) => !allowed.has(type) && !observeOnly.has(type));
  return { allowedActionTypes, observeOnlyActionTypes, blockedActionTypes };
}

const REVIEW_TRIGGERS: Record<StrategyWindowType, string[]> = {
  evidence_collection: [
    '新增 5 条可靠投递流程',
    '新增 2 条已知市场结果（回复、面试或终态）',
    'G1 岗位匹配 / G2 能力基线 / G4 市场位置任一 active 版本发生变化',
    `窗口开始满 ${STRATEGY_REVIEW_DAYS} 天`,
  ],
  controlled_experiment: [
    '任一受控实验达到预设样本目标',
    '出现明确的成功或失败信号',
    'G1 / G2 / G4 任一 active 版本发生变化',
    `窗口开始满 ${STRATEGY_REVIEW_DAYS} 天`,
  ],
  limited_optimization: [
    '投入比例调整后累计新增 5 条可靠流程',
    '出现与既有结论相反的市场信号',
    'G1 / G2 / G4 任一 active 版本发生变化',
    `窗口开始满 ${STRATEGY_REVIEW_DAYS} 天`,
  ],
};

const STOP_CONDITIONS: Record<StrategyWindowType, string[]> = {
  evidence_collection: [
    '任何行动开始产生不可逆后果时立即停止',
    '出现将探索性样本当作城市或方向结论的迹象时立即停止并复盘',
  ],
  controlled_experiment: [
    '单个实验同时改动多个核心变量时立即停止',
    '实验开始产生不可逆后果或需要降薪、搬迁、放弃方向时立即停止',
  ],
  limited_optimization: [
    '优化导致可靠样本快速下降时回退到上一策略',
    '出现需要不可逆职业决定时停止并交回用户判断',
  ],
};

const REQUIRED_EVIDENCE_TARGETS: Record<StrategyWindowType, string[]> = {
  evidence_collection: [
    '补充真实投递样本与后续结果记录',
    '扩大投递公司样本，提升独立雇主数',
    '补充精确或日期级证据，降低回忆/推断占比',
  ],
  controlled_experiment: [
    '为每个受控实验积累足够样本以形成方向性判断',
    '补齐实验相关流程的市场结果记录',
  ],
  limited_optimization: [
    '持续补充已验证方向的投递与结果，维持证据充分性',
    '记录优化调整前后的市场反馈对比',
  ],
};

export interface ComputeStrategyWindowInput {
  sourceVersionIds: StrategySourceVersionIds;
  inputHash: string;
  dataCutoffAt: number;
  evidenceLevel: EvidenceLevel;
  decisionGateStatuses: StrategyDecisionGateSnapshotEntry[];
  allowedClaims: string[];
  blockedClaims: string[];
}

export interface ComputeStrategyWindowOptions {
  now?: () => number;
  createId?: () => string;
}

/**
 * 纯确定性地由冻结的输入快照生成 StrategyWindow。AI 绝不参与本步骤，
 * 也不得修改任何输出字段：窗口类型、允许/仅观察/禁止的动作、复盘触发、停止条件、
 * allowed/blockedClaims 全部锁定在这里。
 */
export function computeStrategyWindow(
  input: ComputeStrategyWindowInput,
  options: ComputeStrategyWindowOptions = {},
): StrategyWindow {
  const now = (options.now ?? Date.now)();
  const createId = options.createId ?? (() => `window-${now}`);
  const windowType = windowTypeForEvidenceLevel(input.evidenceLevel);
  const partition = partitionActionTypes(windowType);
  return {
    id: createId(),
    windowType,
    startsAt: now,
    reviewAt: now + STRATEGY_REVIEW_DAYS * MS_PER_DAY,
    expiresAt: now + STRATEGY_EXPIRY_DAYS * MS_PER_DAY,
    sourceVersionIds: input.sourceVersionIds,
    inputHash: input.inputHash,
    dataCutoffAt: input.dataCutoffAt,
    evidenceLevel: input.evidenceLevel,
    decisionGateSnapshot: input.decisionGateStatuses.map((entry) => ({ ...entry })),
    allowedActionTypes: partition.allowedActionTypes,
    observeOnlyActionTypes: partition.observeOnlyActionTypes,
    blockedActionTypes: partition.blockedActionTypes,
    requiredEvidenceTargets: [...REQUIRED_EVIDENCE_TARGETS[windowType]],
    reviewTriggers: [...REVIEW_TRIGGERS[windowType]],
    stopConditions: [...STOP_CONDITIONS[windowType]],
    allowedClaims: [...input.allowedClaims],
    blockedClaims: [...input.blockedClaims],
    createdAt: now,
    ruleVersion: STRATEGY_RULE_VERSION,
  };
}
