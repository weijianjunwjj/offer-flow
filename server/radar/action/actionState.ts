/**
 * RC-10 雷达动作状态投影（纯函数，单一权威算法）。
 *
 * 用户处理动作是 append-only 的 RadarAction 事件（TD §4.11）：撤销记录新的 *_reverted /
 * unsaved 事件，并回填旧事件的 reverted_by_action_id，绝不物理删除或改写旧事件。
 * 本模块把某候选下的事件序列，投影为「四个动作族当前是否生效」。
 *
 * 判定只依据 reverted_by_action_id 是否为 null（未回填 = 生效中）。这里给出的是候选级原始
 * 生效态；推荐层的 stale / 版本感知抑制（deriveHandledState 的 ignoredUnchanged）在其消费层
 * 另行判定，本层不掺入版本比较，保持「动作是否处于该状态」这一唯一语义。
 */
import type { RadarAction, RadarActionType } from '../../../src/domain/radar';

/** 四个用户处理动作族（RC-10 owns），及其 set / revert 事件类型。 */
export const ACTION_FAMILIES = {
  save: { set: 'saved', revert: 'unsaved' },
  ignore: { set: 'ignored', revert: 'ignore_reverted' },
  priority: { set: 'marked_priority', revert: 'priority_reverted' },
  appliedPending: { set: 'marked_applied_pending', revert: 'applied_pending_reverted' },
} as const satisfies Record<string, { set: RadarActionType; revert: RadarActionType }>;

export type ActionFamily = keyof typeof ACTION_FAMILIES;

export interface RadarActionState {
  saved: boolean;
  ignored: boolean;
  priority: boolean;
  appliedPending: boolean;
}

/**
 * 某候选下某动作族当前生效的 set 事件（未被撤销）。因 apply 幂等（已生效不重复插入），
 * 任一时刻至多一条生效 set；返回它供服务层判定幂等与撤销目标。多条时取最近（occurredAt DESC）。
 */
export function activeSetAction(
  actions: readonly RadarAction[],
  family: ActionFamily,
): RadarAction | null {
  const setType = ACTION_FAMILIES[family].set;
  const active = actions
    .filter((a) => a.actionType === setType && a.revertedByActionId === null)
    .sort((a, b) => b.occurredAt - a.occurredAt || (a.id < b.id ? 1 : -1));
  return active[0] ?? null;
}

/** 从事件流派生四族当前生效态（纯读，不依赖顺序）。 */
export function deriveActionState(actions: readonly RadarAction[]): RadarActionState {
  return {
    saved: activeSetAction(actions, 'save') !== null,
    ignored: activeSetAction(actions, 'ignore') !== null,
    priority: activeSetAction(actions, 'priority') !== null,
    appliedPending: activeSetAction(actions, 'appliedPending') !== null,
  };
}
