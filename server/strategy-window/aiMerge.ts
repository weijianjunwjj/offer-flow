import {
  type StrategyAction,
  type StrategyProposalDraft,
  type StrategyWindow,
} from '../../src/domain/strategy-window';
import type { StrategyAiInputSnapshot, StrategyAiOutput } from './aiProvider';

const NARRATIVE_LIST_MAX = 8;

function clampArray(values: string[], max: number): string[] {
  return values.slice(0, max);
}

/**
 * 只读事实快照，供 AI 撰写文案参考——不包含任何可执行结论，只有窗口边界与待润色行动清单
 * （每条行动以 actionId 标识，AI 只能按 actionId 补充叙事，不能新增/删除/改写确定性字段）。
 */
export function buildStrategyAiFactsSnapshot(
  window: StrategyWindow,
  draft: StrategyProposalDraft,
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
    actionTargets: draft.actions.map((action) => ({
      actionId: action.id,
      actionType: action.actionType,
      title: action.title,
    })),
  };
}

/**
 * 把 AI 叙述 overlay 合并进确定性草稿：只覆盖 headline/objective/summary/uncertainties 与
 * 每条行动的 title/rationale/successSignals/failureSignals（按 actionId 精确匹配既有行动）。
 * 动作类型、范围、分配比例、sourceEvidenceIds、实验、复盘/停止/禁止行动全部保留确定性草稿原值；
 * 行动集合恒等于确定性草稿（AI 不能新增或删除行动），未被 overlay 覆盖的行动保留原始文案。
 */
export function mergeAiNarrativeIntoStrategyDraft(
  deterministicDraft: StrategyProposalDraft,
  aiOutput: StrategyAiOutput,
): StrategyProposalDraft {
  const narrativeById = new Map<string, StrategyAiOutput['actionNarratives'][number]>();
  for (const narrative of aiOutput.actionNarratives) {
    // 同一 actionId 只取第一条，避免重复 overlay 影响确定性行动集合。
    if (!narrativeById.has(narrative.actionId)) narrativeById.set(narrative.actionId, narrative);
  }

  const applyToAction = (action: StrategyAction): StrategyAction => {
    const narrative = narrativeById.get(action.id);
    if (narrative === undefined) return action;
    return {
      ...action,
      title: narrative.title,
      rationale: narrative.rationale,
      successSignals: clampArray(narrative.successSignals, NARRATIVE_LIST_MAX),
      failureSignals: clampArray(narrative.failureSignals, NARRATIVE_LIST_MAX),
      // sourceEvidenceIds 等确定性字段一律保留，AI 无权新增或修改。
    };
  };

  return {
    ...deterministicDraft,
    headline: aiOutput.headline,
    objective: aiOutput.objective,
    summary: aiOutput.summary,
    uncertainties: clampArray(aiOutput.uncertainties, NARRATIVE_LIST_MAX),
    actions: deterministicDraft.actions.map(applyToAction),
  };
}
