import type { StrategyProposalDraft, StrategyState } from './types';
import { STRATEGY_HORIZON_DAYS } from './strategyWindow';

export function createEmptyStrategyState(): StrategyState {
  return {
    stateVersion: 0,
    activeVersionId: null,
    versions: [],
    proposals: [],
    commandReceipts: [],
  };
}

/** 仅用于手工编辑器初始种子的空草稿骨架（不含窗口相关约束）。 */
export function createEmptyStrategyDraft(): StrategyProposalDraft {
  return {
    headline: '待填写的策略提案',
    objective: '',
    summary: '',
    horizonDays: STRATEGY_HORIZON_DAYS,
    allocationPlans: [],
    actions: [],
    experiments: [],
    evidenceTargets: [],
    reviewTriggers: [],
    stopConditions: [],
    reversibleActions: [],
    prohibitedActions: [],
    uncertainties: [],
  };
}
