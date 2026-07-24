/**
 * 规则覆盖态投影（纯函数，单一权威算法）。
 *
 * 用户覆盖是 append-only 的 RadarAction 事件（rule_override_set / rule_override_reverted，
 * 见 ruleEvidenceService）：绝不物理改写旧事件。本模块把某候选下的事件序列，
 * 投影为「每条规则评估当前生效的覆盖态」。
 *
 * 存在两个消费方——V8-3 人工工作台（reviewService）与 V8-4 分析输入快照（inputSnapshot）——
 * 故把判定逻辑收敛到这里，避免两处出现可能不一致的实现。
 */
import type { RadarAction } from '../../src/domain/radar';

export type RuleOverrideState = 'none' | 'pass' | 'block';

function overriddenValue(action: RadarAction): RuleOverrideState | null {
  const value = (action.metadata as { overriddenValue?: unknown }).overriddenValue;
  return value === 'pass' || value === 'block' ? value : null;
}

function ruleAssessmentIdOf(action: RadarAction): string | null {
  const id = (action.metadata as { ruleAssessmentId?: unknown }).ruleAssessmentId;
  return typeof id === 'string' ? id : null;
}

/**
 * 某评估当前生效的覆盖态。
 * 取该候选下最近一条针对该 assessment 的 rule_override_set；若不存在或已被撤销 → 'none'。
 * 入参 actions 需按 occurredAt DESC（与 RadarActionRepository.listByCandidate 一致）。
 */
export function currentOverrideState(
  actionsDesc: readonly RadarAction[],
  assessmentId: string,
): RuleOverrideState {
  for (const action of actionsDesc) {
    if (action.actionType !== 'rule_override_set') continue;
    if (ruleAssessmentIdOf(action) !== assessmentId) continue;
    if (action.revertedByActionId !== null) return 'none';
    return overriddenValue(action) ?? 'none';
  }
  return 'none';
}

/** 覆盖态 → 快照投影枚举（none 表示无生效覆盖，调用方据此决定是否产出投影条目）。 */
export function overrideStateToProjection(
  state: RuleOverrideState,
): 'overridden_pass' | 'overridden_block' | null {
  if (state === 'pass') return 'overridden_pass';
  if (state === 'block') return 'overridden_block';
  return null;
}
