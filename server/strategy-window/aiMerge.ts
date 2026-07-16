import {
  type StrategyAction,
  type StrategyProposalDraft,
  type StrategyWindow,
} from '../../src/domain/strategy-window';
import type { StrategyAiInputSnapshot, StrategyAiOutput } from './aiProvider';

function clampArray(values: string[], max: number): string[] {
  return values.slice(0, max);
}

function actionKey(actionType: string, city: string | null): string {
  return `${actionType}:${city ?? ''}`;
}

/**
 * 只读事实快照，供 AI 撰写文案参考——不包含任何可执行结论，只有窗口边界与待润色行动清单。
 */
export function buildStrategyAiFactsSnapshot(
  window: StrategyWindow,
  draft: StrategyProposalDraft,
  acceptedEvidenceIds: readonly string[],
): StrategyAiInputSnapshot {
  return {
    windowType: window.windowType,
    evidenceLevel: window.evidenceLevel,
    allowedActionTypes: window.allowedActionTypes,
    observeOnlyActionTypes: window.observeOnlyActionTypes,
    blockedActionTypes: window.blockedActionTypes,
    allowedClaims: window.allowedClaims,
    blockedClaims: window.blockedClaims,
    reviewTriggers: window.reviewTriggers,
    stopConditions: window.stopConditions,
    actions: draft.actions.map((action) => ({
      actionType: action.actionType,
      city: action.city,
      title: action.title,
    })),
    acceptedEvidenceIds: [...acceptedEvidenceIds],
  };
}

/**
 * 把 AI 叙述合并进确定性草稿：只覆盖 headline/objective/summary/uncertainties 与每条行动的
 * title/rationale/successSignals/failureSignals（按 actionType + city 顺序匹配）。
 * 动作类型、范围、分配比例、证据引用、实验、复盘/停止/禁止行动全部保留确定性草稿原值，
 * 无论 AI 输出是否携带这些字段一律忽略——AI 无法通过文案绕过门禁。
 */
export function mergeAiNarrativeIntoStrategyDraft(
  deterministicDraft: StrategyProposalDraft,
  aiOutput: StrategyAiOutput,
): StrategyProposalDraft {
  const narrativeQueues = new Map<string, StrategyAiOutput['actions']>();
  for (const narrative of aiOutput.actions) {
    const key = actionKey(narrative.actionType, narrative.city);
    const queue = narrativeQueues.get(key) ?? [];
    queue.push(narrative);
    narrativeQueues.set(key, queue);
  }

  const applyToAction = (action: StrategyAction): StrategyAction => {
    const key = actionKey(action.actionType, action.city);
    const queue = narrativeQueues.get(key);
    const narrative = queue?.shift();
    if (narrative === undefined) return action;
    return {
      ...action,
      title: narrative.title,
      rationale: narrative.rationale,
      successSignals: clampArray(narrative.successSignals, 8),
      failureSignals: clampArray(narrative.failureSignals, 8),
    };
  };

  return {
    ...deterministicDraft,
    headline: aiOutput.headline,
    objective: aiOutput.objective,
    summary: aiOutput.summary,
    uncertainties: clampArray(aiOutput.uncertainties, 8),
    actions: deterministicDraft.actions.map(applyToAction),
  };
}
